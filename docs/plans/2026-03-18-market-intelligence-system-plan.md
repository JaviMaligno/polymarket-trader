# Market Intelligence System — Phase 1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace volume-only market selection with smart scoring + dynamic rotation so the system tracks tradeable markets and generates signals.

**Architecture:** MarketScorer computes a composite score (tradeability, liquidity, TTR) via SQL for all markets, plus volatility and data quality for tracked markets. MarketRotator manages state transitions (cold→warming→active→cooling) with hysteresis and position protection. Both run inside the existing `sync-markets` hourly job. ClobCollector queries switch from `ORDER BY volume_24h LIMIT 40` to `WHERE tracking_status IN ('warming','active','cooling')`.

**Tech Stack:** TypeScript, PostgreSQL (TimescaleDB), vitest, node-cron (existing)

**Design Doc:** `docs/plans/2026-03-18-market-intelligence-system-design.md`

---

## Task 1: Database Schema Migration

**Files:**
- Create: `packages/data-collector/src/database/init/005_market_intelligence.sql`

**Step 1: Write the migration SQL**

```sql
-- Market Intelligence System: scoring and tracking status
ALTER TABLE markets ADD COLUMN IF NOT EXISTS market_score FLOAT DEFAULT 0;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS tracking_status VARCHAR(10) DEFAULT 'cold';
ALTER TABLE markets ADD COLUMN IF NOT EXISTS tracking_status_changed_at TIMESTAMPTZ DEFAULT NOW();

-- Index for ClobCollector queries that filter by tracking_status
CREATE INDEX IF NOT EXISTS idx_markets_tracking_status ON markets (tracking_status) WHERE tracking_status IN ('warming', 'active', 'cooling');

-- Index for MarketScorer candidate selection
CREATE INDEX IF NOT EXISTS idx_markets_score ON markets (market_score DESC) WHERE is_active = true AND is_resolved = false;

-- Warm start: markets with recent price_history get 'active' status
-- (Run once on deployment, then MarketRotator manages state)
UPDATE markets SET tracking_status = 'active', tracking_status_changed_at = NOW()
WHERE is_active = true
  AND is_resolved = false
  AND clob_token_id_yes IS NOT NULL
  AND id IN (
    SELECT DISTINCT m.id FROM markets m
    JOIN price_history ph ON ph.token_id = m.clob_token_id_yes
    WHERE ph.time > NOW() - INTERVAL '24 hours'
  );
```

**Step 2: Register migration in the init sequence**

Modify: `packages/data-collector/src/database/connection.ts` — the migrations are run via `src/database/migrate.ts` but schema files in `init/` are applied on first startup. Verify the file naming convention (005_ follows 004_).

**Step 3: Test migration locally**

Run:
```bash
cd packages/data-collector && pnpm build
```
Expected: Compiles without errors. Migration file is just SQL, no TS compilation needed.

**Step 4: Commit**

```bash
git add packages/data-collector/src/database/init/005_market_intelligence.sql
git commit -m "feat: add market_score and tracking_status columns to markets table"
```

---

## Task 2: MarketScorer — Tests

**Files:**
- Create: `packages/data-collector/src/services/MarketScorer.test.ts`

**Step 1: Write failing tests for score computation**

```typescript
import { describe, it, expect } from 'vitest';
import { MarketScorer } from './MarketScorer';

describe('MarketScorer', () => {
  describe('computeTradeabilityScore', () => {
    it('returns 0 for null price', () => {
      expect(MarketScorer.tradeabilityScore(null)).toBe(0);
    });

    it('returns 0 for extreme low price (<0.05)', () => {
      expect(MarketScorer.tradeabilityScore(0.02)).toBe(0);
      expect(MarketScorer.tradeabilityScore(0.04)).toBe(0);
    });

    it('returns 0 for extreme high price (>0.95)', () => {
      expect(MarketScorer.tradeabilityScore(0.97)).toBe(0);
      expect(MarketScorer.tradeabilityScore(0.99)).toBe(0);
    });

    it('returns 0 for 50/50 range (0.45-0.55)', () => {
      expect(MarketScorer.tradeabilityScore(0.50)).toBe(0);
      expect(MarketScorer.tradeabilityScore(0.45)).toBe(0);
      expect(MarketScorer.tradeabilityScore(0.55)).toBe(0);
    });

    it('returns 1.0 for optimal low range (0.15-0.40)', () => {
      expect(MarketScorer.tradeabilityScore(0.15)).toBe(1.0);
      expect(MarketScorer.tradeabilityScore(0.25)).toBe(1.0);
      expect(MarketScorer.tradeabilityScore(0.40)).toBe(1.0);
    });

    it('returns 1.0 for optimal high range (0.60-0.85)', () => {
      expect(MarketScorer.tradeabilityScore(0.60)).toBe(1.0);
      expect(MarketScorer.tradeabilityScore(0.75)).toBe(1.0);
      expect(MarketScorer.tradeabilityScore(0.85)).toBe(1.0);
    });

    it('ramps linearly from extreme to optimal (0.05-0.15)', () => {
      const score = MarketScorer.tradeabilityScore(0.10);
      expect(score).toBeCloseTo(0.5, 1); // midpoint of ramp
    });

    it('ramps linearly from optimal to 50/50 (0.40-0.45)', () => {
      const score = MarketScorer.tradeabilityScore(0.42);
      expect(score).toBeCloseTo(0.6, 1); // 60% of ramp
    });

    it('ramps linearly from 50/50 to optimal (0.55-0.60)', () => {
      const score = MarketScorer.tradeabilityScore(0.58);
      expect(score).toBeCloseTo(0.6, 1);
    });

    it('ramps linearly from optimal to extreme (0.85-0.95)', () => {
      const score = MarketScorer.tradeabilityScore(0.90);
      expect(score).toBeCloseTo(0.5, 1);
    });

    it('is symmetric around 0.50', () => {
      expect(MarketScorer.tradeabilityScore(0.30))
        .toBeCloseTo(MarketScorer.tradeabilityScore(0.70), 5);
      expect(MarketScorer.tradeabilityScore(0.10))
        .toBeCloseTo(MarketScorer.tradeabilityScore(0.90), 5);
    });
  });

  describe('computeLiquidityScore', () => {
    it('returns 0 for null or zero volume', () => {
      expect(MarketScorer.liquidityScore(null, null)).toBe(0);
      expect(MarketScorer.liquidityScore(0, null)).toBe(0);
    });

    it('returns higher score for higher volume', () => {
      const low = MarketScorer.liquidityScore(1000, null);
      const high = MarketScorer.liquidityScore(1000000, null);
      expect(high).toBeGreaterThan(low);
    });

    it('applies 50% penalty for wide spread (>0.03)', () => {
      const normal = MarketScorer.liquidityScore(100000, 0.01);
      const wide = MarketScorer.liquidityScore(100000, 0.05);
      expect(wide).toBeCloseTo(normal * 0.5, 1);
    });

    it('caps at 1.0', () => {
      expect(MarketScorer.liquidityScore(999999999, null)).toBeLessThanOrEqual(1.0);
    });
  });

  describe('computeTTRScore', () => {
    it('returns 0.5 for null end_date (unknown)', () => {
      expect(MarketScorer.ttrScore(null)).toBe(0.5);
    });

    it('returns 0.1 for resolution < 24h away', () => {
      const soon = new Date(Date.now() + 12 * 3600 * 1000); // 12h from now
      expect(MarketScorer.ttrScore(soon)).toBeCloseTo(0.1, 1);
    });

    it('returns 1.0 for 7-60 day window', () => {
      const optimal = new Date(Date.now() + 30 * 24 * 3600 * 1000); // 30 days
      expect(MarketScorer.ttrScore(optimal)).toBe(1.0);
    });

    it('ramps between 24h and 7 days', () => {
      const midway = new Date(Date.now() + 4 * 24 * 3600 * 1000); // 4 days
      const score = MarketScorer.ttrScore(midway);
      expect(score).toBeGreaterThan(0.1);
      expect(score).toBeLessThan(1.0);
    });

    it('decays for >60 days but stays >= 0.5', () => {
      const far = new Date(Date.now() + 120 * 24 * 3600 * 1000); // 120 days
      const score = MarketScorer.ttrScore(far);
      expect(score).toBeGreaterThanOrEqual(0.5);
      expect(score).toBeLessThan(1.0);
    });

    it('returns 0.5 for very far out (>180 days)', () => {
      const veryFar = new Date(Date.now() + 365 * 24 * 3600 * 1000);
      expect(MarketScorer.ttrScore(veryFar)).toBe(0.5);
    });
  });

  describe('computeVolatilityScore', () => {
    it('returns 0 for zero volatility (dead market)', () => {
      expect(MarketScorer.volatilityScore(0)).toBe(0);
    });

    it('returns 0 for null volatility', () => {
      expect(MarketScorer.volatilityScore(null)).toBe(0);
    });

    it('returns high score for moderate volatility', () => {
      const score = MarketScorer.volatilityScore(0.05);
      expect(score).toBeGreaterThan(0.7);
    });

    it('penalizes extreme volatility (>0.15)', () => {
      const moderate = MarketScorer.volatilityScore(0.05);
      const extreme = MarketScorer.volatilityScore(0.20);
      expect(extreme).toBeLessThan(moderate);
    });

    it('caps at 1.0', () => {
      expect(MarketScorer.volatilityScore(0.08)).toBeLessThanOrEqual(1.0);
    });
  });

  describe('computeDataQualityScore', () => {
    it('returns 0 for no bars', () => {
      expect(MarketScorer.dataQualityScore(0, 0)).toBe(0);
    });

    it('returns higher score for more informative bars', () => {
      const low = MarketScorer.dataQualityScore(10, 100);  // 10% informative
      const high = MarketScorer.dataQualityScore(80, 100);  // 80% informative
      expect(high).toBeGreaterThan(low);
    });

    it('caps at 1.0', () => {
      expect(MarketScorer.dataQualityScore(100, 100)).toBeLessThanOrEqual(1.0);
    });
  });

  describe('compositeScore', () => {
    it('combines all dimensions with correct weights', () => {
      // All perfect scores should give 1.0
      const score = MarketScorer.compositeScore({
        tradeability: 1.0,
        liquidity: 1.0,
        volatility: 1.0,
        ttr: 1.0,
        dataQuality: 1.0,
      });
      expect(score).toBeCloseTo(1.0, 5);
    });

    it('uses partial score when volatility/quality unavailable (cold markets)', () => {
      // Cold markets only have tradeability + liquidity + TTR
      const score = MarketScorer.compositeScore({
        tradeability: 1.0,
        liquidity: 1.0,
        volatility: null,
        ttr: 1.0,
        dataQuality: null,
      });
      // Should normalize: (0.30 + 0.25 + 0.15) / (0.30 + 0.25 + 0.15) = 1.0
      expect(score).toBeCloseTo(1.0, 5);
    });

    it('returns 0 for all-zero scores', () => {
      const score = MarketScorer.compositeScore({
        tradeability: 0,
        liquidity: 0,
        volatility: 0,
        ttr: 0,
        dataQuality: 0,
      });
      expect(score).toBe(0);
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/data-collector && pnpm test -- --run src/services/MarketScorer.test.ts`
Expected: FAIL — `Cannot find module './MarketScorer'`

**Step 3: Commit test file**

```bash
git add packages/data-collector/src/services/MarketScorer.test.ts
git commit -m "test: add MarketScorer unit tests (red phase)"
```

---

## Task 3: MarketScorer — Implementation

**Files:**
- Create: `packages/data-collector/src/services/MarketScorer.ts`

**Step 1: Implement the scoring functions**

```typescript
import { query } from '../database/connection';
import logger from '../utils/logger';

// Weights — initial defaults, will be optimized via Optuna in Phase 2.5
const WEIGHTS = {
  tradeability: 0.30,
  liquidity: 0.25,
  volatility: 0.20,
  ttr: 0.15,
  dataQuality: 0.10,
};

// Reference volume for normalization (log scale)
// ~$30M is the highest observed 24h volume on Polymarket
const MAX_VOLUME_REF = 30_000_000;

interface ScoreDimensions {
  tradeability: number;
  liquidity: number;
  volatility: number | null;
  ttr: number;
  dataQuality: number | null;
}

export class MarketScorer {
  /**
   * Tradeability: how profitable is trading at this price?
   * Optimal: [0.15-0.40] ∪ [0.60-0.85] → 1.0
   * Zero: <0.05, >0.95, 0.45-0.55
   * Linear ramps between zones
   */
  static tradeabilityScore(price: number | null): number {
    if (price === null || price === undefined) return 0;
    if (price < 0.05 || price > 0.95) return 0;
    if (price >= 0.45 && price <= 0.55) return 0;

    // Low side
    if (price >= 0.15 && price <= 0.40) return 1.0;
    if (price >= 0.05 && price < 0.15) return (price - 0.05) / 0.10;
    if (price > 0.40 && price < 0.45) return (0.45 - price) / 0.05;

    // High side (symmetric)
    if (price >= 0.60 && price <= 0.85) return 1.0;
    if (price > 0.55 && price < 0.60) return (price - 0.55) / 0.05;
    if (price > 0.85 && price <= 0.95) return (0.95 - price) / 0.10;

    return 0;
  }

  /**
   * Liquidity: can we enter/exit without slippage?
   * log(volume) normalized against reference max.
   * 50% penalty if spread > 3%.
   */
  static liquidityScore(volume24h: number | null, spread: number | null): number {
    if (!volume24h || volume24h <= 0) return 0;
    const raw = Math.min(1.0, Math.log(volume24h) / Math.log(MAX_VOLUME_REF));
    const spreadPenalty = spread !== null && spread > 0.03 ? 0.5 : 1.0;
    return raw * spreadPenalty;
  }

  /**
   * Time-to-Resolution: is there useful life remaining?
   * Optimal: 7-60 days → 1.0
   * <24h → 0.1 (too soon, near-resolution risks)
   * >180 days → 0.5 (too slow)
   */
  static ttrScore(endDate: Date | null): number {
    if (!endDate) return 0.5; // unknown, neutral

    const hoursLeft = (endDate.getTime() - Date.now()) / (3600 * 1000);
    if (hoursLeft < 0) return 0; // already past
    if (hoursLeft < 24) return 0.1;

    const daysLeft = hoursLeft / 24;
    if (daysLeft < 7) return 0.1 + 0.9 * ((daysLeft - 1) / 6); // ramp 1-7 days
    if (daysLeft <= 60) return 1.0; // optimal
    if (daysLeft <= 180) return 1.0 - 0.5 * ((daysLeft - 60) / 120); // decay
    return 0.5; // very far out
  }

  /**
   * Volatility: is there price movement for signal generation?
   * Optimal: stddev ~0.05-0.10 → high score
   * Zero: dead market → 0
   * >0.15: likely resolving → penalized
   */
  static volatilityScore(stddev: number | null): number {
    if (stddev === null || stddev === undefined || stddev === 0) return 0;
    // Bell curve peaking at stddev=0.07
    const optimal = 0.07;
    const width = 0.06;
    const normalized = Math.exp(-Math.pow(stddev - optimal, 2) / (2 * Math.pow(width, 2)));
    return Math.min(1.0, normalized);
  }

  /**
   * Data Quality: ratio of informative bars vs flat snapshots
   * More real data (from trades) = better signals
   */
  static dataQualityScore(informativeBars: number, totalBars: number): number {
    if (totalBars === 0) return 0;
    return Math.min(1.0, informativeBars / totalBars);
  }

  /**
   * Combine dimensions into composite score.
   * For cold markets (no volatility/quality data), normalize by available weights.
   */
  static compositeScore(dims: ScoreDimensions): number {
    let score = 0;
    let totalWeight = 0;

    score += WEIGHTS.tradeability * dims.tradeability;
    totalWeight += WEIGHTS.tradeability;

    score += WEIGHTS.liquidity * dims.liquidity;
    totalWeight += WEIGHTS.liquidity;

    score += WEIGHTS.ttr * dims.ttr;
    totalWeight += WEIGHTS.ttr;

    if (dims.volatility !== null) {
      score += WEIGHTS.volatility * dims.volatility;
      totalWeight += WEIGHTS.volatility;
    }

    if (dims.dataQuality !== null) {
      score += WEIGHTS.dataQuality * dims.dataQuality;
      totalWeight += WEIGHTS.dataQuality;
    }

    return totalWeight > 0 ? score / totalWeight : 0;
  }

  /**
   * Score all active, unresolved markets in the DB.
   * Two-pass approach:
   *   1. Score all candidates on tradeability + liquidity + TTR (from markets table)
   *   2. Enrich tracked markets with volatility + data quality (from price_history)
   */
  async scoreAllMarkets(): Promise<{ scored: number; enriched: number }> {
    const log = logger.child({ name: 'MarketScorer' });

    // Pass 1: Score all candidates using markets table data only
    const candidates = await query<{
      id: string;
      current_price_yes: number | null;
      volume_24h: number | null;
      spread: number | null;
      end_date: Date | null;
    }>(
      `SELECT id, current_price_yes, volume_24h, spread, end_date
       FROM markets
       WHERE is_active = true AND is_resolved = false AND clob_token_id_yes IS NOT NULL`
    );

    if (candidates.rows.length === 0) {
      log.warn('No active markets to score');
      return { scored: 0, enriched: 0 };
    }

    // Compute base scores (3 dimensions)
    const updates: { id: string; score: number }[] = [];
    for (const m of candidates.rows) {
      const score = MarketScorer.compositeScore({
        tradeability: MarketScorer.tradeabilityScore(m.current_price_yes),
        liquidity: MarketScorer.liquidityScore(
          m.volume_24h ? parseFloat(String(m.volume_24h)) : null,
          m.spread ? parseFloat(String(m.spread)) : null
        ),
        ttr: MarketScorer.ttrScore(m.end_date),
        volatility: null,
        dataQuality: null,
      });
      updates.push({ id: m.id, score });
    }

    // Batch update scores (500 at a time)
    let scored = 0;
    for (let i = 0; i < updates.length; i += 500) {
      const batch = updates.slice(i, i + 500);
      const cases = batch.map((u, idx) => `WHEN $${idx * 2 + 1} THEN $${idx * 2 + 2}::float`).join(' ');
      const ids = batch.map((u, idx) => `$${idx * 2 + 1}`).join(', ');
      const params = batch.flatMap(u => [u.id, u.score]);

      await query(
        `UPDATE markets SET market_score = CASE id ${cases} END
         WHERE id IN (${ids})`,
        params
      );
      scored += batch.length;
    }

    // Pass 2: Enrich tracked markets with volatility + data quality
    const tracked = await query<{
      id: string;
      current_price_yes: number | null;
      volume_24h: number | null;
      spread: number | null;
      end_date: Date | null;
      price_stddev: number | null;
      informative_bars: number;
      total_bars: number;
    }>(
      `SELECT m.id, m.current_price_yes, m.volume_24h, m.spread, m.end_date,
              STDDEV(ph.close) as price_stddev,
              COUNT(*) FILTER (WHERE ph.source != 'snapshot' OR ph.open != ph.close) as informative_bars,
              COUNT(*) as total_bars
       FROM markets m
       JOIN price_history ph ON ph.token_id = m.clob_token_id_yes
         AND ph.time > NOW() - INTERVAL '24 hours'
       WHERE m.tracking_status IN ('warming', 'active', 'cooling')
       GROUP BY m.id, m.current_price_yes, m.volume_24h, m.spread, m.end_date`
    );

    let enriched = 0;
    for (const m of tracked.rows) {
      const score = MarketScorer.compositeScore({
        tradeability: MarketScorer.tradeabilityScore(m.current_price_yes),
        liquidity: MarketScorer.liquidityScore(
          m.volume_24h ? parseFloat(String(m.volume_24h)) : null,
          m.spread ? parseFloat(String(m.spread)) : null
        ),
        ttr: MarketScorer.ttrScore(m.end_date),
        volatility: MarketScorer.volatilityScore(
          m.price_stddev ? parseFloat(String(m.price_stddev)) : null
        ),
        dataQuality: MarketScorer.dataQualityScore(
          parseInt(String(m.informative_bars)),
          parseInt(String(m.total_bars))
        ),
      });

      await query(
        `UPDATE markets SET market_score = $1 WHERE id = $2`,
        [score, m.id]
      );
      enriched++;
    }

    log.info({ scored, enriched }, 'Market scoring complete');
    return { scored, enriched };
  }
}
```

**Step 2: Run tests to verify they pass**

Run: `cd packages/data-collector && pnpm test -- --run src/services/MarketScorer.test.ts`
Expected: ALL PASS

**Step 3: Commit**

```bash
git add packages/data-collector/src/services/MarketScorer.ts
git commit -m "feat: implement MarketScorer with composite scoring (5 dimensions)"
```

---

## Task 4: MarketRotator — Tests

**Files:**
- Create: `packages/data-collector/src/services/MarketRotator.test.ts`

**Step 1: Write failing tests for rotation logic**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MarketRotator, RotationConfig, MarketRow } from './MarketRotator';

// Mock the database module
vi.mock('../database/connection', () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

import { query, transaction } from '../database/connection';
const mockQuery = vi.mocked(query);
const mockTransaction = vi.mocked(transaction);

function makeMarket(overrides: Partial<MarketRow> = {}): MarketRow {
  return {
    id: 'market-1',
    market_score: 0.8,
    tracking_status: 'cold',
    tracking_status_changed_at: new Date(Date.now() - 3600_000),
    current_price_yes: 0.30,
    has_open_positions: false,
    bars_24h: 0,
    ...overrides,
  };
}

const DEFAULT_CONFIG: RotationConfig = {
  maxTracked: 40,
  maxRotationsPerHour: 5,
  warmingPromotionBars: 3,
  coolingTimeoutHours: 6,
  emergencyFillThreshold: 20,
  hysteresisRatio: 0.60,
  reserveSlots: 2,
};

describe('MarketRotator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('selectDemotions', () => {
    it('demotes ACTIVE market with low score when better candidates wait', () => {
      const rotator = new MarketRotator(DEFAULT_CONFIG);
      const active = [makeMarket({ id: 'a1', tracking_status: 'active', market_score: 0.2 })];
      const candidates = [makeMarket({ id: 'c1', tracking_status: 'cold', market_score: 0.8 })];

      const demotions = rotator.selectDemotions(active, candidates);
      expect(demotions.map(m => m.id)).toContain('a1');
    });

    it('does NOT demote ACTIVE market with open positions', () => {
      const rotator = new MarketRotator(DEFAULT_CONFIG);
      const active = [makeMarket({
        id: 'a1', tracking_status: 'active', market_score: 0.1, has_open_positions: true,
      })];
      const candidates = [makeMarket({ id: 'c1', tracking_status: 'cold', market_score: 0.9 })];

      const demotions = rotator.selectDemotions(active, candidates);
      expect(demotions).toHaveLength(0);
    });

    it('applies hysteresis — only demotes if score < 60% of worst candidate', () => {
      const rotator = new MarketRotator(DEFAULT_CONFIG);
      // Worst candidate score: 0.5. Hysteresis threshold: 0.5 * 0.60 = 0.30
      // Active score 0.35 > 0.30, so should NOT demote
      const active = [makeMarket({ id: 'a1', tracking_status: 'active', market_score: 0.35 })];
      const candidates = [makeMarket({ id: 'c1', tracking_status: 'cold', market_score: 0.5 })];

      const demotions = rotator.selectDemotions(active, candidates);
      expect(demotions).toHaveLength(0);
    });

    it('respects max rotations per hour', () => {
      const rotator = new MarketRotator({ ...DEFAULT_CONFIG, maxRotationsPerHour: 2 });
      const active = [
        makeMarket({ id: 'a1', tracking_status: 'active', market_score: 0.01 }),
        makeMarket({ id: 'a2', tracking_status: 'active', market_score: 0.02 }),
        makeMarket({ id: 'a3', tracking_status: 'active', market_score: 0.03 }),
      ];
      const candidates = [
        makeMarket({ id: 'c1', market_score: 0.9 }),
        makeMarket({ id: 'c2', market_score: 0.8 }),
        makeMarket({ id: 'c3', market_score: 0.7 }),
      ];

      const demotions = rotator.selectDemotions(active, candidates);
      expect(demotions.length).toBeLessThanOrEqual(2);
    });
  });

  describe('selectPromotions', () => {
    it('promotes WARMING market with enough bars', () => {
      const rotator = new MarketRotator(DEFAULT_CONFIG);
      const warming = [makeMarket({
        id: 'w1', tracking_status: 'warming', bars_24h: 5, market_score: 0.7,
      })];

      const promotions = rotator.selectPromotions(warming);
      expect(promotions.map(m => m.id)).toContain('w1');
    });

    it('does NOT promote WARMING market with insufficient bars', () => {
      const rotator = new MarketRotator(DEFAULT_CONFIG);
      const warming = [makeMarket({
        id: 'w1', tracking_status: 'warming', bars_24h: 1, market_score: 0.7,
      })];

      const promotions = rotator.selectPromotions(warming);
      expect(promotions).toHaveLength(0);
    });

    it('re-evaluates score before promoting — drops if score decayed', () => {
      const rotator = new MarketRotator(DEFAULT_CONFIG);
      // Has enough bars but score dropped to near-zero (price moved to 50/50)
      const warming = [makeMarket({
        id: 'w1', tracking_status: 'warming', bars_24h: 10, market_score: 0.01,
      })];

      const promotions = rotator.selectPromotions(warming);
      expect(promotions).toHaveLength(0);
    });
  });

  describe('selectCoolingExpired', () => {
    it('expires COOLING market after timeout', () => {
      const rotator = new MarketRotator(DEFAULT_CONFIG);
      const cooling = [makeMarket({
        id: 'cool1',
        tracking_status: 'cooling',
        tracking_status_changed_at: new Date(Date.now() - 7 * 3600_000), // 7h ago
        has_open_positions: false,
      })];

      const expired = rotator.selectCoolingExpired(cooling);
      expect(expired.map(m => m.id)).toContain('cool1');
    });

    it('does NOT expire COOLING market with open positions before timeout', () => {
      const rotator = new MarketRotator(DEFAULT_CONFIG);
      const cooling = [makeMarket({
        id: 'cool1',
        tracking_status: 'cooling',
        tracking_status_changed_at: new Date(Date.now() - 2 * 3600_000), // 2h ago
        has_open_positions: true,
      })];

      const expired = rotator.selectCoolingExpired(cooling);
      expect(expired).toHaveLength(0);
    });

    it('expires COOLING market with open positions after timeout (flags for stop-loss)', () => {
      const rotator = new MarketRotator(DEFAULT_CONFIG);
      const cooling = [makeMarket({
        id: 'cool1',
        tracking_status: 'cooling',
        tracking_status_changed_at: new Date(Date.now() - 7 * 3600_000), // 7h, past 6h timeout
        has_open_positions: true,
      })];

      const expired = rotator.selectCoolingExpired(cooling);
      expect(expired.map(m => m.id)).toContain('cool1');
    });
  });

  describe('computeNewWarmingSlots', () => {
    it('fills warming slots up to available capacity', () => {
      const rotator = new MarketRotator(DEFAULT_CONFIG);
      const currentCounts = { active: 30, warming: 2, cooling: 1 };
      // maxTracked=40, reserve=2 → usable=38. Used=33. Available=5.
      const slots = rotator.computeNewWarmingSlots(currentCounts);
      expect(slots).toBe(5);
    });

    it('returns 0 when at capacity', () => {
      const rotator = new MarketRotator(DEFAULT_CONFIG);
      const currentCounts = { active: 35, warming: 3, cooling: 0 };
      // usable=38. Used=38. Available=0.
      const slots = rotator.computeNewWarmingSlots(currentCounts);
      expect(slots).toBe(0);
    });
  });

  describe('emergency fill', () => {
    it('bypasses rotation limit when ACTIVE < threshold', () => {
      const rotator = new MarketRotator(DEFAULT_CONFIG);
      const isEmergency = rotator.isEmergencyFill(15); // threshold=20
      expect(isEmergency).toBe(true);
    });

    it('does not trigger when ACTIVE >= threshold', () => {
      const rotator = new MarketRotator(DEFAULT_CONFIG);
      const isEmergency = rotator.isEmergencyFill(25);
      expect(isEmergency).toBe(false);
    });
  });

  describe('targetState for demotion', () => {
    it('demotes to COOLING if has open positions', () => {
      const rotator = new MarketRotator(DEFAULT_CONFIG);
      expect(rotator.demotionTarget(true)).toBe('cooling');
    });

    it('demotes to COLD if no open positions', () => {
      const rotator = new MarketRotator(DEFAULT_CONFIG);
      expect(rotator.demotionTarget(false)).toBe('cold');
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/data-collector && pnpm test -- --run src/services/MarketRotator.test.ts`
Expected: FAIL — `Cannot find module './MarketRotator'`

**Step 3: Commit test file**

```bash
git add packages/data-collector/src/services/MarketRotator.test.ts
git commit -m "test: add MarketRotator unit tests (red phase)"
```

---

## Task 5: MarketRotator — Implementation

**Files:**
- Create: `packages/data-collector/src/services/MarketRotator.ts`

**Step 1: Implement the rotation state machine**

```typescript
import { query } from '../database/connection';
import logger from '../utils/logger';

export interface RotationConfig {
  maxTracked: number;          // MAX_TRACKED_MARKETS (40)
  maxRotationsPerHour: number; // 5 (structural)
  warmingPromotionBars: number; // 3 (structural — SignalEngine minimum)
  coolingTimeoutHours: number; // 6 (structural)
  emergencyFillThreshold: number; // 20 (structural)
  hysteresisRatio: number;     // 0.60 (optimizable)
  reserveSlots: number;        // 2 (structural)
}

export interface MarketRow {
  id: string;
  market_score: number;
  tracking_status: string;
  tracking_status_changed_at: Date;
  current_price_yes: number | null;
  has_open_positions: boolean;
  bars_24h: number;
}

const DEFAULT_CONFIG: RotationConfig = {
  maxTracked: parseInt(process.env.MAX_TRACKED_MARKETS || '40', 10),
  maxRotationsPerHour: 5,
  warmingPromotionBars: 3,
  coolingTimeoutHours: 6,
  emergencyFillThreshold: 20,
  hysteresisRatio: 0.60,
  reserveSlots: 2,
};

// Minimum score to be considered for warming
const MIN_CANDIDATE_SCORE = 0.15;

export class MarketRotator {
  private config: RotationConfig;

  constructor(config: Partial<RotationConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  isEmergencyFill(activeCount: number): boolean {
    return activeCount < this.config.emergencyFillThreshold;
  }

  demotionTarget(hasOpenPositions: boolean): 'cooling' | 'cold' {
    return hasOpenPositions ? 'cooling' : 'cold';
  }

  computeNewWarmingSlots(counts: { active: number; warming: number; cooling: number }): number {
    const usable = this.config.maxTracked - this.config.reserveSlots;
    const used = counts.active + counts.warming + counts.cooling;
    return Math.max(0, usable - used);
  }

  selectDemotions(active: MarketRow[], candidates: MarketRow[]): MarketRow[] {
    if (candidates.length === 0) return [];

    // Worst candidate score (the floor for hysteresis comparison)
    const worstCandidateScore = Math.min(...candidates.map(c => c.market_score));
    const hysteresisThreshold = worstCandidateScore * this.config.hysteresisRatio;

    const demotable = active
      .filter(m => !m.has_open_positions)
      .filter(m => m.market_score < hysteresisThreshold)
      .sort((a, b) => a.market_score - b.market_score); // worst first

    return demotable.slice(0, this.config.maxRotationsPerHour);
  }

  selectPromotions(warming: MarketRow[]): MarketRow[] {
    return warming.filter(m =>
      m.bars_24h >= this.config.warmingPromotionBars && m.market_score >= MIN_CANDIDATE_SCORE
    );
  }

  selectCoolingExpired(cooling: MarketRow[]): MarketRow[] {
    const timeoutMs = this.config.coolingTimeoutHours * 3600_000;
    return cooling.filter(m => {
      const elapsed = Date.now() - m.tracking_status_changed_at.getTime();
      return elapsed >= timeoutMs;
    });
  }

  /**
   * Main rotation logic. Called once per hour after scoring.
   */
  async rotate(): Promise<{
    promoted: number;
    demoted: number;
    newWarming: number;
    coolingExpired: number;
  }> {
    const log = logger.child({ name: 'MarketRotator' });

    // Fetch all tracked markets + their position status + bar count
    const trackedResult = await query<MarketRow>(
      `SELECT m.id, m.market_score, m.tracking_status,
              m.tracking_status_changed_at, m.current_price_yes,
              EXISTS(
                SELECT 1 FROM paper_positions pp
                WHERE pp.market_id = m.condition_id
                  AND pp.closed_at IS NULL
              ) as has_open_positions,
              (
                SELECT COUNT(*) FROM price_history ph
                WHERE ph.token_id = m.clob_token_id_yes
                  AND ph.time > NOW() - INTERVAL '24 hours'
              ) as bars_24h
       FROM markets m
       WHERE m.tracking_status IN ('warming', 'active', 'cooling')`
    );

    const tracked = trackedResult.rows.map(r => ({
      ...r,
      market_score: parseFloat(String(r.market_score)),
      bars_24h: parseInt(String(r.bars_24h)),
      has_open_positions: r.has_open_positions === true || r.has_open_positions === 't' as any,
    }));

    const active = tracked.filter(m => m.tracking_status === 'active');
    const warming = tracked.filter(m => m.tracking_status === 'warming');
    const cooling = tracked.filter(m => m.tracking_status === 'cooling');

    const emergency = this.isEmergencyFill(active.length);
    if (emergency) {
      log.warn({ activeCount: active.length }, 'Emergency fill mode — ACTIVE below threshold');
    }

    // Step 1: Expire cooling markets past timeout
    const coolingExpired = this.selectCoolingExpired(cooling);
    for (const m of coolingExpired) {
      await this.setStatus(m.id, 'cold');
      if (m.has_open_positions) {
        log.warn({ marketId: m.id }, 'Cooling timeout with open position — needs stop-loss review');
      }
    }

    // Step 2: Promote warming → active
    const promotions = this.selectPromotions(warming);
    for (const m of promotions) {
      await this.setStatus(m.id, 'active');
    }

    // Step 3: Demote active → cooling/cold (skip in emergency mode)
    let demotions: MarketRow[] = [];
    if (!emergency) {
      // Get top candidates waiting to enter
      const candidateResult = await query<MarketRow>(
        `SELECT id, market_score, tracking_status, tracking_status_changed_at,
                current_price_yes, false as has_open_positions, 0 as bars_24h
         FROM markets
         WHERE tracking_status = 'cold'
           AND is_active = true AND is_resolved = false
           AND clob_token_id_yes IS NOT NULL
           AND market_score >= $1
         ORDER BY market_score DESC
         LIMIT 50`,
        [MIN_CANDIDATE_SCORE]
      );

      const candidates = candidateResult.rows.map(r => ({
        ...r,
        market_score: parseFloat(String(r.market_score)),
        bars_24h: 0,
        has_open_positions: false,
      }));

      demotions = this.selectDemotions(active, candidates);
      for (const m of demotions) {
        const target = this.demotionTarget(m.has_open_positions);
        await this.setStatus(m.id, target);
      }
    }

    // Step 4: Fill warming slots from top cold candidates
    const currentCounts = {
      active: active.length + promotions.length - demotions.length,
      warming: warming.length - promotions.length,
      cooling: cooling.length - coolingExpired.length + demotions.filter(m => m.has_open_positions).length,
    };

    let slotsAvailable = this.computeNewWarmingSlots(currentCounts);
    if (emergency) {
      // In emergency, fill as many as possible
      slotsAvailable = Math.max(slotsAvailable, this.config.emergencyFillThreshold - currentCounts.active);
    }

    let newWarming = 0;
    if (slotsAvailable > 0) {
      const newCandidates = await query<{ id: string; market_score: number }>(
        `SELECT id, market_score FROM markets
         WHERE tracking_status = 'cold'
           AND is_active = true AND is_resolved = false
           AND clob_token_id_yes IS NOT NULL
           AND market_score >= $1
         ORDER BY market_score DESC
         LIMIT $2`,
        [MIN_CANDIDATE_SCORE, slotsAvailable]
      );

      for (const m of newCandidates.rows) {
        await this.setStatus(m.id, 'warming');
        newWarming++;
      }
    }

    log.info({
      active: currentCounts.active,
      warming: currentCounts.warming + newWarming,
      cooling: currentCounts.cooling,
      promoted: promotions.length,
      demoted: demotions.length,
      newWarming,
      coolingExpired: coolingExpired.length,
      emergency,
    }, 'Market rotation complete');

    return {
      promoted: promotions.length,
      demoted: demotions.length,
      newWarming,
      coolingExpired: coolingExpired.length,
    };
  }

  private async setStatus(marketId: string, status: string): Promise<void> {
    await query(
      `UPDATE markets SET tracking_status = $1, tracking_status_changed_at = NOW() WHERE id = $2`,
      [status, marketId]
    );
  }
}
```

**Step 2: Run tests to verify they pass**

Run: `cd packages/data-collector && pnpm test -- --run src/services/MarketRotator.test.ts`
Expected: ALL PASS

**Step 3: Commit**

```bash
git add packages/data-collector/src/services/MarketRotator.ts
git commit -m "feat: implement MarketRotator state machine with hysteresis and position protection"
```

---

## Task 6: Wire Scorer + Rotator into Scheduler

**Files:**
- Modify: `packages/data-collector/src/services/Scheduler.ts`

**Step 1: Import and instantiate**

At the top of `Scheduler.ts`, add imports:

```typescript
import { MarketScorer } from './MarketScorer';
import { MarketRotator } from './MarketRotator';
```

Add class properties (near other collector properties):

```typescript
private marketScorer: MarketScorer;
private marketRotator: MarketRotator;
```

In the constructor, initialize them:

```typescript
this.marketScorer = new MarketScorer();
this.marketRotator = new MarketRotator();
```

**Step 2: Modify syncMarkets() to run scoring + rotation after gamma sync**

Find the `syncMarkets()` method (around line 242-246). Currently:

```typescript
private async syncMarkets(): Promise<void> {
  const result = await this.getGammaCollector().syncMarketsToDb();
  this.log.info(result, 'Markets synced');
}
```

Replace with:

```typescript
private async syncMarkets(): Promise<void> {
  const result = await this.getGammaCollector().syncMarketsToDb();
  this.log.info(result, 'Markets synced from Gamma API');

  // Score all markets after sync
  const scoreResult = await this.marketScorer.scoreAllMarkets();
  this.log.info(scoreResult, 'Markets scored');

  // Rotate tracked markets based on scores
  const rotateResult = await this.marketRotator.rotate();
  this.log.info(rotateResult, 'Market rotation complete');
}
```

**Step 3: Build and verify**

Run: `cd packages/data-collector && pnpm build`
Expected: Compiles without errors

**Step 4: Commit**

```bash
git add packages/data-collector/src/services/Scheduler.ts
git commit -m "feat: wire MarketScorer and MarketRotator into sync-markets job"
```

---

## Task 7: Update ClobCollector Market Selection Queries

**Files:**
- Modify: `packages/data-collector/src/collectors/ClobCollector.ts`

All 5 data collection methods use the same pattern:
```sql
SELECT ... FROM markets
WHERE is_active = true AND clob_token_id_yes IS NOT NULL
ORDER BY volume_24h DESC NULLS LAST
LIMIT ${MAX_TRACKED_MARKETS}
```

Replace ALL 5 with:
```sql
SELECT ... FROM markets
WHERE tracking_status IN ('warming', 'active', 'cooling')
  AND clob_token_id_yes IS NOT NULL
ORDER BY market_score DESC NULLS LAST
```

No `LIMIT` needed — tracking_status already constrains to ~40 markets.

**Step 1: Update `updateAllMarketPrices()` (around line 643-650)**

Change the query from:
```typescript
      `SELECT id, clob_token_id_yes, clob_token_id_no
       FROM markets
       WHERE is_active = true AND clob_token_id_yes IS NOT NULL
       ORDER BY volume_24h DESC NULLS LAST
       ${limitClause}`
```

To:
```typescript
      `SELECT id, clob_token_id_yes, clob_token_id_no
       FROM markets
       WHERE tracking_status IN ('warming', 'active', 'cooling')
         AND clob_token_id_yes IS NOT NULL
       ORDER BY market_score DESC NULLS LAST`
```

**Step 2: Update `syncAllMarketsPriceHistory()` (around line 576-584)** — same change

**Step 3: Update `syncAllOrderBooks()` (around line 530-537)** — same change

**Step 4: Update `syncAllTrades()` (around line 274-280)** — same change

**Step 5: Update `snapshotCurrentPricesToHistory()` (around line 732-741)**

Change from:
```typescript
      `SELECT id, clob_token_id_yes, current_price_yes
       FROM markets
       WHERE is_active = true
         AND clob_token_id_yes IS NOT NULL
         AND current_price_yes IS NOT NULL
         AND current_price_yes > 0
       ORDER BY volume_24h DESC NULLS LAST
       ${limitClause}`
```

To:
```typescript
      `SELECT id, clob_token_id_yes, current_price_yes
       FROM markets
       WHERE tracking_status IN ('warming', 'active', 'cooling')
         AND clob_token_id_yes IS NOT NULL
         AND current_price_yes IS NOT NULL
         AND current_price_yes > 0
       ORDER BY market_score DESC NULLS LAST`
```

**Step 6: Remove unused MAX_TRACKED_MARKETS and limitClause**

At line 13:
```typescript
const MAX_TRACKED_MARKETS = parseInt(process.env.MAX_TRACKED_MARKETS || '0', 10) || undefined;
```

Keep this variable — it's still used by `MarketRotator` via env var. But remove the `limitClause` pattern from the query methods since it's no longer needed.

Find all occurrences of:
```typescript
const limitClause = MAX_TRACKED_MARKETS ? `LIMIT ${MAX_TRACKED_MARKETS}` : '';
```
And remove them from each method.

**Step 7: Build and verify**

Run: `cd packages/data-collector && pnpm build`
Expected: Compiles without errors

**Step 8: Run existing tests**

Run: `cd packages/data-collector && pnpm test -- --run`
Expected: ALL PASS (existing tests should still work)

**Step 9: Commit**

```bash
git add packages/data-collector/src/collectors/ClobCollector.ts
git commit -m "feat: ClobCollector uses tracking_status instead of volume-ordered LIMIT"
```

---

## Task 8: Add Logger Import to MarketScorer and MarketRotator

**Files:**
- Modify: `packages/data-collector/src/services/MarketScorer.ts`
- Modify: `packages/data-collector/src/services/MarketRotator.ts`

**Step 1: Verify logger module location**

Check the import path — data-collector might use `pino` directly or have a logger wrapper. Look at existing services (e.g., `Scheduler.ts`) for the correct import pattern. Common patterns:
- `import logger from '../utils/logger'` (if wrapper exists)
- `import pino from 'pino'; const logger = pino({ name: 'MarketScorer' })` (direct pino)

If no `utils/logger` exists, use the same pattern as `Scheduler.ts`.

**Step 2: Build and verify**

Run: `cd packages/data-collector && pnpm build`
Expected: No errors

**Step 3: Commit if changes were needed**

```bash
git add packages/data-collector/src/services/MarketScorer.ts packages/data-collector/src/services/MarketRotator.ts
git commit -m "fix: correct logger imports for MarketScorer and MarketRotator"
```

---

## Task 9: End-to-End Smoke Test

**Step 1: Run full test suite**

Run: `cd packages/data-collector && pnpm test -- --run`
Expected: ALL PASS

**Step 2: Build the whole monorepo**

Run: `pnpm build` (from repo root)
Expected: No compilation errors

**Step 3: Verify via SSH that migration applies cleanly**

After deploying (CI/CD or manual), SSH to VM and verify:

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c \"SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'markets' AND column_name IN ('market_score', 'tracking_status', 'tracking_status_changed_at');\""
```

Expected: 3 rows showing the new columns

**Step 4: Verify rotation happened**

After one sync-markets cycle (up to 1h, or trigger manually):

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c \"SELECT tracking_status, COUNT(*), AVG(market_score)::numeric(5,3) as avg_score FROM markets WHERE tracking_status != 'cold' GROUP BY tracking_status ORDER BY tracking_status;\""
```

Expected: Rows showing warming/active markets with non-zero scores

**Step 5: Verify signals resume**

After warming markets accumulate 3+ bars (~15 min of data collection):

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker compose -f /home/Usuario/polymarket-trader/docker-compose.gcp.yml logs --tail=50 dashboard-api 2>&1 | grep -E '(active markets|signals generated|Combined signal)'"
```

Expected: `[SignalEngine] Updated active markets: X` where X > 0

**Step 6: Commit any fixes found during smoke test, final commit**

```bash
git add -A
git commit -m "feat: Market Intelligence System Phase 1 complete — smart scoring + dynamic rotation"
```

---

## Summary: File Change Map

| Action | File | Purpose |
|--------|------|---------|
| CREATE | `packages/data-collector/src/database/init/005_market_intelligence.sql` | Migration: new columns + indexes + warm start |
| CREATE | `packages/data-collector/src/services/MarketScorer.ts` | Composite market scoring (5 dimensions) |
| CREATE | `packages/data-collector/src/services/MarketScorer.test.ts` | Unit tests for scoring math |
| CREATE | `packages/data-collector/src/services/MarketRotator.ts` | State machine: cold→warming→active→cooling |
| CREATE | `packages/data-collector/src/services/MarketRotator.test.ts` | Unit tests for rotation logic |
| MODIFY | `packages/data-collector/src/services/Scheduler.ts` | Wire scorer + rotator into sync-markets job |
| MODIFY | `packages/data-collector/src/collectors/ClobCollector.ts` | Use tracking_status filter instead of volume LIMIT |
| MODIFY | `scripts/daily-review-prompt.md` | Phase 3: investigation rule, language rule (ALREADY DONE) |

## Estimated Commits: 8-9
## Estimated Implementation Time: Tasks are independent enough for parallel subagent execution where noted.
