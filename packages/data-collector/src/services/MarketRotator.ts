import { pino } from 'pino';
import { query } from '../database/connection.js';

const logger = pino({ name: 'MarketRotator' });

export const MIN_CANDIDATE_SCORE = 0.15;

/**
 * Parse the ALLOWED_MARKET_TYPES env value into a clean array.
 * Empty / undefined / whitespace-only entries are dropped.
 * An empty result means "no allowlist configured" — the live lane interprets
 * this as unrestricted (backward-compat) and the shadow lane as empty.
 */
export function parseAllowedMarketTypes(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);
}

/**
 * Parse the FORCE_INCLUDE_MARKET_IDS env value into a clean array of market IDs.
 * Empty / undefined / whitespace-only entries are dropped.
 * These IDs are pinned to `active` tracking regardless of score/volume — a
 * measurement instrument for generators whose target markets (tail-band,
 * near-resolution) the merit-based rotator would never surface on its own.
 * Same env var the dashboard's MarketSelector reads, so a single compose entry
 * drives both data collection (here) and signal inclusion (dashboard).
 */
export function parseForceIncludeIds(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);
}

export interface RotationConfig {
  maxTracked: number;              // 40 (from MAX_TRACKED_MARKETS env)
  maxRotationsPerHour: number;     // 5
  warmingPromotionBars: number;    // 3
  coolingTimeoutHours: number;     // 6
  emergencyFillThreshold: number;  // 20
  hysteresisRatio: number;         // 0.60
  reserveSlots: number;            // 2
  warmingStaleHours: number;       // 6 — demote warming with 0 bars after this many hours
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

export interface RotationResult {
  promoted: number;
  demoted: number;
  newWarming: number;
  coolingExpired: number;
  warmingDemoted: number;
}

interface StatusCounts {
  active: number;
  warming: number;
  cooling: number;
}

const DEFAULT_CONFIG: RotationConfig = {
  maxTracked: parseInt(process.env.MAX_TRACKED_MARKETS || '40', 10),
  maxRotationsPerHour: 5,
  warmingPromotionBars: 3,
  coolingTimeoutHours: 6,
  emergencyFillThreshold: 20,
  hysteresisRatio: 0.60,
  reserveSlots: 2,
  warmingStaleHours: 6,
};

export class MarketRotator {
  private liveConfig: RotationConfig;
  private shadowConfig: RotationConfig;
  private allowedTypes: string[];
  // Curated market IDs pinned to `active` regardless of score/volume.
  // Exempt from all demotion paths; promoted by applyForceInclude().
  private forceIncludeIds: Set<string>;
  // The "active" config used by helper methods that read this.config.
  // Mutated by rotate(lane) — safe because rotateAll runs lanes sequentially.
  private config: RotationConfig;

  constructor(
    liveConfig: Partial<RotationConfig> = {},
    shadowConfig: Partial<RotationConfig> = {},
  ) {
    this.liveConfig = { ...DEFAULT_CONFIG, ...liveConfig };
    this.shadowConfig = {
      ...DEFAULT_CONFIG,
      maxTracked: parseInt(process.env.MAX_SHADOW_MARKETS || '10', 10),
      ...shadowConfig,
    };
    this.allowedTypes = parseAllowedMarketTypes(process.env.ALLOWED_MARKET_TYPES);
    this.forceIncludeIds = new Set(parseForceIncludeIds(process.env.FORCE_INCLUDE_MARKET_IDS));
    // Default to live config so any helper called without going through rotate()
    // (e.g. existing tests of selectDemotions/selectPromotions) keep behaving as
    // they did pre-refactor.
    this.config = this.liveConfig;
  }

  getLiveMaxTracked(): number {
    return this.liveConfig.maxTracked;
  }

  getShadowMaxTracked(): number {
    return this.shadowConfig.maxTracked;
  }

  getForceIncludeIds(): string[] {
    return [...this.forceIncludeIds];
  }

  /**
   * Build the SQL fragment that restricts a query to a lane.
   * Returns:
   *   - { sql: 'TRUE', param: null } when the live lane has no allowlist (backward-compat unrestricted).
   *   - { sql: 'FALSE', param: null } when the shadow lane has no non-allowed types to observe.
   *   - { sql: 'market_type = ANY($N::text[])', param: [...] } for live with allowlist.
   *   - { sql: '(market_type IS NULL OR NOT (...))', param: [...] } for shadow with allowlist.
   *
   * The returned `param` (when non-null) must be passed at position `paramIndex` in the query parameters.
   */
  buildLaneClause(
    lane: 'live' | 'shadow',
    paramIndex: number,
  ): { sql: string; param: string[] | null } {
    if (this.allowedTypes.length === 0) {
      return { sql: lane === 'live' ? 'TRUE' : 'FALSE', param: null };
    }
    if (lane === 'live') {
      return {
        sql: `market_type = ANY($${paramIndex}::text[])`,
        param: this.allowedTypes,
      };
    }
    return {
      sql: `(market_type IS NULL OR NOT (market_type = ANY($${paramIndex}::text[])))`,
      param: this.allowedTypes,
    };
  }

  /**
   * Returns true if a market's current price is in the extreme range
   * (near-resolved markets with Yes price <5% or >95%).
   * These markets are untradeable and should not occupy active slots.
   */
  private isExtremePrice(m: MarketRow): boolean {
    if (m.current_price_yes === null) return false;
    return m.current_price_yes < 0.05 || m.current_price_yes > 0.95;
  }

  /**
   * Select active markets to demote. Only demotes markets with no open
   * positions whose score falls below the hysteresis threshold relative
   * to the best waiting candidate. Extreme-price markets (Yes <5% or >95%)
   * are always eligible for demotion regardless of score. Returns worst-first,
   * capped at maxRotationsPerHour.
   */
  selectDemotions(active: MarketRow[], candidates: MarketRow[]): MarketRow[] {
    // Force-included markets are pinned to active — never demote them, even
    // when extreme-priced (their whole purpose is tail-band measurement).
    // Extreme-price markets are force-demoted even without candidates
    const extremeEligible = active.filter(
      m => !m.has_open_positions && !this.forceIncludeIds.has(m.id) && this.isExtremePrice(m),
    );

    if (candidates.length === 0) {
      return extremeEligible
        .sort((a, b) => a.market_score - b.market_score)
        .slice(0, this.config.maxRotationsPerHour);
    }

    // Best candidate score (candidates are expected sorted desc, but be safe)
    const bestCandidateScore = Math.max(...candidates.map(c => c.market_score));
    const threshold = bestCandidateScore * this.config.hysteresisRatio;

    const eligible = active
      .filter(
        m =>
          !m.has_open_positions &&
          !this.forceIncludeIds.has(m.id) &&
          (this.isExtremePrice(m) || m.market_score < threshold),
      )
      .sort((a, b) => a.market_score - b.market_score); // worst first

    return eligible.slice(0, this.config.maxRotationsPerHour);
  }

  /**
   * Select warming markets ready for promotion to active.
   * Requires sufficient price bars, a score above the minimum, and a
   * non-extreme Yes price (5%–95%). Near-resolved markets are excluded
   * to prevent them from filling active tracking slots.
   */
  selectPromotions(warming: MarketRow[]): MarketRow[] {
    return warming.filter(
      m =>
        m.bars_24h >= this.config.warmingPromotionBars &&
        m.market_score >= MIN_CANDIDATE_SCORE &&
        !this.isExtremePrice(m)
    );
  }

  /**
   * Select warming markets that should be demoted back to cold.
   * Two criteria:
   * 1. Extreme price (<5% or >95%) — near resolution, will never be promoted
   * 2. No progress (0 bars in 24h after warmingStaleHours) — data collection failing
   * Markets with open positions are skipped (need price data for position management).
   */
  selectWarmingDemotions(warming: MarketRow[]): MarketRow[] {
    const staleMs = this.config.warmingStaleHours * 3600_000;
    const now = Date.now();

    return warming.filter(m => {
      if (m.has_open_positions) return false;
      // Force-included markets are pinned — never demote, even if stale/extreme.
      if (this.forceIncludeIds.has(m.id)) return false;

      // Criterion 1: extreme price
      if (this.isExtremePrice(m)) return true;

      // Criterion 2: no bars after stale timeout
      const elapsed = now - m.tracking_status_changed_at.getTime();
      if (m.bars_24h === 0 && elapsed >= staleMs) return true;

      return false;
    });
  }

  /**
   * Select cooling markets that have exceeded the cooling timeout.
   * These transition back to cold regardless of position status.
   */
  selectCoolingExpired(cooling: MarketRow[]): MarketRow[] {
    const timeoutMs = this.config.coolingTimeoutHours * 3600_000;
    const now = Date.now();

    return cooling.filter(m => {
      const elapsed = now - m.tracking_status_changed_at.getTime();
      return elapsed >= timeoutMs;
    });
  }

  /**
   * Compute how many new warming slots are available.
   * Reserves some slots for headroom.
   */
  computeNewWarmingSlots(counts: StatusCounts): number {
    const usable = this.config.maxTracked - this.config.reserveSlots;
    const used = counts.active + counts.warming + counts.cooling;
    return Math.max(0, usable - used);
  }

  /**
   * Check whether the system is in emergency fill mode.
   * Emergency mode triggers when active count is dangerously low.
   */
  isEmergencyFill(activeCount: number): boolean {
    return activeCount < this.config.emergencyFillThreshold;
  }

  /**
   * Determine the target status for a demoted market.
   * Markets with open positions go to cooling (grace period);
   * markets without go directly to cold.
   */
  demotionTarget(hasOpenPositions: boolean): 'cooling' | 'cold' {
    return hasOpenPositions ? 'cooling' : 'cold';
  }

  /**
   * Main rotation orchestration.
   * 1. Fetch tracked markets with position status and bar count
   * 2. Expire cooling markets past timeout -> cold
   * 3. Promote warming -> active (if bars >= threshold and score good)
   * 4. Demote active -> cooling/cold (skip in emergency, respect hysteresis)
   * 5. Fill warming slots from top cold candidates by score
   * 6. In emergency: bypass rotation limit, fill aggressively
   */
  async rotate(lane: 'live' | 'shadow'): Promise<RotationResult> {
    // Switch the active config to the lane's config. Helper methods (selectDemotions,
    // selectPromotions, selectWarmingDemotions, computeNewWarmingSlots, isEmergencyFill)
    // read this.config; setting it here keeps them lane-aware without changing
    // their signatures. Safe because rotateAll() invokes lanes sequentially.
    this.config = lane === 'live' ? this.liveConfig : this.shadowConfig;

    const result: RotationResult = {
      promoted: 0,
      demoted: 0,
      newWarming: 0,
      coolingExpired: 0,
      warmingDemoted: 0,
    };

    // Step 1: Fetch tracked markets restricted to the requested lane.
    const trackedLane = this.buildLaneClause(lane, 1);
    const trackedParams = trackedLane.param === null ? [] : [trackedLane.param];
    const trackedRes = await query<MarketRow>(
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
       WHERE m.tracking_status IN ('warming', 'active', 'cooling')
         AND ${trackedLane.sql}`,
      trackedParams,
    );

    const tracked = trackedRes.rows.map(r => ({
      ...r,
      market_score: Number(r.market_score),
      bars_24h: Number(r.bars_24h),
      has_open_positions: Boolean(r.has_open_positions),
    }));

    const active = tracked.filter(m => m.tracking_status === 'active');
    const warming = tracked.filter(m => m.tracking_status === 'warming');
    const cooling = tracked.filter(m => m.tracking_status === 'cooling');

    const emergency = this.isEmergencyFill(active.length);
    if (emergency) {
      logger.warn({ activeCount: active.length }, 'Emergency fill mode — active count below threshold');
    }

    // Step 2: Expire cooling markets
    const expired = this.selectCoolingExpired(cooling);
    for (const m of expired) {
      await this.updateStatus(m.id, 'cold');
      if (m.has_open_positions) {
        logger.warn({ marketId: m.id }, 'Cooling timeout with open position — needs stop-loss review');
      }
      result.coolingExpired++;
    }

    // Step 2b: Demote stuck warming markets → cold
    const warmingDemotions = this.selectWarmingDemotions(warming);
    for (const m of warmingDemotions) {
      await this.updateStatus(m.id, 'cold');
      result.warmingDemoted++;
    }

    // Step 3: Promote warming -> active
    const promoted = this.selectPromotions(warming);
    for (const m of promoted) {
      await this.updateStatus(m.id, 'active');
      result.promoted++;
    }

    // Step 4: Fetch cold candidates for demotion comparison and warming fill,
    // restricted to the requested lane.
    // Extreme-price markets (Yes <5% or >95%) are excluded at the source:
    // MarketScorer can give them scores of 0.8+ via volume/liquidity alone, and
    // without this filter they dominate the top of the candidate ranking and
    // starve tradeable markets from all warming slots. Null price is treated as
    // non-extreme (safe default, consistent with isExtremePrice in demotion).
    const candidateLane = this.buildLaneClause(lane, 2);
    const candidateParams: unknown[] = [MIN_CANDIDATE_SCORE];
    if (candidateLane.param !== null) candidateParams.push(candidateLane.param);

    const candidateRes = await query<MarketRow>(
      `SELECT id, market_score, tracking_status, tracking_status_changed_at,
              current_price_yes, false as has_open_positions, 0 as bars_24h
       FROM markets
       WHERE tracking_status = 'cold'
         AND is_active = true AND is_resolved = false
         AND clob_token_id_yes IS NOT NULL
         AND market_score >= $1
         AND (current_price_yes IS NULL OR (current_price_yes >= 0.05 AND current_price_yes <= 0.95))
         AND (end_date IS NULL OR end_date > NOW())
         AND ${candidateLane.sql}
       ORDER BY market_score DESC
       LIMIT 50`,
      candidateParams,
    );

    const candidates = candidateRes.rows.map(r => ({
      ...r,
      market_score: Number(r.market_score),
      bars_24h: Number(r.bars_24h),
      has_open_positions: Boolean(r.has_open_positions),
    }));

    // Step 5: Demote active (skip in emergency)
    if (!emergency) {
      const demotions = this.selectDemotions(active, candidates);
      for (const m of demotions) {
        const target = this.demotionTarget(m.has_open_positions);
        await this.updateStatus(m.id, target);
        result.demoted++;
      }
    }

    // Step 6: Fill warming slots from cold candidates
    const currentCounts: StatusCounts = {
      active: active.length + result.promoted - result.demoted,
      warming: warming.length - result.promoted - result.warmingDemoted,
      cooling: cooling.length - result.coolingExpired,
    };

    let slotsAvailable = this.computeNewWarmingSlots(currentCounts);

    // In emergency, be more aggressive — fill up to double the normal limit
    if (emergency) {
      slotsAvailable = Math.max(slotsAvailable, this.config.maxRotationsPerHour * 2);
    }

    const toWarm = candidates.slice(0, slotsAvailable);
    for (const m of toWarm) {
      await this.updateStatus(m.id, 'warming');
      result.newWarming++;
    }

    logger.info(
      {
        lane,
        promoted: result.promoted,
        demoted: result.demoted,
        newWarming: result.newWarming,
        coolingExpired: result.coolingExpired,
        warmingDemoted: result.warmingDemoted,
        activeCount: active.length + result.promoted - result.demoted,
        emergency,
      },
      'Market rotation complete',
    );

    return result;
  }

  /**
   * Promote the FORCE_INCLUDE_MARKET_IDS cohort to `active` tracking.
   *
   * The merit-based rotator ranks cold candidates by market_score, which is
   * volume/tradeability-biased: tail-band and near-resolution markets score low
   * and are never promoted. That starves the Sprint 2 generators
   * (favorite_longshot_bias) of their target markets, so they cannot accumulate
   * the sample size needed for cost-aware edge measurement. This bypass pins a
   * curated cohort to `active` directly.
   *
   * Only valid markets are promoted — active, not resolved, not past end_date.
   * Already-active markets and the eviction step keep resolved cohort markets
   * from being re-promoted. No-op when the env var is unset.
   *
   * @returns number of markets transitioned to `active`.
   */
  async applyForceInclude(): Promise<number> {
    if (this.forceIncludeIds.size === 0) return 0;

    const ids = [...this.forceIncludeIds];
    const res = await query(
      `UPDATE markets SET tracking_status = 'active', tracking_status_changed_at = NOW()
       WHERE id = ANY($1::text[])
         AND tracking_status <> 'active'
         AND is_active = true AND is_resolved = false
         AND (end_date IS NULL OR end_date > NOW())`,
      [ids],
    );

    const promoted = res.rowCount ?? 0;
    if (promoted > 0) {
      logger.info({ promoted, forceIncludeIds: ids }, 'Force-included markets promoted to active');
    }
    return promoted;
  }

  /**
   * Run rotation for both lanes sequentially. Live lane operates on
   * ALLOWED_MARKET_TYPES; shadow lane operates on the complement (plus NULL).
   * Sequential because parallelism here yields no measurable benefit and would
   * complicate lock contention on the markets table.
   */
  async rotateAll(): Promise<{ live: RotationResult; shadow: RotationResult }> {
    // Evict markets whose end_date has passed before running either lane.
    // Expired markets can't be traded, but without this step they hold warming/active
    // slots indefinitely because the demotion logic only checks score and price.
    await query(
      `UPDATE markets SET tracking_status = 'cold', tracking_status_changed_at = NOW()
       WHERE tracking_status IN ('warming', 'active', 'cooling')
         AND end_date IS NOT NULL AND end_date < NOW()`,
    );
    // Also evict null-end_date markets with no price data for 24h+ that have been
    // in their status ≥ 6h. Catches markets that expired without setting end_date
    // (e.g. question text references a past date but market was never resolved).
    await query(
      `UPDATE markets SET tracking_status = 'cold', tracking_status_changed_at = NOW()
       WHERE tracking_status IN ('warming', 'active', 'cooling')
         AND end_date IS NULL
         AND clob_token_id_yes IS NOT NULL
         AND tracking_status_changed_at < NOW() - INTERVAL '6 hours'
         AND NOT EXISTS (
           SELECT 1 FROM price_history ph
           WHERE ph.token_id = markets.clob_token_id_yes
             AND ph.time > NOW() - INTERVAL '24 hours'
         )`,
    );
    // Pin the force-include cohort to `active` after eviction (so resolved
    // cohort markets are not re-promoted) and before the lanes run (so the
    // demotion logic sees them as active and the exemption applies).
    await this.applyForceInclude();
    const live = await this.rotate('live');
    const shadow = await this.rotate('shadow');
    return { live, shadow };
  }

  private async updateStatus(marketId: string, status: string): Promise<void> {
    await query(
      `UPDATE markets SET tracking_status = $1, tracking_status_changed_at = NOW() WHERE id = $2`,
      [status, marketId]
    );
  }
}
