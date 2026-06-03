export interface FLBConfig {
  enabled: boolean;
  dryRun: boolean;
  scanIntervalMs: number;
  reconcileIntervalMs: number;
  longshotLo: number;
  longshotHi: number;
  minTtrHours: number;
  maxEntryCostPct: number;      // percentage points
  maxPositionPct: number;       // percentage points
  maxLockedCapitalPct: number;  // percentage points
  maxSameWeekPositions: number;
  eligibleTypes: string[];
}

function num(envVal: string | undefined, fallback: number): number {
  if (envVal === undefined) return fallback;
  const n = Number(envVal);
  return Number.isFinite(n) ? n : fallback;
}

export function getFLBConfig(): FLBConfig {
  const typesRaw = process.env.FLB_ELIGIBLE_TYPES;
  const eligibleTypes = typesRaw === undefined
    ? ['crypto_daily', 'event_financial', 'event_short', 'event_long']
    : typesRaw.split(',').map(s => s.trim()).filter(s => s.length > 0);

  return {
    enabled: process.env.FLB_EXECUTOR_ENABLED === 'true',
    dryRun: process.env.FLB_DRY_RUN === 'true',
    scanIntervalMs: num(process.env.FLB_SCAN_INTERVAL_MS, 21_600_000),
    reconcileIntervalMs: num(process.env.FLB_RECONCILE_INTERVAL_MS, 21_600_000),
    longshotLo: num(process.env.FLB_LONGSHOT_LO, 0.02),
    longshotHi: num(process.env.FLB_LONGSHOT_HI, 0.10),
    minTtrHours: num(process.env.FLB_MIN_TTR_HOURS, 48),
    maxEntryCostPct: num(process.env.FLB_MAX_ENTRY_COST_PCT, 1.0),
    maxPositionPct: num(process.env.FLB_MAX_POSITION_PCT, 0.21),
    maxLockedCapitalPct: num(process.env.FLB_MAX_LOCKED_CAPITAL_PCT, 5.0),
    maxSameWeekPositions: num(process.env.FLB_MAX_SAME_WEEK_POSITIONS, 50),
    eligibleTypes,
  };
}
