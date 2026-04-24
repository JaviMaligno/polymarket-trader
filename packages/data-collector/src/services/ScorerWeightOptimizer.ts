import { pino } from 'pino';
import { query } from '../database/connection.js';
import { MarketScorer, WEIGHTS, type ScorerWeights, type ScoreDimensions } from './MarketScorer.js';

const logger = pino({ name: 'ScorerWeightOptimizer' });

export const MIN_TRADES = 30;
const N_TRIALS = 300;
const GLOBAL_MARKET_TYPE = '__global__';

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
  const r = () => Math.random() * 0.6 + 0.05; // uniform [0.05, 0.65]
  return {
    tradeability:       r(),
    liquidity:          r(),
    volatility:         WEIGHTS.volatility,
    ttr:                r(),
    dataQuality:        WEIGHTS.dataQuality,
    typeExpectedValue:  r(),
    realizedVolatility: r(), // 5th optimizable dim
  };
}

// ── DB helpers ─────────────────────────────────────────────────────────────

async function loadClosedTrades(marketType: string | null): Promise<ClosedTrade[]> {
  const result = await query<{
    score_dimensions_at_entry: Record<string, number | null>;
    realized_pnl: string;
  }>(
    `SELECT pp.score_dimensions_at_entry, pp.realized_pnl
     FROM paper_positions pp
     LEFT JOIN markets m ON m.id = pp.market_id
     WHERE pp.closed_at IS NOT NULL
       AND pp.score_dimensions_at_entry IS NOT NULL
       AND pp.score_dimensions_at_entry ? 'typeExpectedValue'
       AND pp.score_dimensions_at_entry ? 'realizedVolatility'
       AND pp.realized_pnl IS NOT NULL
       AND ($1::text IS NULL OR m.market_type = $1)
       AND pp.closed_at >= (SELECT last_reset_at FROM paper_account ORDER BY id LIMIT 1)`,
    [marketType],
  );
  return result.rows.map((r) => {
    const d = r.score_dimensions_at_entry;
    return {
      dims: {
        tradeability:       d.tradeability       ?? 0,
        liquidity:          d.liquidity          ?? 0,
        volatility:         d.volatility         ?? null,
        ttr:                d.ttr                ?? 0,
        dataQuality:        d.dataQuality        ?? null,
        typeExpectedValue:  d.typeExpectedValue   ?? 0.5,
        realizedVolatility: d.realizedVolatility  ?? null,
      },
      pnl: parseFloat(r.realized_pnl),
    };
  });
}

async function saveWeights(
  weights: ScorerWeights,
  marketType: string,
  meta: { nTrades: number; nTrials: number; bestValue: number },
): Promise<void> {
  await query(
    `INSERT INTO scorer_weights
       (market_type, tradeability, liquidity, volatility, ttr, data_quality,
        type_expected_value, realized_volatility,
        n_trades, n_trials, best_value, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
     ON CONFLICT (market_type) DO UPDATE SET
       tradeability        = EXCLUDED.tradeability,
       liquidity           = EXCLUDED.liquidity,
       volatility          = EXCLUDED.volatility,
       ttr                 = EXCLUDED.ttr,
       data_quality        = EXCLUDED.data_quality,
       type_expected_value = EXCLUDED.type_expected_value,
       realized_volatility = EXCLUDED.realized_volatility,
       n_trades            = EXCLUDED.n_trades,
       n_trials            = EXCLUDED.n_trials,
       best_value          = EXCLUDED.best_value,
       updated_at          = NOW()`,
    [
      marketType,
      weights.tradeability, weights.liquidity, weights.volatility,
      weights.ttr, weights.dataQuality, weights.typeExpectedValue, weights.realizedVolatility,
      meta.nTrades, meta.nTrials, meta.bestValue,
    ],
  );
}

function runRandomSearch(trades: ClosedTrade[]): { weights: ScorerWeights; bestValue: number } {
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

  // Normalize the 5 optimizable dims to sum to (1 - volatility - dataQuality) = 0.75
  // so that loadWeights() doesn't log a warning on every scoring run
  const optimizableSum =
    bestWeights.tradeability + bestWeights.liquidity +
    bestWeights.ttr + bestWeights.typeExpectedValue +
    bestWeights.realizedVolatility;
  const targetSum = 1 - WEIGHTS.volatility - WEIGHTS.dataQuality; // 0.75
  if (optimizableSum > 0) {
    const scale = targetSum / optimizableSum;
    bestWeights = {
      ...bestWeights,
      tradeability:       bestWeights.tradeability       * scale,
      liquidity:          bestWeights.liquidity          * scale,
      ttr:                bestWeights.ttr                * scale,
      typeExpectedValue:  bestWeights.typeExpectedValue  * scale,
      realizedVolatility: bestWeights.realizedVolatility * scale,
    };
  }

  return { weights: bestWeights, bestValue };
}

// ── Main entry point ───────────────────────────────────────────────────────

export async function optimizeScorerWeights(): Promise<void> {
  const knownTypesRes = await query<{ market_type: string }>(
    `SELECT DISTINCT market_type FROM markets WHERE market_type IS NOT NULL`,
  );

  for (const { market_type } of knownTypesRes.rows) {
    try {
      const trades = await loadClosedTrades(market_type);
      logger.info({ marketType: market_type, n: trades.length }, 'Loaded trades for type');
      if (trades.length < MIN_TRADES) {
        logger.info(
          { marketType: market_type, n: trades.length, required: MIN_TRADES },
          'Insufficient trades — skipping type',
        );
        continue;
      }
      const { weights, bestValue } = runRandomSearch(trades);
      await saveWeights(weights, market_type, { nTrades: trades.length, nTrials: N_TRIALS, bestValue });
      logger.info({ marketType: market_type, bestValue, weights }, 'Type optimization complete');
    } catch (err) {
      logger.error({ marketType: market_type, err }, 'Type optimization failed — skipping');
    }
  }

  // Always refresh the global fallback row from pooled data
  try {
    const globalTrades = await loadClosedTrades(null);
    logger.info({ n: globalTrades.length }, 'Loaded pooled trades for global row');
    if (globalTrades.length >= MIN_TRADES) {
      const { weights, bestValue } = runRandomSearch(globalTrades);
      await saveWeights(weights, GLOBAL_MARKET_TYPE,
        { nTrades: globalTrades.length, nTrials: N_TRIALS, bestValue });
      logger.info({ bestValue, weights }, 'Global optimization complete');
    } else {
      logger.info(
        { n: globalTrades.length, required: MIN_TRADES },
        'Insufficient pooled trades — global row not refreshed',
      );
    }
  } catch (err) {
    logger.error({ err }, 'Global optimization failed');
  }
}
