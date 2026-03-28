import { pino } from 'pino';
import { query } from '../database/connection.js';

const logger = pino({ name: 'MarketRotator' });

export const MIN_CANDIDATE_SCORE = 0.15;

export interface RotationConfig {
  maxTracked: number;              // 40 (from MAX_TRACKED_MARKETS env)
  maxRotationsPerHour: number;     // 5
  warmingPromotionBars: number;    // 3
  coolingTimeoutHours: number;     // 6
  emergencyFillThreshold: number;  // 20
  hysteresisRatio: number;         // 0.60
  reserveSlots: number;            // 2
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
};

export class MarketRotator {
  private config: RotationConfig;

  constructor(config: Partial<RotationConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
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
    // Extreme-price markets are force-demoted even without candidates
    const extremeEligible = active.filter(m => !m.has_open_positions && this.isExtremePrice(m));

    if (candidates.length === 0) {
      return extremeEligible
        .sort((a, b) => a.market_score - b.market_score)
        .slice(0, this.config.maxRotationsPerHour);
    }

    // Best candidate score (candidates are expected sorted desc, but be safe)
    const bestCandidateScore = Math.max(...candidates.map(c => c.market_score));
    const threshold = bestCandidateScore * this.config.hysteresisRatio;

    const eligible = active
      .filter(m => !m.has_open_positions && (this.isExtremePrice(m) || m.market_score < threshold))
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
  async rotate(): Promise<RotationResult> {
    const result: RotationResult = {
      promoted: 0,
      demoted: 0,
      newWarming: 0,
      coolingExpired: 0,
    };

    // Step 1: Fetch tracked markets
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
       WHERE m.tracking_status IN ('warming', 'active', 'cooling')`
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

    // Step 3: Promote warming -> active
    const promoted = this.selectPromotions(warming);
    for (const m of promoted) {
      await this.updateStatus(m.id, 'active');
      result.promoted++;
    }

    // Step 4: Fetch cold candidates for demotion comparison and warming fill
    const candidateRes = await query<MarketRow>(
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
      warming: warming.length - result.promoted,
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
        promoted: result.promoted,
        demoted: result.demoted,
        newWarming: result.newWarming,
        coolingExpired: result.coolingExpired,
        activeCount: active.length + result.promoted - result.demoted,
        emergency,
      },
      'Market rotation complete'
    );

    return result;
  }

  private async updateStatus(marketId: string, status: string): Promise<void> {
    await query(
      `UPDATE markets SET tracking_status = $1, tracking_status_changed_at = NOW() WHERE id = $2`,
      [status, marketId]
    );
  }
}
