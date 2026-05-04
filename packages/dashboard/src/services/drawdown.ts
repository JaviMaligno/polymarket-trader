import { query } from '../database/index.js';

export interface EquityDrawdown {
  availableCapital: number;
  currentCapital: number;
  peakEquity: number;
  totalExposure: number;
  currentEquity: number;
  /** Drawdown as a percentage 0–100 (peak-based). */
  drawdownPct: number;
}

/**
 * Read paper_account + open paper_positions and compute the canonical
 * peak-based drawdown percentage.
 *
 * Same denominator as RiskManager — using initialCapital instead inflated
 * drawdown whenever realised losses pushed equity below initial, the bug
 * class that produced the 2026-04-30 → 2026-05-03 trade deadlock (44f16d1)
 * and lurked in CircuitBreakerService until #174. peakEquity falls back to
 * initialCapital only on fresh accounts where the DB column is null/zero.
 *
 * Returns null when paper_account is empty (e.g. before bootstrap).
 */
export async function computeEquityDrawdown(initialCapital: number): Promise<EquityDrawdown | null> {
  const accountResult = await query<{
    available_capital: string;
    current_capital: string;
    peak_equity: string | null;
  }>('SELECT available_capital, current_capital, peak_equity FROM paper_account LIMIT 1');

  if (!accountResult.rows[0]) return null;

  const availableCapital = parseFloat(accountResult.rows[0].available_capital ?? '0');
  const currentCapital = parseFloat(accountResult.rows[0].current_capital);
  const peakEquity = parseFloat(accountResult.rows[0].peak_equity ?? '0') || initialCapital;

  const exposureResult = await query<{ total_exposure: string }>(
    `SELECT COALESCE(SUM(size * current_price), 0) as total_exposure
     FROM paper_positions WHERE closed_at IS NULL`
  );
  const totalExposure = parseFloat(exposureResult.rows[0]?.total_exposure ?? '0');
  const currentEquity = currentCapital + totalExposure;
  const drawdownPct = peakEquity > 0
    ? ((peakEquity - currentEquity) / peakEquity) * 100
    : 0;

  return { availableCapital, currentCapital, peakEquity, totalExposure, currentEquity, drawdownPct };
}
