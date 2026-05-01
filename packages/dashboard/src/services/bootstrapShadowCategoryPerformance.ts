import { query } from '../database/index.js';

/**
 * Idempotent runtime creation of the category_performance_shadow table.
 *
 * init/029_category_performance_shadow.sql only fires on first volume
 * creation. Production deployments need this helper at startup so the
 * table appears without a database wipe. Mirrors the PR #163 pattern
 * for bootstrapDirectionMultiplierRows.
 */
export async function bootstrapShadowCategoryPerformanceTable(): Promise<void> {
  await query(
    `CREATE TABLE IF NOT EXISTS category_performance_shadow (
       market_type VARCHAR(20) PRIMARY KEY,
       win_rate DOUBLE PRECISION,
       avg_pnl DOUBLE PRECISION,
       sharpe_ratio DOUBLE PRECISION,
       n_trades INTEGER NOT NULL DEFAULT 0,
       prior DOUBLE PRECISION NOT NULL DEFAULT 1.0,
       haircut_applied DOUBLE PRECISION NOT NULL DEFAULT 0.33,
       updated_at TIMESTAMPTZ DEFAULT NOW()
     )`,
  );
}
