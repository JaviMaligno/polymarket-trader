/**
 * Risk Protection Filters
 *
 * Multi-layered protection system to prevent catastrophic losses.
 */

// Position and Stop-Loss Management (A & B)
export { PositionLimits, type PositionLimitsConfig, type Position, type PositionCheckResult } from './PositionLimits.js';
export { StopLossManager, type StopLossConfig, type TrackedPosition, type StopCheckResult, OPTIMIZABLE_RANGES as STOP_LOSS_RANGES } from './StopLossManager.js';

// Entry Filters (C1, C2, C3)
export { HurstFilter, type HurstConfig, type HurstResult, type MarketRegime, type FilterDecision as HurstFilterDecision, OPTIMIZABLE_RANGES as HURST_RANGES } from './HurstFilter.js';
export { RSIMomentumFilter, type RSIConfig, type RSIResult, type RSIFilterDecision, OPTIMIZABLE_RANGES as RSI_RANGES } from './RSIMomentumFilter.js';
export { ZScoreVolatilityFilter, type ZScoreConfig, type ZScoreResult, type ZScoreFilterDecision, type VolatilityAnalysis, OPTIMIZABLE_RANGES as ZSCORE_RANGES } from './ZScoreVolatilityFilter.js';

// Pipeline Orchestrator
export { EntryFilterPipeline, type EntryFilterConfig, type PipelineDecision, type SignalType, type SignalDirection } from './EntryFilterPipeline.js';
