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
 * Denominator is `max(stored_peak_equity, initialCapital)`. The floor at
 * initialCapital is intentional: without it, a partial reset that leaves
 * stored_peak_equity below initial (e.g. manual SQL or a reset path that
 * resets current_capital but not peak_equity, as happened around the
 * 2026-04-03 momentum removal cleanup) causes the CB to silently lose its
 * cumulative-loss protection. Concrete observed state on 2026-05-11:
 *   stored_peak = $8897, current_capital = $7873, initial = $10000
 *   pre-floor:  (8897 − 7873) / 8897 = 11.5%  (CB stays silent at 15% gate)
 *   post-floor: (10000 − 7873) / 10000 = 21.3% (CB fires)
 *
 * PR #174's original anti-deadlock concern (initialCapital-only denominator
 * trapped the system around a single threshold) is preserved: once
 * stored_peak_equity rises above initialCapital via normal HWM ratcheting,
 * the floor is irrelevant and the curve behaves exactly like before.
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
  const storedPeak = parseFloat(accountResult.rows[0].peak_equity ?? '0');
  const peakEquity = Math.max(storedPeak || 0, initialCapital);

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
