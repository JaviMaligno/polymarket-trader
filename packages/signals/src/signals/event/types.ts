/**
 * Event Calendar Types
 *
 * Defines types for tracking and using market events
 * to generate trading signals.
 */

/**
 * Categories of events that affect prediction markets
 */
export enum EventCategory {
  /** Political events - elections, debates, policy announcements */
  POLITICS = 'politics',
  /** Cryptocurrency events - token unlocks, protocol upgrades, halvings */
  CRYPTO = 'crypto',
  /** Sports events - games, injuries, trades, weather */
  SPORTS = 'sports',
  /** Economic events - reports, Fed meetings, earnings */
  ECONOMICS = 'economics',
  /** Entertainment - awards, releases, celebrity events */
  ENTERTAINMENT = 'entertainment',
  /** Legal - court decisions, regulatory actions */
  LEGAL = 'legal',
  /** Technology - product launches, tech announcements */
  TECHNOLOGY = 'technology',
  /** Weather/Natural - storms, earthquakes, climate events */
  WEATHER = 'weather',
  /** Other/Unknown category */
  OTHER = 'other',
}

/**
 * Sub-types for more specific event classification
 */
export enum EventSubType {
  // Politics
  ELECTION_DAY = 'election_day',
  PRIMARY = 'primary',
  DEBATE = 'debate',
  POLL_RELEASE = 'poll_release',
  POLICY_ANNOUNCEMENT = 'policy_announcement',
  INAUGURATION = 'inauguration',

  // Crypto
  TOKEN_UNLOCK = 'token_unlock',
  PROTOCOL_UPGRADE = 'protocol_upgrade',
  HALVING = 'halving',
  AIRDROP = 'airdrop',
  MAINNET_LAUNCH = 'mainnet_launch',
  EXCHANGE_LISTING = 'exchange_listing',

  // Sports
  GAME_START = 'game_start',
  GAME_END = 'game_end',
  INJURY_REPORT = 'injury_report',
  TRADE_DEADLINE = 'trade_deadline',
  DRAFT = 'draft',
  WEATHER_DELAY = 'weather_delay',

  // Economics
  FED_MEETING = 'fed_meeting',
  JOBS_REPORT = 'jobs_report',
  CPI_RELEASE = 'cpi_release',
  GDP_REPORT = 'gdp_report',
  EARNINGS_CALL = 'earnings_call',

  // Legal
  COURT_DECISION = 'court_decision',
  REGULATORY_RULING = 'regulatory_ruling',
  FILING_DEADLINE = 'filing_deadline',

  // General
  ANNOUNCEMENT = 'announcement',
  DEADLINE = 'deadline',
  RESOLUTION = 'resolution',
  CUSTOM = 'custom',
}

/**
 * Event importance level
 */
export enum EventImportance {
  /** Low importance - minor news, unlikely to move markets significantly */
  LOW = 'low',
  /** Medium importance - notable event, may cause moderate movement */
  MEDIUM = 'medium',
  /** High importance - major event, likely to cause significant movement */
  HIGH = 'high',
  /** Critical importance - market-defining event, expect high volatility */
  CRITICAL = 'critical',
}

/**
 * Timing relative to event
 */
export enum EventPhase {
  /** Well before the event (>24h) */
  PRE_EVENT_DISTANT = 'pre_event_distant',
  /** Approaching the event (1-24h) */
  PRE_EVENT_NEAR = 'pre_event_near',
  /** Imminent (< 1h before) */
  PRE_EVENT_IMMINENT = 'pre_event_imminent',
  /** Event is currently happening */
  DURING_EVENT = 'during_event',
  /** Shortly after event (<1h) */
  POST_EVENT_IMMEDIATE = 'post_event_immediate',
  /** After event (1-24h) */
  POST_EVENT_NEAR = 'post_event_near',
  /** Well after event (>24h) */
  POST_EVENT_DISTANT = 'post_event_distant',
  /** No active event affecting this market */
  NO_EVENT = 'no_event',
}

/**
 * Scheduled event that may affect a market
 */
export interface ScheduledEvent {
  /** Unique event identifier */
  id: string;
  /** Human-readable event name */
  name: string;
  /** Detailed description */
  description?: string;
  /** Event category */
  category: EventCategory;
  /** Event sub-type for more specific classification */
  subType?: EventSubType;
  /** Importance level */
  importance: EventImportance;
  /** When the event is scheduled to occur */
  scheduledTime: Date;
  /** Estimated duration in minutes (0 for instantaneous events) */
  durationMinutes?: number;
  /** Market IDs affected by this event */
  relatedMarketIds: string[];
  /** Keywords for matching with market questions */
  keywords: string[];
  /** Source of the event information */
  source?: string;
  /** URL for more information */
  sourceUrl?: string;
  /** Whether the event time is confirmed or estimated */
  isTimeConfirmed: boolean;
  /** When this event record was created */
  createdAt: Date;
  /** When this event record was last updated */
  updatedAt: Date;
  /** Custom metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Event context for a specific market
 */
export interface MarketEventContext {
  /** Market ID */
  marketId: string;
  /** Market question for reference */
  marketQuestion: string;
  /** Current event phase */
  currentPhase: EventPhase;
  /** Active events affecting this market */
  activeEvents: ScheduledEvent[];
  /** Upcoming events within the lookforward window */
  upcomingEvents: ScheduledEvent[];
  /** Recently completed events */
  recentEvents: ScheduledEvent[];
  /** Next significant event (if any) */
  nextEvent: ScheduledEvent | null;
  /** Time until next event in milliseconds */
  timeToNextEvent: number | null;
  /** Overall event-driven volatility expectation (0-1) */
  expectedVolatility: number;
  /** Recommended position sizing multiplier based on events */
  positionSizeMultiplier: number;
  /** Timestamp when this context was computed */
  computedAt: Date;
}

/**
 * Historical event outcome for learning
 */
export interface EventOutcome {
  /** Event ID */
  eventId: string;
  /** Market ID */
  marketId: string;
  /** Price before event (at various intervals) */
  pricesBefore: {
    h24: number;
    h6: number;
    h1: number;
    m15: number;
  };
  /** Price after event (at various intervals) */
  pricesAfter: {
    m15: number;
    h1: number;
    h6: number;
    h24: number;
  };
  /** Peak price change during/after event */
  peakPriceChange: number;
  /** Whether the market moved as expected based on event type */
  expectedMovement: boolean;
  /** Actual volatility during event window */
  realizedVolatility: number;
  /** Volume during event window vs average */
  relativeVolume: number;
  /** Notes on outcome */
  notes?: string;
}

/**
 * Event pattern learned from historical data
 */
export interface EventPattern {
  /** Event sub-type this pattern applies to */
  eventSubType: EventSubType;
  /** Market category */
  marketCategory?: string;
  /** Average price impact (absolute) */
  avgPriceImpact: number;
  /** Standard deviation of price impact */
  stdPriceImpact: number;
  /** Average time to peak impact (minutes) */
  avgTimeToPeak: number;
  /** Sample size */
  sampleCount: number;
  /** Optimal entry timing relative to event (negative = before) */
  optimalEntryMinutes: number;
  /** Optimal exit timing relative to event */
  optimalExitMinutes: number;
  /** Historical win rate when trading this pattern */
  historicalWinRate: number;
  /** Confidence in this pattern (0-1) */
  confidence: number;
}

/**
 * Configuration for event-driven trading
 */
export interface EventTradingConfig {
  /** Hours to look ahead for upcoming events - default: 48 */
  lookforwardHours: number;
  /** Hours to look back for recent events - default: 6 */
  lookbackHours: number;
  /** Minimum importance to consider - default: MEDIUM */
  minImportance: EventImportance;
  /** Position reduction factor during high-importance events - default: 0.5 */
  highImportancePositionFactor: number;
  /** Position reduction factor during critical events - default: 0.25 */
  criticalPositionFactor: number;
  /** Whether to avoid new positions before critical events - default: true */
  avoidPreCriticalEntry: boolean;
  /** Hours before critical event to start avoiding - default: 2 */
  preCriticalAvoidanceHours: number;
  /** Whether to increase position sizing after event resolution - default: true */
  increasePostResolution: boolean;
  /** Post-resolution position multiplier - default: 1.5 */
  postResolutionMultiplier: number;
}

/** Default event trading configuration */
export const DEFAULT_EVENT_TRADING_CONFIG: EventTradingConfig = {
  lookforwardHours: 48,
  lookbackHours: 6,
  minImportance: EventImportance.MEDIUM,
  highImportancePositionFactor: 0.5,
  criticalPositionFactor: 0.25,
  avoidPreCriticalEntry: true,
  preCriticalAvoidanceHours: 2,
  increasePostResolution: true,
  postResolutionMultiplier: 1.5,
};
