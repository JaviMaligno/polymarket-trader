/**
 * Dashboard Server Entry Point
 *
 * Starts the dashboard server independently or integrated with trading system.
 * Includes auto-initialization of markets and strategies on startup.
 */

import pino from 'pino';
import { createDashboardServer } from './api/server.js';
import { initializeDatabase, closeDatabase, healthCheck, isDatabaseConfigured, query } from './database/index.js';
import { signalWeightsRepo, tradingConfigRepo, paperPositionsRepo, priceRangeMatrixRepo } from './database/repositories.js';
import { initializeOptimizationScheduler } from './services/OptimizationScheduler.js';
import { initializeDirectionMultiplierLearningService } from './services/DirectionMultiplierLearningService.js';
import { wipeDirectionMultiplierSegments } from './services/wipeDirectionMultiplierSegments.js';
import { initializeSignalEngine } from './services/SignalEngine.js';
import { DirectionResolver } from './services/DirectionResolver.js';
import {
  sanitizeDirectionMultiplierPolicy,
  DEFAULT_DIRECTION_MULTIPLIER_POLICY,
  type DirectionMultiplierPolicy,
} from './services/DirectionMultiplierPolicy.js';
import { getPolymarketService } from './services/PolymarketService.js';
import { getTradingAutomation } from './services/TradingAutomation.js';
import { initializePositionCleanupService } from './services/PositionCleanupService.js';
import { getPositionClosingService } from './services/PositionClosingService.js';
import { initializeStopLossService } from './services/StopLossService.js';
import { initializeCircuitBreakerService } from './services/CircuitBreakerService.js';
import { getDbEventListener } from './services/DbEventListener.js';
import { loadPrivateKey } from './services/SecretManager.js';
import { RealExecutor } from './services/RealExecutor.js';
import { ExecutionRouter, setExecutionRouter } from './services/ExecutionRouter.js';
import { WalletMonitor, setWalletMonitor } from './services/WalletMonitor.js';
import { getNotificationService } from './services/NotificationService.js';
import { getSignalSigmaCache } from './services/SignalSigmaCache.js';
import { bootstrapDirectionMultiplierRows } from './services/bootstrapDirectionMultiplier.js';
import { bootstrapShadowCategoryPerformanceTable } from './services/bootstrapShadowCategoryPerformance.js';

const logger = pino({ name: 'server' });

async function initializeRealTrading(): Promise<void> {
  const config = await tradingConfigRepo.getAll();
  const walletAddress = config.wallet_address as string;

  if (!walletAddress || walletAddress === 'null') {
    logger.info('No wallet configured — real trading disabled');
    // Still create a paper-only ExecutionRouter so getExecutionRouter() works
    const paperRouter = new ExecutionRouter({
      realExecutor: { execute: async () => ({ success: false, error: 'No wallet configured' }) },
      getCachedBalance: () => 0,
      getConfig: async () => ({
        real_trading_enabled: false,
        real_trading_dry_run: false,
        min_balance_threshold: 0,
      }),
      notify: async () => {},
    });
    setExecutionRouter(paperRouter);
    return;
  }

  try {
    const secretName = process.env.GCP_SECRET_NAME || '';
    const privateKey = await loadPrivateKey(secretName);

    // Initialize viem wallet client for ClobClient (v5.8.0 expects viem WalletClient)
    const { createWalletClient, http } = await import('viem');
    const { privateKeyToAccount } = await import('viem/accounts');
    const { polygon } = await import('viem/chains');

    const viemAccount = privateKeyToAccount(privateKey as `0x${string}`);
    const walletClient = createWalletClient({
      account: viemAccount,
      chain: polygon,
      transport: http(process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com'),
    });

    // Initialize CLOB client with viem WalletClient
    const { ClobClient } = await import('@polymarket/clob-client');
    const clobClient = new ClobClient(
      process.env.CLOB_API_URL || 'https://clob.polymarket.com',
      137, // Polygon chainId
      walletClient
    );

    // Initialize ethers provider for USDC balance checks (read-only)
    const { ethers } = await import('ethers');
    const provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com');

    const dryRun = config.real_trading_dry_run === true || config.real_trading_dry_run === 'true';
    const maxSlippage = parseFloat(String(config.max_slippage ?? '0.02'));

    const realExecutor = new RealExecutor({ clobClient, maxSlippage, dryRun });
    const USDC_ADDRESS = process.env.USDC_CONTRACT_ADDRESS || '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // USDC on Polygon
    const usdcAbi = ['function balanceOf(address) view returns (uint256)'];
    const usdcContract = new ethers.Contract(USDC_ADDRESS, usdcAbi, provider);

    const minBalance = parseFloat(String(config.min_balance_threshold ?? '50'));
    const warningBalance = parseFloat(String(config.warning_balance_threshold ?? String(minBalance * 2)));

    const walletMonitor = new WalletMonitor({
      getUSDCBalance: async () => {
        const balance = await usdcContract.balanceOf(walletAddress);
        return Number(ethers.formatUnits(balance, 6)); // USDC has 6 decimals
      },
      notify: (type, payload) => getNotificationService().notify(type as any, payload),
      setRealTradingEnabled: async (enabled) => {
        await tradingConfigRepo.set('real_trading_enabled', enabled);
      },
      minBalanceThreshold: minBalance,
      warningThreshold: warningBalance,
    });

    // Initialize ExecutionRouter
    const executionRouter = new ExecutionRouter({
      realExecutor,
      getCachedBalance: () => walletMonitor.getCachedBalance(),
      getConfig: async () => {
        const cfg = await tradingConfigRepo.getAll();
        return {
          real_trading_enabled: cfg.real_trading_enabled === true || cfg.real_trading_enabled === 'true',
          real_trading_dry_run: cfg.real_trading_dry_run === true || cfg.real_trading_dry_run === 'true',
          min_balance_threshold: parseFloat(String(cfg.min_balance_threshold ?? '50')),
        };
      },
      notify: (type, payload) => getNotificationService().notify(type as any, payload),
    });

    setExecutionRouter(executionRouter);
    setWalletMonitor(walletMonitor);
    walletMonitor.start();
    logger.info({ walletAddress, dryRun }, 'Real trading services initialized');
  } catch (err) {
    logger.error({ err }, 'Failed to initialize real trading — running in paper-only mode');
    // Create paper-only router as fallback
    const paperRouter = new ExecutionRouter({
      realExecutor: { execute: async () => ({ success: false, error: 'Initialization failed' }) },
      getCachedBalance: () => 0,
      getConfig: async () => ({
        real_trading_enabled: false,
        real_trading_dry_run: false,
        min_balance_threshold: 0,
      }),
      notify: async () => {},
    });
    setExecutionRouter(paperRouter);
  }
}

async function main(): Promise<void> {
  // Parse command line arguments
  const port = parseInt(process.env.PORT ?? '3001', 10);
  const host = process.env.HOST ?? '0.0.0.0';

  // Initialize database connection
  if (isDatabaseConfigured()) {
    console.log('Initializing database connection...');
    initializeDatabase();

    const dbHealth = await healthCheck();
    if (dbHealth.connected) {
      console.log(`Database connected (latency: ${dbHealth.latency}ms)`);

      // Configure autovacuum for markets table to prevent long-running locks
      await query(`
        ALTER TABLE markets SET (
          autovacuum_vacuum_scale_factor = 0.1,
          autovacuum_analyze_scale_factor = 0.05,
          autovacuum_vacuum_cost_delay = 5
        )
      `).catch(() => {});

      // Create function to cancel autovacuum blocking queries for >30 minutes
      await query(`
        CREATE OR REPLACE FUNCTION cancel_blocking_autovacuum()
        RETURNS void AS $fn$
        DECLARE
          r RECORD;
        BEGIN
          FOR r IN
            SELECT pid FROM pg_stat_activity
            WHERE query LIKE 'autovacuum:%'
              AND state = 'active'
              AND wait_event_type = 'Lock'
              AND NOW() - query_start > INTERVAL '30 minutes'
          LOOP
            PERFORM pg_cancel_backend(r.pid);
            RAISE NOTICE 'Cancelled blocking autovacuum pid %', r.pid;
          END LOOP;
        END;
        $fn$ LANGUAGE plpgsql
      `).catch(() => {});

      // Ensure direction multiplier exploration columns exist
      await query(`
        ALTER TABLE paper_positions
          ADD COLUMN IF NOT EXISTS applied_direction_multiplier NUMERIC(5,3),
          ADD COLUMN IF NOT EXISTS was_exploration BOOLEAN NOT NULL DEFAULT false
      `);
      console.log('paper_positions direction exploration columns ensured');

      // Ensure scorer_weights supports per-type weights and typeExpectedValue dim.
      // See docs/plans/2026-04-24-scorer-per-type-weights-design.md.
      await query(`
        ALTER TABLE scorer_weights
          ADD COLUMN IF NOT EXISTS market_type VARCHAR(32) NOT NULL DEFAULT '__global__';
      `);
      await query(`
        ALTER TABLE scorer_weights
          ADD COLUMN IF NOT EXISTS type_expected_value FLOAT NOT NULL DEFAULT 0;
      `);
      await query(`
        DO $do$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'uniq_scorer_weights_market_type'
          ) THEN
            ALTER TABLE scorer_weights
              ADD CONSTRAINT uniq_scorer_weights_market_type UNIQUE (market_type);
          END IF;
        END $do$;
      `);
      console.log('scorer_weights per-type columns ensured');

      // T11: One-shot backfill: add typeExpectedValue to score_dimensions_at_entry for
      // post-reset trades. Idempotent — running twice is cheap because of the
      // outer COUNT guard.
      const missingRes = await query<{ n: string }>(`
        SELECT COUNT(*) as n FROM paper_positions pp
        WHERE pp.closed_at IS NOT NULL
          AND pp.score_dimensions_at_entry IS NOT NULL
          AND NOT (pp.score_dimensions_at_entry ? 'typeExpectedValue')
          AND pp.closed_at >= (SELECT last_reset_at FROM paper_account ORDER BY id LIMIT 1)
      `);
      const missingCount = Number(missingRes.rows[0]?.n ?? 0);
      if (missingCount > 0) {
        console.log(`Backfilling typeExpectedValue for ${missingCount} trades...`);
        await query(`
          UPDATE paper_positions pp
          SET score_dimensions_at_entry = score_dimensions_at_entry ||
            jsonb_build_object('typeExpectedValue',
              CASE
                WHEN cp.n_trades IS NULL OR cp.n_trades < 5 OR cp.sharpe_ratio IS NULL THEN 0.5
                ELSE GREATEST(0.0, LEAST(1.0,
                  ((cp.sharpe_ratio * cp.n_trades / (cp.n_trades + 20.0)) + 1.0) / 1.5
                ))
              END
            )
          FROM markets m
          LEFT JOIN category_performance cp ON cp.market_type = m.market_type
          WHERE m.id = pp.market_id
            AND pp.closed_at IS NOT NULL
            AND pp.score_dimensions_at_entry IS NOT NULL
            AND NOT (pp.score_dimensions_at_entry ? 'typeExpectedValue')
            AND pp.closed_at >= (SELECT last_reset_at FROM paper_account ORDER BY id LIMIT 1)
        `);
        console.log('typeExpectedValue backfill complete');
      } else {
        console.log('typeExpectedValue backfill not needed (all post-reset trades already have it)');
      }

      // Sub-project B.1: backfill realizedVolatility on post-reset trades.
      // Idempotent — COUNT guard so re-runs are cheap.
      const missingRvRes = await query<{ n: string }>(`
        SELECT COUNT(*) as n FROM paper_positions pp
        WHERE pp.closed_at IS NOT NULL
          AND pp.score_dimensions_at_entry IS NOT NULL
          AND NOT (pp.score_dimensions_at_entry ? 'realizedVolatility')
          AND pp.closed_at >= (SELECT last_reset_at FROM paper_account ORDER BY id LIMIT 1)
      `);
      const missingRvCount = Number(missingRvRes.rows[0]?.n ?? 0);
      if (missingRvCount > 0) {
        console.log(`Backfilling realizedVolatility for ${missingRvCount} trades...`);
        await query(`
          UPDATE paper_positions pp
          SET score_dimensions_at_entry = score_dimensions_at_entry || jsonb_build_object(
            'realizedVolatility',
            (SELECT CASE WHEN COUNT(d) < 5 THEN NULL::FLOAT
                          ELSE LEAST(1.0, GREATEST(0.0, STDDEV_POP(d) / 0.02)) END
             FROM (SELECT close - LAG(close) OVER (ORDER BY time) AS d
                   FROM price_history ph
                   WHERE ph.token_id = (SELECT clob_token_id_yes FROM markets WHERE id = pp.market_id)
                     AND ph.time BETWEEN pp.opened_at - INTERVAL '24 hours' AND pp.opened_at) diffs)
          )
          WHERE pp.closed_at IS NOT NULL
            AND pp.score_dimensions_at_entry IS NOT NULL
            AND NOT (pp.score_dimensions_at_entry ? 'realizedVolatility')
            AND pp.closed_at >= (SELECT last_reset_at FROM paper_account ORDER BY id LIMIT 1)
        `);
        console.log('realizedVolatility backfill complete');
      } else {
        console.log('realizedVolatility backfill not needed');
      }

      // T8: Ensure score_type_expected_value column exists in market_score_history.
      // Pass 2 now stores typeEV per tracked market alongside other dimension scores.
      await query(`
        ALTER TABLE market_score_history
          ADD COLUMN IF NOT EXISTS score_type_expected_value FLOAT;
      `);
      console.log('market_score_history score_type_expected_value column ensured');

      // Sub-project B.1: realized volatility columns + scoring/history columns.
      // See docs/plans/2026-04-24-realized-volatility-design.md.
      await query(`
        ALTER TABLE markets
          ADD COLUMN IF NOT EXISTS realized_volatility_24h FLOAT,
          ADD COLUMN IF NOT EXISTS realized_volatility_bar_count SMALLINT;
      `);
      await query(`
        ALTER TABLE scorer_weights
          ADD COLUMN IF NOT EXISTS realized_volatility FLOAT NOT NULL DEFAULT 0;
      `);
      await query(`
        ALTER TABLE market_score_history
          ADD COLUMN IF NOT EXISTS score_realized_volatility FLOAT;
      `);
      console.log('realized_volatility columns ensured on markets / scorer_weights / market_score_history');

      // Phase 4 (2026-05-13): edge_capacity infrastructure. Mirrors
      // init/031_edge_capacity.sql for existing volumes. See
      // docs/plans/2026-05-13-phase4-edge-aware-scorer-design.md.
      await query(`
        CREATE TABLE IF NOT EXISTS market_type_edge_capacity (
          market_type      VARCHAR(32) PRIMARY KEY,
          edge_capacity    DOUBLE PRECISION NOT NULL,
          n_cells_positive INT NOT NULL DEFAULT 0,
          n_cells_measured INT NOT NULL DEFAULT 0,
          rt_cost_pct      DOUBLE PRECISION NOT NULL,
          source           TEXT NOT NULL,
          updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await query(`
        ALTER TABLE market_score_history
          ADD COLUMN IF NOT EXISTS score_edge_capacity FLOAT;
      `);
      await query(`
        ALTER TABLE scorer_weights
          ADD COLUMN IF NOT EXISTS edge_capacity FLOAT;
      `);
      console.log('[server] edge_capacity (Phase 4) schema ensured');

      // Phase 5 Pilar 1-B (2026-05-15): generator_edge history table.
      // Append-only per-(signal, type, direction) t-stat measurements for
      // trending. Mirrors init/032_generator_edge.sql for existing volumes.
      await query(`
        CREATE TABLE IF NOT EXISTS generator_edge (
          id            BIGSERIAL,
          measured_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          signal_id     VARCHAR(50) NOT NULL,
          market_type   VARCHAR(32) NOT NULL,
          direction     VARCHAR(8) NOT NULL,
          window_days   INT NOT NULL,
          horizon_hours INT NOT NULL,
          sample_size   INT,
          n             INT NOT NULL,
          gross_pct     DOUBLE PRECISION,
          t_gross       DOUBLE PRECISION,
          rt_cost_pct   DOUBLE PRECISION NOT NULL,
          t_net         DOUBLE PRECISION,
          source        TEXT,
          PRIMARY KEY (measured_at, id)
        );
      `);
      await query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'generator_edge_direction_check'
              AND conrelid = 'generator_edge'::regclass
          ) THEN
            ALTER TABLE generator_edge
              ADD CONSTRAINT generator_edge_direction_check
              CHECK (direction IN ('long','short'));
          END IF;
        END $$;
      `);
      await query(`
        CREATE INDEX IF NOT EXISTS idx_generator_edge_cell
          ON generator_edge (signal_id, market_type, direction, measured_at DESC);
      `);
      await query(`
        CREATE INDEX IF NOT EXISTS idx_generator_edge_measured_at
          ON generator_edge (measured_at DESC);
      `);
      console.log('[server] generator_edge (Phase 5 Pilar 1-B) schema ensured');

      // Post-init hook applies signal_weights per-type migration.
      // Task 2 of per-type-optimizer plan: extends signal_weights with market_type column
      // and per-type weight bootstrap rows. Matches data-collector 025_signal_weights_per_type.sql
      // but runs as startup hook for existing VMs whose volumes already initialized.
      // See docs/plans/2026-04-28-per-type-optimizer-design.md.
      try {
        // Add market_type column
        await query(`
          ALTER TABLE signal_weights
            ADD COLUMN IF NOT EXISTS market_type VARCHAR(32) NOT NULL DEFAULT '__global__';
        `);

        // Defensive PK swap: discover existing PK name dynamically.
        // Skip if EITHER the per-type OR the per-direction (PR-A 2026-05-13) PK is
        // already installed — otherwise we'd PK-flap on every boot, and once
        // per-direction rows exist, a 2-col PK can't be created without
        // unique-constraint violations.
        await query(`
          DO $$
          DECLARE pkey_name TEXT;
          BEGIN
            IF EXISTS (
              SELECT 1 FROM pg_constraint
              WHERE conname IN ('signal_weights_pkey_per_type', 'signal_weights_pkey_per_direction')
            ) THEN
              RETURN;
            END IF;

            SELECT conname INTO pkey_name
            FROM pg_constraint
            WHERE conrelid = 'signal_weights'::regclass AND contype = 'p';

            IF pkey_name IS NOT NULL THEN
              EXECUTE format('ALTER TABLE signal_weights DROP CONSTRAINT %I', pkey_name);
            END IF;

            ALTER TABLE signal_weights
              ADD CONSTRAINT signal_weights_pkey_per_type PRIMARY KEY (signal_type, market_type);
          END $$;
        `);

        // PR-A (2026-05-13): per-direction schema migration. Must run BEFORE
        // the bootstrap INSERT below so its ON CONFLICT (sig, type, direction)
        // target has a matching unique constraint.
        // See docs/plans/2026-05-13-per-direction-weights-design.md.
        await query(`
          ALTER TABLE signal_weights
            ADD COLUMN IF NOT EXISTS direction VARCHAR(8) NOT NULL DEFAULT '__all__';
        `);
        await query(`
          DO $$
          BEGIN
            IF NOT EXISTS (
              SELECT 1 FROM pg_constraint
              WHERE conname = 'signal_weights_direction_check'
                AND conrelid = 'signal_weights'::regclass
            ) THEN
              ALTER TABLE signal_weights
                ADD CONSTRAINT signal_weights_direction_check
                CHECK (direction IN ('__all__','long','short'));
            END IF;
          END $$;
        `);
        await query(`
          DO $$
          DECLARE pkey_name TEXT;
          BEGIN
            IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'signal_weights_pkey_per_direction') THEN
              RETURN;
            END IF;

            SELECT conname INTO pkey_name
            FROM pg_constraint
            WHERE conrelid = 'signal_weights'::regclass AND contype = 'p';

            IF pkey_name IS NOT NULL THEN
              EXECUTE format('ALTER TABLE signal_weights DROP CONSTRAINT %I', pkey_name);
            END IF;

            ALTER TABLE signal_weights
              ADD CONSTRAINT signal_weights_pkey_per_direction
              PRIMARY KEY (signal_type, market_type, direction);
          END $$;
        `);
        await query(`
          CREATE INDEX IF NOT EXISTS idx_signal_weights_lookup
            ON signal_weights (signal_type, market_type, direction)
            WHERE is_enabled = true;
        `);

        // Bootstrap 55 per-type rows from current DEFAULT_TYPE_WEIGHTS hardcoded values.
        // PR-A (2026-05-13): rows are direction='__all__' (legacy/global semantics).
        // Per-direction rows ('long','short') are seeded later by PR-D's backfill
        // SQL using cost-aware t-stat priors. Until then, the combiner's fallback
        // to '__all__' makes these the active weights.
        await query(`
          INSERT INTO signal_weights (signal_type, weight, market_type, updated_at) VALUES
            -- crypto_intraday
            ('momentum',           -0.3, 'crypto_intraday', NOW()),
            ('mean_reversion',      0.5, 'crypto_intraday', NOW()),
            ('ofi',                 0.5, 'crypto_intraday', NOW()),
            ('mlofi',               0.5, 'crypto_intraday', NOW()),
            ('hawkes',              0.4, 'crypto_intraday', NOW()),
            ('volume_anomaly',      0.0, 'crypto_intraday', NOW()),
            ('spread_compression',  0.0, 'crypto_intraday', NOW()),
            ('cross_market_corr',   0.0, 'crypto_intraday', NOW()),
            ('price_divergence',    0.0, 'crypto_intraday', NOW()),
            ('attention_spike',     0.0, 'crypto_intraday', NOW()),
            ('news_sentiment',      0.0, 'crypto_intraday', NOW()),
            -- crypto_daily
            ('momentum',           -0.3, 'crypto_daily', NOW()),
            ('mean_reversion',      0.6, 'crypto_daily', NOW()),
            ('ofi',                 0.4, 'crypto_daily', NOW()),
            ('mlofi',               0.4, 'crypto_daily', NOW()),
            ('hawkes',              0.3, 'crypto_daily', NOW()),
            ('volume_anomaly',      0.0, 'crypto_daily', NOW()),
            ('spread_compression',  0.0, 'crypto_daily', NOW()),
            ('cross_market_corr',   0.0, 'crypto_daily', NOW()),
            ('price_divergence',    0.0, 'crypto_daily', NOW()),
            ('attention_spike',     0.0, 'crypto_daily', NOW()),
            ('news_sentiment',      0.0, 'crypto_daily', NOW()),
            -- event_financial
            ('momentum',           -0.3, 'event_financial', NOW()),
            ('mean_reversion',      0.6, 'event_financial', NOW()),
            ('ofi',                 0.4, 'event_financial', NOW()),
            ('mlofi',               0.4, 'event_financial', NOW()),
            ('hawkes',              0.3, 'event_financial', NOW()),
            ('volume_anomaly',      0.0, 'event_financial', NOW()),
            ('spread_compression',  0.0, 'event_financial', NOW()),
            ('cross_market_corr',   0.0, 'event_financial', NOW()),
            ('price_divergence',    0.0, 'event_financial', NOW()),
            ('attention_spike',     0.0, 'event_financial', NOW()),
            ('news_sentiment',      0.0, 'event_financial', NOW()),
            -- event_short
            ('momentum',           -0.4, 'event_short', NOW()),
            ('mean_reversion',      0.6, 'event_short', NOW()),
            ('ofi',                 0.3, 'event_short', NOW()),
            ('mlofi',               0.3, 'event_short', NOW()),
            ('hawkes',              0.2, 'event_short', NOW()),
            ('volume_anomaly',      0.0, 'event_short', NOW()),
            ('spread_compression',  0.0, 'event_short', NOW()),
            ('cross_market_corr',   0.0, 'event_short', NOW()),
            ('price_divergence',    0.0, 'event_short', NOW()),
            ('attention_spike',     0.0, 'event_short', NOW()),
            ('news_sentiment',      0.0, 'event_short', NOW()),
            -- event_long
            ('momentum',           -0.4, 'event_long', NOW()),
            ('mean_reversion',      0.6, 'event_long', NOW()),
            ('ofi',                 0.2, 'event_long', NOW()),
            ('mlofi',               0.2, 'event_long', NOW()),
            ('hawkes',              0.1, 'event_long', NOW()),
            ('volume_anomaly',      0.0, 'event_long', NOW()),
            ('spread_compression',  0.0, 'event_long', NOW()),
            ('cross_market_corr',   0.0, 'event_long', NOW()),
            ('price_divergence',    0.0, 'event_long', NOW()),
            ('attention_spike',     0.0, 'event_long', NOW()),
            ('news_sentiment',      0.0, 'event_long', NOW())
          ON CONFLICT (signal_type, market_type, direction) DO NOTHING;
        `);

        console.log('[server] signal_weights per-type schema migration applied');
      } catch (err) {
        console.error('[server] signal_weights per-type migration failed:', err);
        throw err;
      }

      // Sub-project B.2: seed consensus_discount_floor config row.
      // signal_weights uses the row-per-config pattern (same as
      // direction_multiplier). See docs/plans/2026-04-25-signal-consensus-design.md.
      // direction='__all__' — config rows are not directional.
      await query(`
        INSERT INTO signal_weights (signal_type, weight, market_type, direction, is_enabled, min_confidence, updated_at)
        VALUES ('consensus_discount_floor', 0.5, '__global__', '__all__', true, 0.0, NOW())
        ON CONFLICT (signal_type, market_type, direction) DO NOTHING;
      `);
      console.log('signal_weights.consensus_discount_floor row ensured');

      // resolution_prior bootstrap row (PR after #190). Optuna writes the
      // optimal weight after each successful OOS-passing cycle. Default 0.0
      // so the generator is wired but inactive until Optuna provides
      // empirical evidence of value.
      await query(`
        INSERT INTO signal_weights (signal_type, weight, market_type, direction, is_enabled, min_confidence, updated_at)
        VALUES ('resolution_prior', 0.0, '__global__', '__all__', true, 0.0, NOW())
        ON CONFLICT (signal_type, market_type, direction) DO NOTHING;
      `);
      console.log('[server] signal_weights.resolution_prior row ensured');

      // favorite_longshot_bias bootstrap (Sprint 2, 2026-05-17). Starts at
      // weight 0.0 so the generator emits signals (visible in
      // generator_predictions for Pilar 1 measurement) but does not influence
      // the combiner until the optimizer ratchets it up from cost-aware
      // t-stat evidence.
      await query(`
        INSERT INTO signal_weights (signal_type, weight, market_type, direction, is_enabled, min_confidence, updated_at)
        VALUES ('favorite_longshot_bias', 0.0, '__global__', '__all__', true, 0.0, NOW())
        ON CONFLICT (signal_type, market_type, direction) DO NOTHING;
      `);
      console.log('[server] signal_weights.favorite_longshot_bias row ensured');

      // resolution_prior_v2 bootstrap (Sprint 2 PR-2, 2026-05-17). Mean-
      // reversion-against-anchor generator. Weight 0.0 so predictions flow
      // to Pilar 1 measurement without affecting the combiner until cost-
      // aware t-stat evidence accrues. Design doc:
      // docs/plans/2026-05-17-resolution-prior-v2-design.md.
      await query(`
        INSERT INTO signal_weights (signal_type, weight, market_type, direction, is_enabled, min_confidence, updated_at)
        VALUES ('resolution_prior_v2', 0.0, '__global__', '__all__', true, 0.0, NOW())
        ON CONFLICT (signal_type, market_type, direction) DO NOTHING;
      `);
      console.log('[server] signal_weights.resolution_prior_v2 row ensured');

      // direction_multiplier per-(market_type) bootstrap. Mirror init/028_*.sql
      // for existing VMs whose volume already initialized (so 028 won't re-run).
      // See docs/plans/2026-04-30-direction-multiplier-per-type-design.md.
      try {
        await bootstrapDirectionMultiplierRows();
        console.log('[server] direction_multiplier per-type bootstrap rows ensured');
      } catch (err) {
        console.error('[server] Failed to bootstrap direction_multiplier rows:', err);
      }

      try {
        await bootstrapShadowCategoryPerformanceTable();
        console.log('[server] category_performance_shadow table ensured');
      } catch (err) {
        console.error('[server] Failed to bootstrap category_performance_shadow:', err);
      }

      // #143 cleanup: drop per-type rows for generators not wired in BacktestService.createSignals.
      // Idempotent — re-running deletes nothing on a clean DB.
      // See docs/plans/2026-04-29-backtest-signal-coverage-design.md.
      try {
        await query(`
          DELETE FROM signal_weights
          WHERE market_type != '__global__'
            AND signal_type IN (
              'mlofi',
              'spread_compression',
              'cross_market_corr',
              'price_divergence',
              'attention_spike',
              'news_sentiment'
            );
        `);
        console.log('[server] backtest-signal-coverage cleanup migration applied');
      } catch (err) {
        console.error('[server] backtest-signal-coverage cleanup failed:', err);
      }

      // PriceRangeWeightModifier matrix persistence (PR after #188). Stores
      // per-(signal_id, band) multipliers Optuna has tuned; SignalEngine reads
      // these on boot and after each successful optimization that passes OOS.
      // CREATE IF NOT EXISTS only — no init SQL migration so existing VMs
      // pick this up on the next deploy.
      try {
        await query(`
          CREATE TABLE IF NOT EXISTS price_range_matrix (
            signal_id  VARCHAR(50) NOT NULL,
            band       VARCHAR(20) NOT NULL,
            multiplier NUMERIC(5,4) NOT NULL DEFAULT 1.0,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (signal_id, band)
          );
        `);
        console.log('[server] price_range_matrix table ensured');
      } catch (err) {
        console.error('[server] price_range_matrix migration failed:', err);
      }

      // Issue #144: persist per-type bestSharpe ratchet across restarts.
      // Without this column, loadState rebuilds bestSharpePerType as
      // { __legacy__: <last_overall_score> } and every real market_type
      // falls back to 0 on the next cycle. Mirror init/026_*.sql.
      try {
        await query(`
          ALTER TABLE optimization_service_state
            ADD COLUMN IF NOT EXISTS best_sharpe_per_type JSONB NOT NULL DEFAULT '{}'::jsonb;
        `);
        console.log('[server] optimization_service_state.best_sharpe_per_type column ensured');
      } catch (err) {
        console.error('[server] best_sharpe_per_type migration failed:', err);
        throw err;
      }

      // Per-generator predictions table (mirrors init/030_generator_predictions.sql).
      // Init SQL only runs on first volume init, so existing VMs need this
      // bootstrap to pick up the new table on next deploy.
      try {
        await query(`
          CREATE TABLE IF NOT EXISTS generator_predictions (
            id BIGSERIAL,
            time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            market_id VARCHAR(128) NOT NULL,
            market_type VARCHAR(32),
            signal_id VARCHAR(50) NOT NULL,
            direction VARCHAR(8) NOT NULL,
            strength NUMERIC(7,4) NOT NULL,
            confidence NUMERIC(5,4) NOT NULL,
            yes_price_at_signal NUMERIC(10,6) NOT NULL,
            metadata JSONB DEFAULT '{}',
            PRIMARY KEY (time, id)
          );
        `);
        await query(`
          SELECT create_hypertable('generator_predictions', 'time',
            chunk_time_interval => INTERVAL '1 day',
            if_not_exists => TRUE
          );
        `);
        await query(`
          CREATE INDEX IF NOT EXISTS idx_gen_predictions_signal_time
            ON generator_predictions (signal_id, time DESC);
        `);
        await query(`
          CREATE INDEX IF NOT EXISTS idx_gen_predictions_market_time
            ON generator_predictions (market_id, time DESC);
        `);
        await query(`
          ALTER TABLE generator_predictions SET (
            timescaledb.compress_after = '3 days'
          );
        `);
        await query(`
          SELECT add_retention_policy('generator_predictions', INTERVAL '30 days', if_not_exists => TRUE);
        `);
        console.log('[server] generator_predictions table ensured');
      } catch (err) {
        console.error('[server] generator_predictions migration failed:', err);
      }

      // Concentration gate prerequisite: cache σ(strength × confidence) per market_type
      // and refresh every 6 h. See docs/plans/2026-04-29-concentration-gate-design.md.
      try {
        await getSignalSigmaCache().start();
        console.log('[server] SignalSigmaCache started (refresh every 6 h)');
      } catch (err) {
        console.error('[server] SignalSigmaCache start failed (gate will use fallback σ):', err);
      }

      // Check for blocking autovacuum every 15 minutes
      setInterval(async () => {
        try {
          const result = await query('SELECT cancel_blocking_autovacuum()');
          // Only log if there was something to cancel (function raises NOTICE)
        } catch {
          // Function may not exist yet on first run
        }
      }, 15 * 60 * 1000);
    } else {
      console.error('Database connection failed:', dbHealth.error);
      console.log('Continuing without database - some features will be disabled');
    }
  } else {
    console.log('DATABASE_URL not configured - running without database');
  }

  // Create dashboard server
  const server = createDashboardServer({
    port,
    host,
    cors: {
      origin: process.env.CORS_ORIGIN ?? '*',
    },
  });

  // Start server
  await server.start();

  // Start optimization scheduler (runs every 6 hours)
  const enableOptimization = process.env.ENABLE_OPTIMIZATION !== 'false';
  if (enableOptimization && isDatabaseConfigured()) {
    const baseUrl = `http://localhost:${port}`;
    const scheduler = initializeOptimizationScheduler(baseUrl);

    // Delay scheduler start to allow trading system to initialize
    setTimeout(async () => {
      console.log('Starting optimization scheduler...');
      await scheduler.start();
    }, 30000); // 30 second delay
  }

  // Start SignalEngine (uses database price history for proper signal generation)
  const enableSignalEngine = process.env.ENABLE_SIGNAL_ENGINE !== 'false';
  if (enableSignalEngine && isDatabaseConfigured()) {
    // Start DbEventListener BEFORE consumers so they can subscribe
    try {
      await getDbEventListener().start();
      console.log('DbEventListener started');
    } catch (err) {
      console.error('DbEventListener failed to start (consumers will use fallback timers):', err);
    }

    setTimeout(async () => {
      console.log('Starting SignalEngine (database-based signals)...');

      // Load optimized parameters from database, but enforce minimum thresholds
      const MIN_CONFIDENCE = 0.43;  // Minimum confidence threshold
      const MIN_STRENGTH = 0.27;    // Minimum strength threshold

      let optimizedParams = { minCombinedConfidence: MIN_CONFIDENCE, minCombinedStrength: MIN_STRENGTH };
      try {
        const result = await query<{ best_params: any }>(`
          SELECT best_params
          FROM optimization_runs
          WHERE status = 'completed' AND best_score IS NOT NULL
          ORDER BY best_score DESC
          LIMIT 1
        `);
        if (result.rows.length > 0 && result.rows[0].best_params) {
          const params = result.rows[0].best_params;
          const dbConfidence = params['combiner.minCombinedConfidence'] ?? params.minConfidence;
          const dbStrength = params['combiner.minCombinedStrength'] ?? params.minEdge;

          // Use MAX of optimized and minimum thresholds (more conservative wins)
          optimizedParams = {
            minCombinedConfidence: Math.max(dbConfidence ?? MIN_CONFIDENCE, MIN_CONFIDENCE),
            minCombinedStrength: Math.max(dbStrength ?? MIN_STRENGTH, MIN_STRENGTH),
          };
          console.log('Loaded params from DB:', { dbConfidence, dbStrength });
          console.log('Applied conservative minimums:', optimizedParams);

          // Signal weights are NOT loaded from optimization_runs on startup.
          // They live in signal_weights table and are synced by SignalEngine
          // every 5 minutes via syncWeightsFromDatabase(). The old startup-load
          // was overwriting manual/contrarian weights with stale optimization
          // results on every container restart.
        } else {
          console.log('No optimization results found, using default conservative thresholds');
        }
      } catch (error) {
        console.warn('Failed to load optimized params, using defaults:', error);
      }

      // DirectionMultiplierLearningService is now opt-in (default OFF). The
      // per-type optimizer (PR #163) supersedes its segment-based learning;
      // any segments[] persisted by previous runs would otherwise win priority
      // over the per-type values. When disabled we wipe segments[] so the
      // resolver falls through to perMarketType (composed from signal_weights).
      const learningEnabled = process.env.ENABLE_DIRECTION_MULTIPLIER_LEARNING === 'true';
      if (learningEnabled) {
        const directionMultiplierLearning = initializeDirectionMultiplierLearningService({
          enabled: true,
          evaluationIntervalMs: parseInt(process.env.DIRECTION_MULTIPLIER_LEARNING_INTERVAL_MS || String(6 * 60 * 60 * 1000), 10),
          lookbackDays: parseInt(process.env.DIRECTION_MULTIPLIER_LEARNING_LOOKBACK_DAYS || '30', 10),
        });
        await directionMultiplierLearning.start();
        console.log('DirectionMultiplierLearningService started (legacy mode, ENABLE_DIRECTION_MULTIPLIER_LEARNING=true)');
      } else {
        try {
          await wipeDirectionMultiplierSegments();
          console.log('DirectionMultiplierLearningService disabled — segments[] wiped, per-type policy active');
        } catch (err) {
          console.error('Failed to wipe direction_multiplier_policy.segments:', err);
        }
      }

      // Cached policy provider (60s TTL) — avoids querying trading_config on every signal resolve
      let cachedPolicy: { data: DirectionMultiplierPolicy; fetchedAt: number } | null = null;
      const POLICY_TTL_MS = 60_000;
      const policyProvider = async (): Promise<DirectionMultiplierPolicy> => {
        const now = Date.now();
        if (cachedPolicy && now - cachedPolicy.fetchedAt < POLICY_TTL_MS) return cachedPolicy.data;

        const rawPolicy = await tradingConfigRepo.get<DirectionMultiplierPolicy>('direction_multiplier_policy');
        const allPerType = await signalWeightsRepo.getAllPerType();
        const perMarketType: Record<string, number> = {};
        for (const [marketType, signals] of Object.entries(allPerType)) {
          if (signals['direction_multiplier'] !== undefined) {
            perMarketType[marketType] = signals['direction_multiplier'];
          }
        }

        const merged: Partial<DirectionMultiplierPolicy> = {
          ...(rawPolicy ?? DEFAULT_DIRECTION_MULTIPLIER_POLICY),
          perMarketType: Object.keys(perMarketType).length > 0 ? perMarketType : undefined,
        };
        const data = sanitizeDirectionMultiplierPolicy(merged);
        cachedPolicy = { data, fetchedAt: now };
        return data;
      };

      const directionResolver = new DirectionResolver({
        policyProvider,
        paperPositionsRepo,
        logger: logger as any,
        setTradingConfig: (key, value, reason) => tradingConfigRepo.set(key, value, reason),
        explorationConfig: {
          epsilon: parseFloat(process.env.DIRECTION_EXPLORATION_EPSILON ?? '0.10'),
          min: parseFloat(process.env.DIRECTION_EXPLORATION_MIN ?? '0.0'),
          max: parseFloat(process.env.DIRECTION_EXPLORATION_MAX ?? '1.0'),
          breakerMinTrades: parseInt(process.env.DIRECTION_EXPLORATION_BREAKER_MIN_TRADES ?? '20', 10),
          breakerWindowDays: parseInt(process.env.DIRECTION_EXPLORATION_BREAKER_WINDOW_DAYS ?? '7', 10),
          breakerMaxCumLoss: parseFloat(process.env.DIRECTION_EXPLORATION_BREAKER_MAX_CUM_LOSS ?? '-150'),
          breakerCacheTtlMs: 300_000,
        },
      });

      // Load consensus_discount_floor from signal_weights (same row-per-config pattern
      // as direction_multiplier — see DirectionMultiplierLearningService:268).
      // Row seeded at startup (commit a4f3472). Fallback to 0.5 is defense-in-depth.
      let consensusDiscountFloor = 0.5;
      try {
        const consensusRow = await signalWeightsRepo.get('consensus_discount_floor');
        if (consensusRow?.weight !== undefined && consensusRow.weight !== null) {
          consensusDiscountFloor = Number(consensusRow.weight);
        }
        console.log('Loaded consensusDiscountFloor from signal_weights:', consensusDiscountFloor);
      } catch (error) {
        console.warn('Failed to load consensus_discount_floor, using default 0.5:', error);
      }

      const signalEngine = initializeSignalEngine({
        enabled: true,
        computeIntervalMs: parseInt(process.env.SIGNAL_INTERVAL_MS || '60000', 10),
        maxMarketsPerCycle: parseInt(process.env.MAX_SIGNAL_MARKETS || '15', 10),
        minPriceBars: 3,           // Bayesian confidence cap handles data scarcity
        minCombinedConfidence: optimizedParams.minCombinedConfidence,
        minCombinedStrength: optimizedParams.minCombinedStrength,
        consensusDiscountFloor,
        directionResolver,
      });

      // Hydrate mean_reversion.referenceMode from trading_config so a
      // previously persisted Optuna decision survives restart. Missing key
      // → keeps the constructor default ('sma'). Invalid stored value (not
      // 'sma'|'fixed_50') is logged and ignored.
      try {
        const persistedMode = await tradingConfigRepo.get<string>('mean_reversion.reference_mode');
        if (persistedMode === 'sma' || persistedMode === 'fixed_50') {
          signalEngine.setMeanReversionReferenceMode(persistedMode);
          console.log(`[server] mean_reversion.referenceMode hydrated from DB: ${persistedMode}`);
        } else if (persistedMode != null) {
          console.warn(`[server] Ignoring invalid persisted mean_reversion.reference_mode: ${persistedMode}`);
        }
      } catch (err) {
        console.warn('[server] Failed to hydrate mean_reversion.referenceMode:', err);
      }

      // Hydrate PriceRangeWeightModifier matrix from DB so Optuna-tuned
      // multipliers persist across restarts. Empty table → keeps in-code
      // defaults from PriceRangeWeightModifier.DEFAULT_MATRIX.
      try {
        const persisted = await priceRangeMatrixRepo.getMatrix();
        const updates: Partial<Record<string, { normal: number; transitional: number; uncertain: number }>> = {};
        const baseline = signalEngine.getPriceRangeMatrix();
        for (const [signalId, bands] of Object.entries(persisted)) {
          const fallback = baseline[signalId] ?? { normal: 1.0, transitional: 1.0, uncertain: 1.0 };
          updates[signalId] = {
            normal: bands.normal ?? fallback.normal,
            transitional: bands.transitional ?? fallback.transitional,
            uncertain: bands.uncertain ?? fallback.uncertain,
          };
        }
        if (Object.keys(updates).length > 0) {
          signalEngine.updatePriceRangeMatrix(updates);
          console.log(`[server] Loaded ${Object.keys(updates).length} price-range matrix overrides from DB`);
        } else {
          console.log('[server] price_range_matrix empty — using PriceRangeWeightModifier defaults');
        }
      } catch (err) {
        console.warn('[server] Failed to hydrate price-range matrix from DB:', err);
      }

      // Start market classifier (classifies new markets via Haiku every 30min)
      const { MarketClassifier } = await import('./services/MarketClassifier.js');
      const classifier = new MarketClassifier();
      classifier.start();

      // Start the Polymarket service to load markets (it will update SignalEngine)
      const polymarketService = getPolymarketService();
      await polymarketService.start();

      // Start the signal engine
      await signalEngine.start();
      console.log('SignalEngine started');

      // Start TradingAutomation so signals can be executed
      const automation = getTradingAutomation();
      await automation.start();
      automation.getExecutor().registerStopLossCooldown(getPositionClosingService());
      await automation.getExecutor().loadPersistedCooldowns();
      await automation.getExecutor().ensureShadowTradesTable();
      console.log('TradingAutomation started');

      // Start PositionCleanupService to auto-close positions in inactive/resolved markets
      const cleanupService = initializePositionCleanupService({
        enabled: true,
        checkIntervalMs: 30 * 60 * 1000,  // Check every 30 minutes
        closeInactiveMarkets: true,
        closeResolvedMarkets: true,
      });
      await cleanupService.start();
      console.log('PositionCleanupService started');

      // Start StopLossService to auto-close positions on stop-loss/take-profit
      const stopLossService = initializeStopLossService({
        enabled: true,
        checkIntervalMs: 5 * 60 * 1000,    // Fallback: 5min (primary trigger: event-driven via DbEventListener)
        defaultStopLossPct: parseFloat(process.env.STOP_LOSS_PCT || '20'),   // 20% stop loss
        defaultTakeProfitPct: parseFloat(process.env.TAKE_PROFIT_PCT || '40'), // 40% take profit
        useTrailingStop: false,
      });
      await stopLossService.start();
      console.log('StopLossService started');

      // Start CircuitBreakerService to auto-reset account on excessive drawdown
      const circuitBreakerService = initializeCircuitBreakerService({
        enabled: true,
        checkIntervalMs: 5 * 60 * 1000,    // Fallback: 5min (primary trigger: event-driven via trade/stopLoss events)
        maxDrawdownPct: parseFloat(process.env.MAX_DRAWDOWN || '0.15') * 100,  // env is decimal (0.15 = 15%)
        initialCapital: parseFloat(process.env.INITIAL_CAPITAL || '10000'),
      });
      await circuitBreakerService.start();
      console.log('CircuitBreakerService started');

      // Initialize real trading (non-blocking — failure doesn't prevent paper trading)
      await initializeRealTrading();
    }, 10000); // 10 second delay to let server fully initialize
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    await getDbEventListener().stop();
    await server.stop();
    await closeDatabase();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
