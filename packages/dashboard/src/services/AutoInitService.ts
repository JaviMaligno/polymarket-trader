/**
 * Auto-Initialization Service
 *
 * Automatically subscribes to markets and creates trading strategies on startup.
 * This ensures the trading system is ready without manual intervention.
 */

import { query, isDatabaseConfigured } from '../database/index.js';
import { getTradingAutomation } from './TradingAutomation.js';

// Best parameters from optimization (Sharpe: 17.66)
const OPTIMIZED_PARAMS = {
  minEdge: 0.03,
  minConfidence: 0.43,
};

interface TradingSystem {
  feed: {
    subscribe: (marketId: string) => void;
    subscribeMany: (marketIds: string[]) => void;
    getSubscriptions: () => string[];
    getAllMarkets: () => any[];
  };
  orchestrator: {
    registerStrategy: (config: any, signals: any[], combiner: any) => void;
    startStrategy: (strategyId: string) => void;
    getAllStrategyStates: () => Map<string, any>;
  };
}

interface MarketRow {
  condition_id: string;
  question: string;
  volume_24h: string | null;
}

/**
 * Auto-initialize the trading system with markets and strategy
 */
export async function autoInitialize(tradingSystem: TradingSystem): Promise<void> {
  console.log('=== Auto-Initialization Starting ===');

  if (!isDatabaseConfigured()) {
    console.log('Database not configured, skipping auto-init');
    return;
  }

  try {
    // 1. Load active markets from database
    console.log('Loading active markets from database...');
    const markets = await loadActiveMarkets();

    if (markets.length === 0) {
      console.log('No active markets found, skipping auto-init');
      return;
    }

    console.log(`Found ${markets.length} active markets`);

    // 2. Subscribe markets to feed
    console.log('Subscribing markets to feed...');
    const marketIds = markets.map(m => m.condition_id);
    tradingSystem.feed.subscribeMany(marketIds);
    console.log(`Subscribed to ${marketIds.length} markets`);

    // 3. Check if strategy already exists
    const existingStrategies = tradingSystem.orchestrator.getAllStrategyStates();
    if (existingStrategies.size > 0) {
      console.log(`${existingStrategies.size} strategies already exist, skipping creation`);
      return;
    }

    // 4. Load best optimization parameters from database
    const bestParams = await loadBestOptimizationParams();
    const params = bestParams || OPTIMIZED_PARAMS;
    console.log('Using parameters:', params);

    // 5. Create strategy - this will be done via the API routes
    // The strategy creation requires signal instances which are created in routes.ts
    console.log('Auto-init complete. Strategy should be created via API.');
    console.log('Call POST /api/strategies with type=combo to create strategy.');

  } catch (error) {
    console.error('Auto-initialization failed:', error);
    // Don't throw - let server continue without auto-init
  }
}

/**
 * Load active markets with recent price data
 */
async function loadActiveMarkets(): Promise<MarketRow[]> {
  try {
    const result = await query<MarketRow>(`
      SELECT DISTINCT m.condition_id, m.question, m.volume_24h
      FROM markets m
      JOIN price_history ph ON m.id = ph.market_id
      WHERE ph.time > NOW() - INTERVAL '24 hours'
        AND m.is_active = true
        AND m.condition_id IS NOT NULL
      GROUP BY m.condition_id, m.question, m.volume_24h
      HAVING COUNT(*) >= 20
      ORDER BY m.volume_24h DESC NULLS LAST
      LIMIT 50
    `);
    return result.rows;
  } catch (error) {
    console.error('Failed to load markets:', error);
    return [];
  }
}

/**
 * Load best optimization parameters from database
 */
async function loadBestOptimizationParams(): Promise<{ minEdge: number; minConfidence: number } | null> {
  try {
    const result = await query<{ best_params: any }>(`
      SELECT best_params
      FROM optimization_runs
      WHERE status = 'completed' AND best_score IS NOT NULL
      ORDER BY best_score DESC
      LIMIT 1
    `);

    if (result.rows.length === 0) {
      return null;
    }

    const params = result.rows[0].best_params;
    if (!params) return null;

    // Support both Optuna flat keys and legacy grid-search keys
    return {
      minEdge: params['combiner.minCombinedStrength']
        ?? params.execution_minEdge
        ?? params.minEdge
        ?? OPTIMIZED_PARAMS.minEdge,
      minConfidence: params['combiner.minCombinedConfidence']
        ?? params.combiner_minCombinedConfidence
        ?? params.minConfidence
        ?? OPTIMIZED_PARAMS.minConfidence,
    };
  } catch (error) {
    console.error('Failed to load optimization params:', error);
    return null;
  }
}

/**
 * Create and start strategy via internal API call
 */
export async function createAndStartStrategy(baseUrl: string): Promise<void> {
  try {
    // Load best params
    const bestParams = await loadBestOptimizationParams();
    const params = bestParams || OPTIMIZED_PARAMS;

    // Create strategy
    const createRes = await fetch(`${baseUrl}/api/strategies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'combo',
        name: 'auto-optimized',
        minEdge: params.minEdge,
        minConfidence: params.minConfidence,
        disableFilters: true,
      }),
    });

    if (!createRes.ok) {
      const error = await createRes.text();
      console.error('Failed to create strategy:', error);
      return;
    }

    const result = await createRes.json() as { data?: { id?: string } };
    const strategyId = result.data?.id;

    if (strategyId) {
      // Start strategy
      await fetch(`${baseUrl}/api/strategies/${strategyId}/start`, {
        method: 'POST',
      });
      console.log(`Strategy ${strategyId} created and started`);

      // Apply optimized thresholds to executor
      try {
        getTradingAutomation().getExecutor().updateConfig({
          minStrength: params.minEdge,
          minConfidence: params.minConfidence,
        });
        console.log(`[AutoInit] Applied optimized thresholds: minStrength=${params.minEdge}, minConfidence=${params.minConfidence}`);
      } catch (err) {
        console.error('[AutoInit] Could not update executor thresholds:', err);
      }
    }
  } catch (error) {
    console.error('Failed to create/start strategy:', error);
  }
}
