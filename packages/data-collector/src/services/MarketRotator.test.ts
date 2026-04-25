import { describe, it, expect, beforeEach, vi } from 'vitest';
import { query } from '../database/connection.js';
import {
  MarketRotator,
  type RotationConfig,
  type MarketRow,
  parseAllowedMarketTypes,
} from './MarketRotator.js';

vi.mock('../database/connection.js', () => ({
  query: vi.fn(),
}));

const mockedQuery = vi.mocked(query);

describe('parseAllowedMarketTypes', () => {
  it('returns empty array when env is undefined', () => {
    expect(parseAllowedMarketTypes(undefined)).toEqual([]);
  });

  it('returns empty array when env is empty string', () => {
    expect(parseAllowedMarketTypes('')).toEqual([]);
  });

  it('parses single value', () => {
    expect(parseAllowedMarketTypes('crypto_intraday')).toEqual(['crypto_intraday']);
  });

  it('parses comma-separated values', () => {
    expect(parseAllowedMarketTypes('crypto_intraday,crypto_daily,event_short')).toEqual([
      'crypto_intraday',
      'crypto_daily',
      'event_short',
    ]);
  });

  it('trims whitespace around values', () => {
    expect(parseAllowedMarketTypes(' crypto_intraday , event_short ')).toEqual([
      'crypto_intraday',
      'event_short',
    ]);
  });

  it('drops empty entries from trailing or duplicate commas', () => {
    expect(parseAllowedMarketTypes('crypto_intraday,,event_short,')).toEqual([
      'crypto_intraday',
      'event_short',
    ]);
  });
});

const DEFAULT_CONFIG: RotationConfig = {
  maxTracked: 40,
  maxRotationsPerHour: 5,
  warmingPromotionBars: 3,
  coolingTimeoutHours: 6,
  emergencyFillThreshold: 20,
  hysteresisRatio: 0.60,
  reserveSlots: 2,
  warmingStaleHours: 6,
};

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

describe('MarketRotator', () => {
  let rotator: MarketRotator;

  beforeEach(() => {
    vi.clearAllMocks();
    rotator = new MarketRotator(DEFAULT_CONFIG);
  });

  describe('constructor', () => {
    it('accepts a separate shadow config with its own maxTracked', () => {
      const r = new MarketRotator(
        { maxTracked: 40 },
        { maxTracked: 7 },
      );
      expect(r.getLiveMaxTracked()).toBe(40);
      expect(r.getShadowMaxTracked()).toBe(7);
    });

    it('shadow config defaults maxTracked from MAX_SHADOW_MARKETS env', () => {
      vi.stubEnv('MAX_SHADOW_MARKETS', '15');
      const r = new MarketRotator();
      expect(r.getShadowMaxTracked()).toBe(15);
      vi.unstubAllEnvs();
    });

    it('shadow config defaults maxTracked to 10 when env unset', () => {
      vi.unstubAllEnvs();
      const r = new MarketRotator();
      expect(r.getShadowMaxTracked()).toBe(10);
    });
  });

  // ── selectDemotions ──────────────────────────────────────────────

  describe('selectDemotions', () => {
    it('demotes ACTIVE market with low score when better candidates wait', () => {
      const active = [
        makeMarket({ id: 'weak', market_score: 0.10, tracking_status: 'active', has_open_positions: false }),
      ];
      const candidates = [
        makeMarket({ id: 'strong-candidate', market_score: 0.90, tracking_status: 'cold' }),
      ];
      const result = rotator.selectDemotions(active, candidates);
      expect(result.map(m => m.id)).toContain('weak');
    });

    it('does NOT demote ACTIVE market with open positions', () => {
      const active = [
        makeMarket({ id: 'has-pos', market_score: 0.05, tracking_status: 'active', has_open_positions: true }),
      ];
      const candidates = [
        makeMarket({ id: 'better', market_score: 0.95, tracking_status: 'cold' }),
      ];
      const result = rotator.selectDemotions(active, candidates);
      expect(result).toHaveLength(0);
    });

    it('force-demotes extreme-price active market (price >0.95) even with high score', () => {
      const active = [
        makeMarket({ id: 'near-resolved', market_score: 0.90, tracking_status: 'active', current_price_yes: 0.98, has_open_positions: false }),
        makeMarket({ id: 'near-resolved-low', market_score: 0.88, tracking_status: 'active', current_price_yes: 0.002, has_open_positions: false }),
        makeMarket({ id: 'tradeable', market_score: 0.80, tracking_status: 'active', current_price_yes: 0.50, has_open_positions: false }),
      ];
      const candidates = [
        makeMarket({ id: 'cand', market_score: 0.70, tracking_status: 'cold' }),
      ];
      const result = rotator.selectDemotions(active, candidates);
      const ids = result.map(m => m.id);
      expect(ids).toContain('near-resolved');
      expect(ids).toContain('near-resolved-low');
      expect(ids).not.toContain('tradeable');
    });

    it('force-demotes extreme-price market even when no candidates exist', () => {
      const active = [
        makeMarket({ id: 'extreme', market_score: 0.90, tracking_status: 'active', current_price_yes: 0.97, has_open_positions: false }),
      ];
      const result = rotator.selectDemotions(active, []);
      expect(result.map(m => m.id)).toContain('extreme');
    });

    it('does NOT force-demote extreme-price market with open positions', () => {
      const active = [
        makeMarket({ id: 'extreme-pos', market_score: 0.90, tracking_status: 'active', current_price_yes: 0.99, has_open_positions: true }),
      ];
      const result = rotator.selectDemotions(active, []);
      expect(result).toHaveLength(0);
    });

    it('treats null current_price_yes as non-extreme (safe default)', () => {
      const active = [
        makeMarket({ id: 'null-price', market_score: 0.90, tracking_status: 'active', current_price_yes: null, has_open_positions: false }),
      ];
      // Null price should NOT be force-demoted (we don't know if it's extreme)
      const result = rotator.selectDemotions(active, []);
      expect(result).toHaveLength(0);
    });

    it('applies hysteresis — only demotes if score < worstCandidateScore * 0.60', () => {
      // Candidate score = 0.50, threshold = 0.50 * 0.60 = 0.30
      // Active score = 0.29 → below threshold → demote
      const active = [
        makeMarket({ id: 'borderline-low', market_score: 0.29, tracking_status: 'active', has_open_positions: false }),
      ];
      const candidates = [
        makeMarket({ id: 'cand', market_score: 0.50, tracking_status: 'cold' }),
      ];
      const result = rotator.selectDemotions(active, candidates);
      expect(result.map(m => m.id)).toContain('borderline-low');

      // Active score = 0.31 → above threshold → do NOT demote
      const activeAbove = [
        makeMarket({ id: 'borderline-high', market_score: 0.31, tracking_status: 'active', has_open_positions: false }),
      ];
      const result2 = rotator.selectDemotions(activeAbove, candidates);
      expect(result2).toHaveLength(0);
    });

    it('respects maxRotationsPerHour limit', () => {
      const active = Array.from({ length: 10 }, (_, i) =>
        makeMarket({
          id: `weak-${i}`,
          market_score: 0.01,
          tracking_status: 'active',
          has_open_positions: false,
        })
      );
      const candidates = [
        makeMarket({ id: 'great', market_score: 0.99, tracking_status: 'cold' }),
      ];
      const result = rotator.selectDemotions(active, candidates);
      expect(result.length).toBeLessThanOrEqual(DEFAULT_CONFIG.maxRotationsPerHour);
    });

    it('returns empty when no candidates exist', () => {
      const active = [
        makeMarket({ id: 'low', market_score: 0.05, tracking_status: 'active', has_open_positions: false }),
      ];
      const result = rotator.selectDemotions(active, []);
      expect(result).toHaveLength(0);
    });

    it('sorts demotions worst-first', () => {
      const active = [
        makeMarket({ id: 'mid', market_score: 0.08, tracking_status: 'active', has_open_positions: false }),
        makeMarket({ id: 'worst', market_score: 0.02, tracking_status: 'active', has_open_positions: false }),
        makeMarket({ id: 'bad', market_score: 0.05, tracking_status: 'active', has_open_positions: false }),
      ];
      const candidates = [
        makeMarket({ id: 'cand', market_score: 0.95, tracking_status: 'cold' }),
      ];
      const result = rotator.selectDemotions(active, candidates);
      expect(result[0].id).toBe('worst');
    });
  });

  // ── selectPromotions ─────────────────────────────────────────────

  describe('selectPromotions', () => {
    it('promotes WARMING with bars_24h >= 3 and good score', () => {
      const warming = [
        makeMarket({ id: 'ready', market_score: 0.60, tracking_status: 'warming', bars_24h: 5 }),
      ];
      const result = rotator.selectPromotions(warming);
      expect(result.map(m => m.id)).toContain('ready');
    });

    it('does NOT promote with insufficient bars (<3)', () => {
      const warming = [
        makeMarket({ id: 'not-ready', market_score: 0.70, tracking_status: 'warming', bars_24h: 2 }),
      ];
      const result = rotator.selectPromotions(warming);
      expect(result).toHaveLength(0);
    });

    it('does NOT promote if score decayed below MIN_CANDIDATE_SCORE (0.15)', () => {
      const warming = [
        makeMarket({ id: 'decayed', market_score: 0.10, tracking_status: 'warming', bars_24h: 10 }),
      ];
      const result = rotator.selectPromotions(warming);
      expect(result).toHaveLength(0);
    });

    it('promotes exactly at bar threshold', () => {
      const warming = [
        makeMarket({ id: 'exact', market_score: 0.50, tracking_status: 'warming', bars_24h: 3 }),
      ];
      const result = rotator.selectPromotions(warming);
      expect(result.map(m => m.id)).toContain('exact');
    });

    it('does NOT promote warming market with extreme Yes price (>0.95)', () => {
      const warming = [
        makeMarket({ id: 'near-yes', market_score: 0.80, tracking_status: 'warming', bars_24h: 5, current_price_yes: 0.97 }),
      ];
      const result = rotator.selectPromotions(warming);
      expect(result).toHaveLength(0);
    });

    it('does NOT promote warming market with extreme No price (Yes <0.05)', () => {
      const warming = [
        makeMarket({ id: 'near-no', market_score: 0.80, tracking_status: 'warming', bars_24h: 5, current_price_yes: 0.003 }),
      ];
      const result = rotator.selectPromotions(warming);
      expect(result).toHaveLength(0);
    });

    it('promotes warming market at price boundary (exactly 0.05 and 0.95)', () => {
      const warming = [
        makeMarket({ id: 'lo-boundary', market_score: 0.60, tracking_status: 'warming', bars_24h: 5, current_price_yes: 0.05 }),
        makeMarket({ id: 'hi-boundary', market_score: 0.60, tracking_status: 'warming', bars_24h: 5, current_price_yes: 0.95 }),
      ];
      const result = rotator.selectPromotions(warming);
      expect(result.map(m => m.id)).toContain('lo-boundary');
      expect(result.map(m => m.id)).toContain('hi-boundary');
    });

    it('promotes warming market with null price (no price data yet)', () => {
      const warming = [
        makeMarket({ id: 'no-price', market_score: 0.60, tracking_status: 'warming', bars_24h: 5, current_price_yes: null }),
      ];
      const result = rotator.selectPromotions(warming);
      expect(result.map(m => m.id)).toContain('no-price');
    });
  });

  // ── selectCoolingExpired ─────────────────────────────────────────

  describe('selectCoolingExpired', () => {
    it('expires COOLING after 6h timeout', () => {
      const cooling = [
        makeMarket({
          id: 'old-cool',
          tracking_status: 'cooling',
          tracking_status_changed_at: new Date(Date.now() - 7 * 3600_000), // 7h ago
          has_open_positions: true, // should still expire regardless
        }),
      ];
      const result = rotator.selectCoolingExpired(cooling);
      expect(result.map(m => m.id)).toContain('old-cool');
    });

    it('does NOT expire before timeout', () => {
      const cooling = [
        makeMarket({
          id: 'recent-cool',
          tracking_status: 'cooling',
          tracking_status_changed_at: new Date(Date.now() - 2 * 3600_000), // 2h ago
        }),
      ];
      const result = rotator.selectCoolingExpired(cooling);
      expect(result).toHaveLength(0);
    });

    it('expires exactly at threshold', () => {
      const cooling = [
        makeMarket({
          id: 'exact-cool',
          tracking_status: 'cooling',
          tracking_status_changed_at: new Date(Date.now() - 6 * 3600_000 - 1), // just past 6h
        }),
      ];
      const result = rotator.selectCoolingExpired(cooling);
      expect(result.map(m => m.id)).toContain('exact-cool');
    });
  });

  // ── computeNewWarmingSlots ───────────────────────────────────────

  describe('computeNewWarmingSlots', () => {
    it('returns available capacity (maxTracked - reserveSlots - used)', () => {
      // maxTracked=40, reserveSlots=2, usable=38
      const result = rotator.computeNewWarmingSlots({ active: 25, warming: 5, cooling: 3 });
      expect(result).toBe(38 - 25 - 5 - 3); // 5
    });

    it('returns 0 when at capacity', () => {
      const result = rotator.computeNewWarmingSlots({ active: 30, warming: 5, cooling: 5 });
      expect(result).toBe(0);
    });

    it('returns 0 when over capacity (does not go negative)', () => {
      const result = rotator.computeNewWarmingSlots({ active: 35, warming: 5, cooling: 5 });
      expect(result).toBe(0);
    });
  });

  // ── isEmergencyFill ──────────────────────────────────────────────

  describe('isEmergencyFill', () => {
    it('true when activeCount < emergencyFillThreshold (20)', () => {
      expect(rotator.isEmergencyFill(10)).toBe(true);
      expect(rotator.isEmergencyFill(19)).toBe(true);
    });

    it('false when >= threshold', () => {
      expect(rotator.isEmergencyFill(20)).toBe(false);
      expect(rotator.isEmergencyFill(30)).toBe(false);
    });
  });

  // ── demotionTarget ──────────────────────────────────────────────

  describe('demotionTarget', () => {
    it('returns cooling if has open positions', () => {
      expect(rotator.demotionTarget(true)).toBe('cooling');
    });

    it('returns cold if no positions', () => {
      expect(rotator.demotionTarget(false)).toBe('cold');
    });
  });

  // ── selectWarmingDemotions ───────────────────────────────────────

  describe('selectWarmingDemotions', () => {
    it('returns empty for warming markets with normal prices and bars', () => {
      const warming = [
        makeMarket({ id: 'healthy', tracking_status: 'warming', current_price_yes: 0.50, bars_24h: 5, tracking_status_changed_at: new Date(Date.now() - 8 * 3600_000) }),
      ];
      const result = rotator.selectWarmingDemotions(warming);
      expect(result).toHaveLength(0);
    });

    it('demotes warming market with extreme low price (<0.05)', () => {
      const warming = [
        makeMarket({ id: 'near-no', tracking_status: 'warming', current_price_yes: 0.02, bars_24h: 5 }),
      ];
      const result = rotator.selectWarmingDemotions(warming);
      expect(result.map(m => m.id)).toContain('near-no');
    });

    it('demotes warming market with extreme high price (>0.95)', () => {
      const warming = [
        makeMarket({ id: 'near-yes', tracking_status: 'warming', current_price_yes: 0.98, bars_24h: 5 }),
      ];
      const result = rotator.selectWarmingDemotions(warming);
      expect(result.map(m => m.id)).toContain('near-yes');
    });

    it('demotes warming market with 0 bars after 6h', () => {
      const warming = [
        makeMarket({ id: 'stale', tracking_status: 'warming', current_price_yes: 0.50, bars_24h: 0, tracking_status_changed_at: new Date(Date.now() - 7 * 3600_000) }),
      ];
      const result = rotator.selectWarmingDemotions(warming);
      expect(result.map(m => m.id)).toContain('stale');
    });

    it('does NOT demote warming with 0 bars if only 2h old (below stale threshold)', () => {
      const warming = [
        makeMarket({ id: 'young', tracking_status: 'warming', current_price_yes: 0.50, bars_24h: 0, tracking_status_changed_at: new Date(Date.now() - 2 * 3600_000) }),
      ];
      const result = rotator.selectWarmingDemotions(warming);
      expect(result).toHaveLength(0);
    });

    it('does NOT demote warming with open positions even if extreme price', () => {
      const warming = [
        makeMarket({ id: 'extreme-pos', tracking_status: 'warming', current_price_yes: 0.99, bars_24h: 0, has_open_positions: true }),
      ];
      const result = rotator.selectWarmingDemotions(warming);
      expect(result).toHaveLength(0);
    });

    it('does NOT demote warming with bars > 0 even if old', () => {
      const warming = [
        makeMarket({ id: 'old-with-bars', tracking_status: 'warming', current_price_yes: 0.50, bars_24h: 1, tracking_status_changed_at: new Date(Date.now() - 24 * 3600_000) }),
      ];
      const result = rotator.selectWarmingDemotions(warming);
      expect(result).toHaveLength(0);
    });
  });

  // ── buildLaneClause ──────────────────────────────────────────────

  describe('buildLaneClause', () => {
    beforeEach(() => {
      vi.unstubAllEnvs();
    });

    it('live lane with empty allowed → "TRUE" (unrestricted, no param)', () => {
      const r = new MarketRotator();
      const clause = r.buildLaneClause('live', 5);
      expect(clause).toEqual({ sql: 'TRUE', param: null });
    });

    it('shadow lane with empty allowed → "FALSE" (matches nothing, no param)', () => {
      const r = new MarketRotator();
      const clause = r.buildLaneClause('shadow', 5);
      expect(clause).toEqual({ sql: 'FALSE', param: null });
    });

    it('live lane with allowed types → ANY clause with param at given index', () => {
      vi.stubEnv('ALLOWED_MARKET_TYPES', 'crypto_intraday,event_short');
      const r = new MarketRotator();
      const clause = r.buildLaneClause('live', 2);
      expect(clause.sql).toBe('market_type = ANY($2::text[])');
      expect(clause.param).toEqual(['crypto_intraday', 'event_short']);
    });

    it('shadow lane with allowed types → NOT IN clause that also catches NULL', () => {
      vi.stubEnv('ALLOWED_MARKET_TYPES', 'crypto_intraday,event_short');
      const r = new MarketRotator();
      const clause = r.buildLaneClause('shadow', 3);
      expect(clause.sql).toBe('(market_type IS NULL OR NOT (market_type = ANY($3::text[])))');
      expect(clause.param).toEqual(['crypto_intraday', 'event_short']);
    });
  });

  // ── rotate (integration with DB mock) ───────────────────────────

  describe('rotate()', () => {
    it('orchestrates a full rotation cycle', async () => {
      const trackedRows = [
        // An active market with low score, no positions
        makeMarket({ id: 'active-weak', market_score: 0.05, tracking_status: 'active', has_open_positions: false, bars_24h: 10 }),
        // A warming market ready to promote
        makeMarket({ id: 'warming-ready', market_score: 0.70, tracking_status: 'warming', bars_24h: 5 }),
        // A cooling market past timeout
        makeMarket({
          id: 'cooling-old',
          market_score: 0.20,
          tracking_status: 'cooling',
          tracking_status_changed_at: new Date(Date.now() - 7 * 3600_000),
        }),
        // 25 more active markets to avoid emergency
        ...Array.from({ length: 25 }, (_, i) =>
          makeMarket({ id: `active-${i}`, market_score: 0.60, tracking_status: 'active', bars_24h: 10 })
        ),
      ];

      const candidateRows = [
        makeMarket({ id: 'cold-good', market_score: 0.85, tracking_status: 'cold' }),
        makeMarket({ id: 'cold-ok', market_score: 0.50, tracking_status: 'cold' }),
      ];

      const updateResult = { rows: [], command: 'UPDATE', rowCount: 1, oid: 0, fields: [] };

      // Route queries by SQL content
      mockedQuery.mockImplementation(async (sql: string) => {
        if (typeof sql === 'string' && sql.includes('tracking_status IN')) {
          return { rows: trackedRows, command: 'SELECT', rowCount: trackedRows.length, oid: 0, fields: [] };
        }
        if (typeof sql === 'string' && sql.includes("tracking_status = 'cold'")) {
          return { rows: candidateRows, command: 'SELECT', rowCount: candidateRows.length, oid: 0, fields: [] };
        }
        return updateResult;
      });

      const result = await rotator.rotate();

      expect(result.coolingExpired).toBeGreaterThanOrEqual(1);
      expect(result.promoted).toBeGreaterThanOrEqual(1);
      // active-weak should be demoted since candidate score 0.85 * 0.60 = 0.51 > 0.05
      expect(result.demoted).toBeGreaterThanOrEqual(1);
      expect(result.newWarming).toBeGreaterThanOrEqual(1);
    });

    it('excludes extreme-price (untradeable) markets from cold candidate query', async () => {
      // Rationale: the rotator ranks cold candidates by market_score DESC and fills
      // warming slots with the top N. Prior to this gate, markets with prices <5% or
      // >95% were scoring 0.8+ on volume/liquidity alone (tradeability = 0 is not
      // sufficient to exclude them from the ranking). They starved tradeable markets
      // from all warming slots — crypto markets received zero price data for 9+ days
      // because every warming slot was consumed by extreme-price event markets.
      //
      // Fix: the candidate SQL must filter out extreme-price markets at the source.
      const trackedRows = Array.from({ length: 25 }, (_, i) =>
        makeMarket({ id: `active-${i}`, market_score: 0.60, tracking_status: 'active', bars_24h: 10 })
      );

      let candidateSql: string | null = null;

      mockedQuery.mockImplementation(async (sql: string) => {
        if (typeof sql === 'string' && sql.includes('tracking_status IN')) {
          return { rows: trackedRows, command: 'SELECT', rowCount: trackedRows.length, oid: 0, fields: [] };
        }
        if (typeof sql === 'string' && sql.includes("tracking_status = 'cold'")) {
          candidateSql = sql;
          return { rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] };
        }
        return { rows: [], command: 'UPDATE', rowCount: 0, oid: 0, fields: [] };
      });

      await rotator.rotate();

      expect(candidateSql).not.toBeNull();
      // Must reference current_price_yes in a filter clause
      expect(candidateSql).toMatch(/current_price_yes/i);
      // Must bound the tradeable range: lower bound in [0.05, 0.06], upper in [0.94, 0.95]
      expect(candidateSql).toMatch(/0\.0[56]/);
      expect(candidateSql).toMatch(/0\.9[45]/);
    });

    it('skips demotions in emergency mode', async () => {
      const trackedRows = [
        makeMarket({ id: 'active-weak', market_score: 0.05, tracking_status: 'active', has_open_positions: false, bars_24h: 10 }),
        ...Array.from({ length: 4 }, (_, i) =>
          makeMarket({ id: `active-${i}`, market_score: 0.60, tracking_status: 'active', bars_24h: 10 })
        ),
      ];

      const candidateRows = Array.from({ length: 20 }, (_, i) =>
        makeMarket({ id: `cold-${i}`, market_score: 0.50 + i * 0.01, tracking_status: 'cold' })
      );

      const updateResult = { rows: [], command: 'UPDATE', rowCount: 1, oid: 0, fields: [] };

      mockedQuery.mockImplementation(async (sql: string) => {
        if (typeof sql === 'string' && sql.includes('tracking_status IN')) {
          return { rows: trackedRows, command: 'SELECT', rowCount: trackedRows.length, oid: 0, fields: [] };
        }
        if (typeof sql === 'string' && sql.includes("tracking_status = 'cold'")) {
          return { rows: candidateRows, command: 'SELECT', rowCount: candidateRows.length, oid: 0, fields: [] };
        }
        return updateResult;
      });

      const result = await rotator.rotate();

      // No demotions in emergency mode
      expect(result.demoted).toBe(0);
      // Should fill aggressively
      expect(result.newWarming).toBeGreaterThan(0);
    });
  });
});
