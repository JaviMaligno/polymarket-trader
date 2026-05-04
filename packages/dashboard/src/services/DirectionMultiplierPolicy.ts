export type DirectionDurationBand = 'intraday' | 'short' | 'medium' | 'long';

export interface DirectionMultiplierContext {
  marketType?: string;
  currentPrice: number;
  endDate?: Date | null;
  question?: string;
  currentTime?: Date;
}

export interface DirectionMultiplierSegment {
  id: string;
  multiplier: number;
  marketTypes?: string[];
  priceRange?: {
    min?: number;
    max?: number;
  };
  durationBands?: DirectionDurationBand[];
  questionPatterns?: string[];
  rationale?: string;
}

export interface DirectionMultiplierPolicy {
  global: number;
  perMarketType?: Record<string, number>;
  minMultiplier?: number;
  maxMultiplier?: number;
  segments: DirectionMultiplierSegment[];
}

export interface ResolvedDirectionMultiplier {
  multiplier: number;
  contextKey: string;
  segmentId: string | null;
}

const DEFAULT_MIN_MULTIPLIER = -1.0;
const DEFAULT_MAX_MULTIPLIER = 1.0;
export const DIRECTION_PRICE_BUCKETS = [
  { label: 'lt20', min: 0, max: 0.2 },
  { label: '20to40', min: 0.2, max: 0.4 },
  { label: '40to60', min: 0.4, max: 0.6 },
  { label: '60to80', min: 0.6, max: 0.8 },
  { label: 'gte80', min: 0.8, max: 1.01 },
] as const;

// 2026-05-04: flipped from -1.0 → +1.0 after empirical analysis showed the
// system was operating with inverted direction. n=386 trades (post-2026-04-07
// reset) produced 13.5% WR with dm=-1; the counter-direction would have hit
// 84.7% WR. The "91.5% accuracy when flipped" cited in CLAUDE.md was true at
// the time of measurement, but signal-generator changes since then made the
// raw outputs already correctly directional, so the -1 flip became a
// double-flip. New baseline: +1 (no flip).
export const DEFAULT_DIRECTION_MULTIPLIER_POLICY: DirectionMultiplierPolicy = {
  global: 1.0,
  minMultiplier: DEFAULT_MIN_MULTIPLIER,
  maxMultiplier: DEFAULT_MAX_MULTIPLIER,
  segments: [],
};

export function clampDirectionMultiplier(
  value: number,
  policy: Pick<DirectionMultiplierPolicy, 'minMultiplier' | 'maxMultiplier'>
): number {
  const min = policy.minMultiplier ?? DEFAULT_MIN_MULTIPLIER;
  const max = policy.maxMultiplier ?? DEFAULT_MAX_MULTIPLIER;
  return Math.max(min, Math.min(max, value));
}

export function getDirectionDurationBand(
  endDate?: Date | null,
  currentTime: Date = new Date()
): DirectionDurationBand {
  if (!endDate) return 'medium';

  const msUntilResolution = endDate.getTime() - currentTime.getTime();
  const hoursUntilResolution = msUntilResolution / (60 * 60 * 1000);

  if (hoursUntilResolution <= 24) return 'intraday';
  if (hoursUntilResolution <= 24 * 7) return 'short';
  if (hoursUntilResolution <= 24 * 30) return 'medium';
  return 'long';
}

export function getDirectionPriceBucket(price: number): string {
  const bucket = DIRECTION_PRICE_BUCKETS.find(
    ({ min, max }) => price >= min && price < max
  );
  return bucket?.label ?? 'unknown';
}

export function getDirectionPriceBucketRange(label: string): { min: number; max: number } | null {
  const bucket = DIRECTION_PRICE_BUCKETS.find(item => item.label === label);
  return bucket ? { min: bucket.min, max: bucket.max } : null;
}

export function buildDirectionContextKey(context: DirectionMultiplierContext): string {
  const marketType = context.marketType ?? 'unknown';
  const priceBucket = getDirectionPriceBucket(context.currentPrice);
  const durationBand = getDirectionDurationBand(context.endDate, context.currentTime);
  return `${marketType}|${priceBucket}|${durationBand}`;
}

export function sanitizeDirectionMultiplierPolicy(
  policy: Partial<DirectionMultiplierPolicy> | null | undefined,
  globalFallback: number = DEFAULT_DIRECTION_MULTIPLIER_POLICY.global
): DirectionMultiplierPolicy {
  const minMultiplier = policy?.minMultiplier ?? DEFAULT_MIN_MULTIPLIER;
  const maxMultiplier = policy?.maxMultiplier ?? DEFAULT_MAX_MULTIPLIER;
  const global = clampDirectionMultiplier(
    policy?.global ?? globalFallback,
    { minMultiplier, maxMultiplier }
  );

  const segments = Array.isArray(policy?.segments)
    ? policy.segments
        .filter((segment): segment is DirectionMultiplierSegment =>
          !!segment && typeof segment.id === 'string' && segment.id.length > 0 && Number.isFinite(segment.multiplier)
        )
        .map(segment => ({
          ...segment,
          multiplier: clampDirectionMultiplier(segment.multiplier, { minMultiplier, maxMultiplier }),
        }))
    : [];

  // perMarketType uses a fixed [-1, +1] domain because its contract is categorical {-1, +1}
  // (enforced upstream by PER_TYPE_PARAMETER_SPACE / REFINEMENT_PARAM_SPACE regression tests).
  // Clamping to the policy's [minMultiplier, maxMultiplier] would silently truncate the
  // legitimate +1 bootstrap to 0.25 when policy.maxMultiplier is the legacy default
  // (DEFAULT_MAX_MULTIPLIER=0.25, sized for the segment-multiplier domain). This was
  // observed in production after PR #166 deploy: event_financial signals showed
  // multiplier=0.25 instead of +1.
  const PER_TYPE_DOMAIN = { minMultiplier: -1.0, maxMultiplier: 1.0 };
  let perMarketType: Record<string, number> | undefined;
  if (policy?.perMarketType && typeof policy.perMarketType === 'object') {
    const filtered: Record<string, number> = {};
    for (const [marketType, value] of Object.entries(policy.perMarketType)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        filtered[marketType] = clampDirectionMultiplier(value, PER_TYPE_DOMAIN);
      }
    }
    if (Object.keys(filtered).length > 0) {
      perMarketType = filtered;
    }
  }

  return {
    global,
    perMarketType,
    minMultiplier,
    maxMultiplier,
    segments,
  };
}

function matchesSegment(
  segment: DirectionMultiplierSegment,
  context: DirectionMultiplierContext,
  durationBand: DirectionDurationBand
): boolean {
  if (segment.marketTypes?.length && !segment.marketTypes.includes(context.marketType ?? '')) {
    return false;
  }

  if (segment.durationBands?.length && !segment.durationBands.includes(durationBand)) {
    return false;
  }

  if (segment.priceRange) {
    const { min, max } = segment.priceRange;
    if (min !== undefined && context.currentPrice < min) return false;
    if (max !== undefined && context.currentPrice >= max) return false;
  }

  if (segment.questionPatterns?.length) {
    const question = (context.question ?? '').toLowerCase();
    if (!segment.questionPatterns.some(pattern => question.includes(pattern.toLowerCase()))) {
      return false;
    }
  }

  return true;
}

function getSegmentSpecificity(segment: DirectionMultiplierSegment): number {
  let score = 0;
  if (segment.marketTypes?.length) score += 2;
  if (segment.priceRange) score += 2;
  if (segment.durationBands?.length) score += 1;
  if (segment.questionPatterns?.length) score += 3;
  return score;
}

export function resolveDirectionMultiplier(
  policy: DirectionMultiplierPolicy,
  context: DirectionMultiplierContext
): ResolvedDirectionMultiplier {
  const durationBand = getDirectionDurationBand(context.endDate, context.currentTime);
  const matchingSegments = policy.segments
    .filter(segment => matchesSegment(segment, context, durationBand))
    .sort((a, b) => getSegmentSpecificity(b) - getSegmentSpecificity(a));

  const bestMatch = matchingSegments[0];
  if (!bestMatch) {
    const perType = policy.perMarketType?.[context.marketType ?? ''];
    if (perType !== undefined && Number.isFinite(perType)) {
      return {
        multiplier: perType,
        contextKey: buildDirectionContextKey(context),
        segmentId: null,
      };
    }
    return {
      multiplier: policy.global,
      contextKey: buildDirectionContextKey(context),
      segmentId: null,
    };
  }

  return {
    multiplier: bestMatch.multiplier,
    contextKey: `${buildDirectionContextKey(context)}|${bestMatch.id}`,
    segmentId: bestMatch.id,
  };
}

export function buildDirectionMultiplierMap(
  policy: DirectionMultiplierPolicy
): Record<string, number> {
  const map: Record<string, number> = {};
  for (const segment of policy.segments) {
    const marketTypes = segment.marketTypes?.length ? segment.marketTypes : ['unknown'];
    const durationBands = segment.durationBands?.length ? segment.durationBands : ['intraday', 'short', 'medium', 'long'];

    for (const marketType of marketTypes) {
      for (const durationBand of durationBands) {
        const priceRanges = segment.priceRange
          ? [segment.priceRange]
          : [{ min: 0, max: 1.01 }];

        for (const priceRange of priceRanges) {
          for (const bucket of DIRECTION_PRICE_BUCKETS) {
            const bucketOverlaps =
              (priceRange.min ?? 0) < bucket.max &&
              (priceRange.max ?? 1.01) > bucket.min;
            if (!bucketOverlaps) continue;

            map[`${marketType}|${bucket.label}|${durationBand}|${segment.id}`] = segment.multiplier;
          }
        }
      }
    }
  }
  return map;
}
