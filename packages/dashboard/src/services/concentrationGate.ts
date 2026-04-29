const DEFAULT_K = 1.0;

/**
 * Resolves the σ multiplier for the concentration gate.
 * Default 1.0 (empirically the knee of the diminishing-returns curve).
 * Overridable via OPTIMIZER_CONCENTRATION_K_SIGMA.
 * Invalid values (non-numeric, ≤ 0) fall back to 1.0.
 */
export function getKSigma(): number {
  const raw = process.env.OPTIMIZER_CONCENTRATION_K_SIGMA;
  if (raw === undefined) return DEFAULT_K;
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_K;
  return parsed;
}

export interface IncomingSignal {
  direction: 'long' | 'short';
  strength: number;   // signed; magnitude is what counts
  confidence: number; // 0..1
}

export interface PrevCloseSignal {
  direction: 'long' | 'short';
  strength: number;
  confidence: number;
}

/**
 * Concentration gate: returns true (block) when a same-direction re-entry has
 * conviction not materially stronger than the prior close-trigger on the same market.
 *
 * Rule: block iff prevClose exists AND direction matches AND
 *       |new s×c| < |prev s×c| + (k × sigma).
 *
 * Backtest on 362 closed paper_positions since reset shows k=1.0 catches 126 trades
 * (10% win rate among blocked) with net save ≈ $774 / 21 days = 63% of drawdown.
 */
export function shouldBlockReopen(
  signal: IncomingSignal,
  prevClose: PrevCloseSignal | null,
  sigma: number,
  k: number,
): boolean {
  if (prevClose === null) return false;
  if (signal.direction !== prevClose.direction) return false;

  const newSxC = Math.abs(signal.strength * signal.confidence);
  const prevSxC = Math.abs(prevClose.strength * prevClose.confidence);
  const threshold = prevSxC + k * sigma;

  return newSxC < threshold;
}
