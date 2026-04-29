import { query, isDatabaseConfigured } from '../database/index.js';

const FALLBACK_SIGMA = 0.3;
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 h

const REFRESH_QUERY = `
  SELECT m.market_type,
         STDDEV(sp.strength * sp.confidence) AS sigma
  FROM signal_predictions sp
  JOIN markets m ON sp.market_id = m.id
  WHERE sp.time > NOW() - INTERVAL '14 days'
  GROUP BY m.market_type
`;

/**
 * Caches σ(strength × confidence) per market_type, refreshed every 6 h.
 * Used by the concentration gate to decide whether a re-entry signal's conviction
 * has grown by ≥ k × σ vs the previous close-trigger.
 *
 * Fallback: 0.3 for unknown / sparse market_types or before first refresh.
 */
export class SignalSigmaCache {
  private sigmas = new Map<string, number>();
  private interval: NodeJS.Timeout | null = null;

  getSigma(marketType: string): number {
    return this.sigmas.get(marketType) ?? FALLBACK_SIGMA;
  }

  async refresh(): Promise<void> {
    if (!isDatabaseConfigured()) return;
    try {
      const result = await query<{ market_type: string; sigma: string | null }>(REFRESH_QUERY);
      const next = new Map<string, number>();
      for (const row of result.rows) {
        if (row.sigma === null) continue;
        const value = parseFloat(row.sigma);
        if (!Number.isFinite(value) || value <= 0) continue;
        next.set(row.market_type, value);
      }
      this.sigmas = next;
    } catch (err) {
      console.error('[SignalSigmaCache] refresh failed (keeping prior values):', err);
    }
  }

  /** Initialise: refresh once, then schedule periodic refresh. */
  async start(): Promise<void> {
    await this.refresh();
    if (this.interval) clearInterval(this.interval);
    this.interval = setInterval(() => {
      this.refresh().catch(err =>
        console.error('[SignalSigmaCache] scheduled refresh threw:', err),
      );
    }, REFRESH_INTERVAL_MS);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}

let instance: SignalSigmaCache | null = null;
export function getSignalSigmaCache(): SignalSigmaCache {
  if (!instance) instance = new SignalSigmaCache();
  return instance;
}

/** Reset the singleton — used by tests. Not for production code. */
export function __resetSignalSigmaCacheForTests(): void {
  if (instance) instance.stop();
  instance = null;
}
