import { pino } from 'pino';
import { query } from '../database/connection.js';
import { MarketScorer, WEIGHTS, type ScorerWeights, type ScoreDimensions } from './MarketScorer.js';

const logger = pino({ name: 'ScorerWeightOptimizer' });

export const MIN_TRADES = 30;
const N_TRIALS = 300;

// ── Types ──────────────────────────────────────────────────────────────────

interface ClosedTrade {
  dims: ScoreDimensions;
  pnl: number;
}

// ── Pure helpers (exported for testing) ────────────────────────────────────

export function pearsonCorrelation(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n === 0) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  const num = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
  const dx = Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0));
  const dy = Math.sqrt(ys.reduce((s, y) => s + (y - my) ** 2, 0));
  if (dx === 0 || dy === 0) return 0;
  return num / (dx * dy);
}

export function computeObjective(weights: ScorerWeights, trades: ClosedTrade[]): number {
  const scores = trades.map((t) => MarketScorer.compositeScore(t.dims, weights));
  const pnls = trades.map((t) => t.pnl);
  return pearsonCorrelation(scores, pnls);
}

// ── Random-search optimizer ────────────────────────────────────────────────

function randomWeights(): ScorerWeights {
  // Sample 3 positive floats for optimizable dims (tradeability, liquidity, ttr)
  // volatility and dataQuality stay at current defaults — not yet captured at entry
  const r = () => Math.random() * 0.6 + 0.05; // uniform [0.05, 0.65]
  return {
    tradeability:      r(),
    liquidity:         r(),
    volatility:        WEIGHTS.volatility,
    ttr:               r(),
    dataQuality:       WEIGHTS.dataQuality,
    typeExpectedValue: WEIGHTS.typeExpectedValue,
  };
}

// ── DB helpers ─────────────────────────────────────────────────────────────

async function loadClosedTrades(): Promise<ClosedTrade[]> {
  const result = await query<{
    score_dimensions_at_entry: Record<string, number | null>;
    realized_pnl: string;
  }>(
    `SELECT score_dimensions_at_entry, realized_pnl
     FROM paper_positions
     WHERE closed_at IS NOT NULL
       AND score_dimensions_at_entry IS NOT NULL
       AND realized_pnl IS NOT NULL`,
  );
  return result.rows.map((r) => {
    const d = r.score_dimensions_at_entry;
    return {
      dims: {
        tradeability:      d.tradeability      ?? 0,
        liquidity:         d.liquidity         ?? 0,
        volatility:        d.volatility        ?? null,
        ttr:               d.ttr               ?? 0,
        dataQuality:       d.dataQuality       ?? null,
        typeExpectedValue: d.typeExpectedValue  ?? 0.5,
      },
      pnl: parseFloat(r.realized_pnl),
    };
  });
}

async function saveWeights(
  weights: ScorerWeights,
  meta: { nTrades: number; nTrials: number; bestValue: number },
): Promise<void> {
  const result = await query(
    `UPDATE scorer_weights
     SET tradeability = $1, liquidity = $2, volatility = $3, ttr = $4, data_quality = $5,
         n_trades = $6, n_trials = $7, best_value = $8, updated_at = NOW()
     WHERE id = (SELECT id FROM scorer_weights ORDER BY id DESC LIMIT 1)`,
    [
      weights.tradeability, weights.liquidity, weights.volatility,
      weights.ttr, weights.dataQuality,
      meta.nTrades, meta.nTrials, meta.bestValue,
    ],
  );
  if ((result.rowCount ?? 0) === 0) {
    logger.warn('saveWeights: scorer_weights table is empty — migration not applied? Weights not saved.');
  }
}

// ── Main entry point ───────────────────────────────────────────────────────

export async function optimizeScorerWeights(): Promise<void> {
  const trades = await loadClosedTrades();
  logger.info({ n: trades.length }, 'Loaded closed trades for scorer weight optimization');

  if (trades.length < MIN_TRADES) {
    logger.info({ n: trades.length, required: MIN_TRADES }, 'Not enough trades — skipping optimization');
    return;
  }

  let bestValue = -Infinity;
  let bestWeights: ScorerWeights = { ...WEIGHTS };

  for (let i = 0; i < N_TRIALS; i++) {
    const candidate = randomWeights();
    const value = computeObjective(candidate, trades);
    if (value > bestValue) {
      bestValue = value;
      bestWeights = candidate;
    }
  }

  // Normalize the 3 optimized dims to sum to (1.0 - volatility - dataQuality)
  // so that loadWeights() doesn't log a warning on every scoring run
  const optimizableSum = bestWeights.tradeability + bestWeights.liquidity + bestWeights.ttr;
  const targetSum = 1.0 - WEIGHTS.volatility - WEIGHTS.dataQuality; // 0.70
  if (optimizableSum > 0) {
    const scale = targetSum / optimizableSum;
    bestWeights = {
      ...bestWeights,
      tradeability: bestWeights.tradeability * scale,
      liquidity:    bestWeights.liquidity    * scale,
      ttr:          bestWeights.ttr          * scale,
    };
  }

  logger.info({ bestValue, bestWeights }, 'Optimization complete');

  await saveWeights(bestWeights, { nTrades: trades.length, nTrials: N_TRIALS, bestValue });
  logger.info('Scorer weights updated in DB');
}
