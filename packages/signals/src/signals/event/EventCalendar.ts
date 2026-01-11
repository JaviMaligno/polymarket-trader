/**
 * Event Calendar
 *
 * Manages scheduled events that may affect prediction markets.
 * Provides event lookup, matching, and context generation for trading.
 */

import { pino, Logger } from 'pino';
import { EventEmitter } from 'events';
import {
  EventCategory,
  EventSubType,
  EventImportance,
  EventPhase,
  ScheduledEvent,
  MarketEventContext,
  EventPattern,
  EventTradingConfig,
  DEFAULT_EVENT_TRADING_CONFIG,
} from './types.js';

/**
 * Event Calendar Configuration
 */
export interface EventCalendarConfig extends Partial<EventTradingConfig> {
  /** Whether to enable automatic event fetching - default: false */
  enableAutoFetch?: boolean;
  /** Auto-fetch interval in minutes - default: 60 */
  autoFetchIntervalMinutes?: number;
  /** Maximum events to store - default: 1000 */
  maxStoredEvents?: number;
}

/**
 * Event data provider interface
 * Implementations can fetch events from various sources
 */
export interface IEventProvider {
  /** Provider name */
  getName(): string;
  /** Fetch events for a time range */
  fetchEvents(startDate: Date, endDate: Date): Promise<ScheduledEvent[]>;
  /** Fetch events for specific markets */
  fetchEventsForMarkets(marketIds: string[]): Promise<ScheduledEvent[]>;
  /** Get supported categories */
  getSupportedCategories(): EventCategory[];
}

/**
 * Event Calendar
 *
 * Central registry for scheduled events that affect prediction markets.
 * Supports:
 * - Manual event entry
 * - External event providers
 * - Automatic event matching to markets
 * - Event phase tracking
 * - Pattern learning from outcomes
 *
 * Events:
 * - 'event:added': (event: ScheduledEvent) => void
 * - 'event:updated': (event: ScheduledEvent) => void
 * - 'event:removed': (eventId: string) => void
 * - 'event:approaching': (event: ScheduledEvent, minutesUntil: number) => void
 * - 'event:started': (event: ScheduledEvent) => void
 * - 'event:ended': (event: ScheduledEvent) => void
 */
export class EventCalendar extends EventEmitter {
  private logger: Logger;
  private config: Required<EventCalendarConfig>;
  private events: Map<string, ScheduledEvent> = new Map();
  private providers: IEventProvider[] = [];
  private patterns: Map<EventSubType, EventPattern> = new Map();
  private marketEventCache: Map<string, { context: MarketEventContext; expiry: number }> = new Map();
  private monitorInterval: ReturnType<typeof setInterval> | null = null;
  private fetchInterval: ReturnType<typeof setInterval> | null = null;

  private readonly CACHE_TTL_MS = 60 * 1000; // 1 minute
  private readonly APPROACHING_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

  constructor(config?: EventCalendarConfig) {
    super();
    this.logger = pino({ name: 'EventCalendar' });

    this.config = {
      ...DEFAULT_EVENT_TRADING_CONFIG,
      enableAutoFetch: config?.enableAutoFetch ?? false,
      autoFetchIntervalMinutes: config?.autoFetchIntervalMinutes ?? 60,
      maxStoredEvents: config?.maxStoredEvents ?? 1000,
      ...config,
    };

    this.initializeDefaultPatterns();
  }

  /**
   * Start event monitoring and auto-fetching
   */
  start(): void {
    // Monitor events for phase changes
    this.monitorInterval = setInterval(() => this.monitorEvents(), 60 * 1000);

    // Auto-fetch if enabled
    if (this.config.enableAutoFetch && this.providers.length > 0) {
      this.fetchFromProviders();
      this.fetchInterval = setInterval(
        () => this.fetchFromProviders(),
        this.config.autoFetchIntervalMinutes * 60 * 1000
      );
    }

    this.logger.info('Event calendar started');
  }

  /**
   * Stop event monitoring
   */
  stop(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    if (this.fetchInterval) {
      clearInterval(this.fetchInterval);
      this.fetchInterval = null;
    }
    this.logger.info('Event calendar stopped');
  }

  /**
   * Register an event provider
   */
  registerProvider(provider: IEventProvider): void {
    this.providers.push(provider);
    this.logger.info({ provider: provider.getName() }, 'Event provider registered');
  }

  /**
   * Add a scheduled event
   */
  addEvent(event: ScheduledEvent): void {
    const existing = this.events.get(event.id);
    this.events.set(event.id, event);

    // Enforce max events limit
    if (this.events.size > this.config.maxStoredEvents) {
      this.pruneOldEvents();
    }

    if (existing) {
      this.emit('event:updated', event);
      this.logger.debug({ eventId: event.id }, 'Event updated');
    } else {
      this.emit('event:added', event);
      this.logger.debug({ eventId: event.id, name: event.name }, 'Event added');
    }

    // Clear affected market caches
    this.clearCacheForMarkets(event.relatedMarketIds);
  }

  /**
   * Remove an event
   */
  removeEvent(eventId: string): void {
    const event = this.events.get(eventId);
    if (event) {
      this.events.delete(eventId);
      this.clearCacheForMarkets(event.relatedMarketIds);
      this.emit('event:removed', eventId);
      this.logger.debug({ eventId }, 'Event removed');
    }
  }

  /**
   * Get event by ID
   */
  getEvent(eventId: string): ScheduledEvent | undefined {
    return this.events.get(eventId);
  }

  /**
   * Get all events within a time range
   */
  getEventsInRange(startDate: Date, endDate: Date): ScheduledEvent[] {
    const events: ScheduledEvent[] = [];
    for (const event of this.events.values()) {
      if (event.scheduledTime >= startDate && event.scheduledTime <= endDate) {
        events.push(event);
      }
    }
    return events.sort((a, b) => a.scheduledTime.getTime() - b.scheduledTime.getTime());
  }

  /**
   * Get events for a specific market
   */
  getEventsForMarket(marketId: string, question?: string): ScheduledEvent[] {
    const events: ScheduledEvent[] = [];

    for (const event of this.events.values()) {
      // Direct market ID match
      if (event.relatedMarketIds.includes(marketId)) {
        events.push(event);
        continue;
      }

      // Keyword matching with question
      if (question && this.matchesKeywords(question, event.keywords)) {
        events.push(event);
      }
    }

    return events.sort((a, b) => a.scheduledTime.getTime() - b.scheduledTime.getTime());
  }

  /**
   * Get event context for a market
   * This is the main method for trading signals to use
   */
  getMarketEventContext(marketId: string, marketQuestion: string): MarketEventContext {
    // Check cache
    const cached = this.marketEventCache.get(marketId);
    if (cached && Date.now() < cached.expiry) {
      return cached.context;
    }

    const now = new Date();
    const lookforwardMs = this.config.lookforwardHours * 60 * 60 * 1000;
    const lookbackMs = this.config.lookbackHours * 60 * 60 * 1000;

    const allEvents = this.getEventsForMarket(marketId, marketQuestion);

    // Categorize events by timing
    const activeEvents: ScheduledEvent[] = [];
    const upcomingEvents: ScheduledEvent[] = [];
    const recentEvents: ScheduledEvent[] = [];

    for (const event of allEvents) {
      const eventTime = event.scheduledTime.getTime();
      const eventEndTime = eventTime + (event.durationMinutes || 0) * 60 * 1000;
      const nowTime = now.getTime();

      if (nowTime >= eventTime && nowTime <= eventEndTime) {
        activeEvents.push(event);
      } else if (eventTime > nowTime && eventTime <= nowTime + lookforwardMs) {
        upcomingEvents.push(event);
      } else if (eventEndTime < nowTime && eventEndTime >= nowTime - lookbackMs) {
        recentEvents.push(event);
      }
    }

    // Find next significant event
    const significantUpcoming = upcomingEvents.filter(
      e => this.getImportanceLevel(e.importance) >= this.getImportanceLevel(this.config.minImportance)
    );
    const nextEvent = significantUpcoming.length > 0 ? significantUpcoming[0] : null;
    const timeToNextEvent = nextEvent
      ? nextEvent.scheduledTime.getTime() - now.getTime()
      : null;

    // Determine current phase (pass recentEvents for POST_EVENT detection)
    const currentPhase = this.determinePhase(activeEvents, nextEvent, timeToNextEvent, recentEvents);

    // Calculate expected volatility
    const expectedVolatility = this.calculateExpectedVolatility(activeEvents, upcomingEvents, timeToNextEvent);

    // Calculate position size multiplier
    const positionSizeMultiplier = this.calculatePositionMultiplier(
      activeEvents,
      upcomingEvents,
      currentPhase,
      timeToNextEvent
    );

    const context: MarketEventContext = {
      marketId,
      marketQuestion,
      currentPhase,
      activeEvents,
      upcomingEvents,
      recentEvents,
      nextEvent,
      timeToNextEvent,
      expectedVolatility,
      positionSizeMultiplier,
      computedAt: now,
    };

    // Cache the result
    this.marketEventCache.set(marketId, {
      context,
      expiry: Date.now() + this.CACHE_TTL_MS,
    });

    return context;
  }

  /**
   * Link a market to an event
   */
  linkMarketToEvent(eventId: string, marketId: string): void {
    const event = this.events.get(eventId);
    if (event && !event.relatedMarketIds.includes(marketId)) {
      event.relatedMarketIds.push(marketId);
      event.updatedAt = new Date();
      this.clearCacheForMarkets([marketId]);
    }
  }

  /**
   * Add event pattern from historical data
   */
  addPattern(pattern: EventPattern): void {
    this.patterns.set(pattern.eventSubType, pattern);
    this.logger.debug({ subType: pattern.eventSubType }, 'Event pattern added');
  }

  /**
   * Get pattern for an event type
   */
  getPattern(subType: EventSubType): EventPattern | undefined {
    return this.patterns.get(subType);
  }

  /**
   * Create an event quickly
   */
  createEvent(params: {
    name: string;
    scheduledTime: Date;
    category: EventCategory;
    importance?: EventImportance;
    subType?: EventSubType;
    marketIds?: string[];
    keywords?: string[];
    description?: string;
    durationMinutes?: number;
  }): ScheduledEvent {
    const event: ScheduledEvent = {
      id: this.generateEventId(),
      name: params.name,
      description: params.description,
      category: params.category,
      subType: params.subType,
      importance: params.importance ?? EventImportance.MEDIUM,
      scheduledTime: params.scheduledTime,
      durationMinutes: params.durationMinutes ?? 0,
      relatedMarketIds: params.marketIds ?? [],
      keywords: params.keywords ?? this.extractKeywords(params.name),
      isTimeConfirmed: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.addEvent(event);
    return event;
  }

  /**
   * Monitor events for phase changes and emit notifications
   */
  private monitorEvents(): void {
    const now = Date.now();

    for (const event of this.events.values()) {
      const eventTime = event.scheduledTime.getTime();
      const eventEndTime = eventTime + (event.durationMinutes || 0) * 60 * 1000;
      const timeUntil = eventTime - now;

      // Check for approaching events (within 1 hour)
      if (timeUntil > 0 && timeUntil <= this.APPROACHING_THRESHOLD_MS) {
        const minutesUntil = Math.round(timeUntil / (60 * 1000));
        // Only emit at specific intervals (60, 30, 15, 5 minutes)
        if ([60, 30, 15, 5].includes(minutesUntil)) {
          this.emit('event:approaching', event, minutesUntil);
        }
      }

      // Check for event start
      if (now >= eventTime && now <= eventTime + 60000) {
        this.emit('event:started', event);
      }

      // Check for event end
      if (now >= eventEndTime && now <= eventEndTime + 60000) {
        this.emit('event:ended', event);
      }
    }
  }

  /**
   * Fetch events from all providers
   */
  private async fetchFromProviders(): Promise<void> {
    const now = new Date();
    const startDate = new Date(now.getTime() - this.config.lookbackHours * 60 * 60 * 1000);
    const endDate = new Date(now.getTime() + this.config.lookforwardHours * 60 * 60 * 1000);

    for (const provider of this.providers) {
      try {
        const events = await provider.fetchEvents(startDate, endDate);
        for (const event of events) {
          this.addEvent(event);
        }
        this.logger.debug({
          provider: provider.getName(),
          eventCount: events.length,
        }, 'Fetched events from provider');
      } catch (error) {
        this.logger.warn({
          provider: provider.getName(),
          error: error instanceof Error ? error.message : String(error),
        }, 'Failed to fetch events from provider');
      }
    }
  }

  /**
   * Determine event phase
   * FIXED: Now properly returns POST_EVENT phases by examining recent events
   */
  private determinePhase(
    activeEvents: ScheduledEvent[],
    nextEvent: ScheduledEvent | null,
    timeToNextEvent: number | null,
    recentEvents?: ScheduledEvent[]
  ): EventPhase {
    // If there are active events
    if (activeEvents.length > 0) {
      return EventPhase.DURING_EVENT;
    }

    // Check for post-event phases based on recent events
    if (recentEvents && recentEvents.length > 0) {
      const now = Date.now();
      // Get most recent event (last in array after sorting by time)
      const mostRecent = recentEvents[recentEvents.length - 1];
      const eventEndTime = mostRecent.scheduledTime.getTime() +
        (mostRecent.durationMinutes || 0) * 60 * 1000;
      const hoursSinceEnd = (now - eventEndTime) / (60 * 60 * 1000);

      if (hoursSinceEnd >= 0) {
        if (hoursSinceEnd <= 1) {
          return EventPhase.POST_EVENT_IMMEDIATE;
        } else if (hoursSinceEnd <= 6) {
          return EventPhase.POST_EVENT_NEAR;
        } else if (hoursSinceEnd <= 24) {
          return EventPhase.POST_EVENT_DISTANT;
        }
      }
    }

    // No next event
    if (!nextEvent || timeToNextEvent === null) {
      return EventPhase.NO_EVENT;
    }

    const hoursUntil = timeToNextEvent / (60 * 60 * 1000);

    if (hoursUntil <= 1) {
      return EventPhase.PRE_EVENT_IMMINENT;
    } else if (hoursUntil <= 24) {
      return EventPhase.PRE_EVENT_NEAR;
    } else {
      return EventPhase.PRE_EVENT_DISTANT;
    }
  }

  /**
   * Calculate expected volatility based on events
   */
  private calculateExpectedVolatility(
    activeEvents: ScheduledEvent[],
    upcomingEvents: ScheduledEvent[],
    timeToNextEvent: number | null
  ): number {
    let volatility = 0.1; // Base volatility

    // Active events add significant volatility
    for (const event of activeEvents) {
      volatility += this.getVolatilityForImportance(event.importance);
    }

    // Upcoming events add volatility based on proximity
    if (timeToNextEvent !== null) {
      const hoursUntil = timeToNextEvent / (60 * 60 * 1000);
      for (const event of upcomingEvents) {
        const baseVol = this.getVolatilityForImportance(event.importance);
        // Decay factor based on time
        const decay = Math.exp(-hoursUntil / 12);
        volatility += baseVol * decay;
      }
    }

    return Math.min(1, volatility);
  }

  /**
   * Calculate position size multiplier based on events
   */
  private calculatePositionMultiplier(
    activeEvents: ScheduledEvent[],
    upcomingEvents: ScheduledEvent[],
    phase: EventPhase,
    timeToNextEvent: number | null
  ): number {
    let multiplier = 1.0;

    // Reduce during active events based on importance
    for (const event of activeEvents) {
      if (event.importance === EventImportance.CRITICAL) {
        multiplier *= this.config.criticalPositionFactor;
      } else if (event.importance === EventImportance.HIGH) {
        multiplier *= this.config.highImportancePositionFactor;
      } else {
        multiplier *= 0.75;
      }
    }

    // Reduce before critical events
    if (this.config.avoidPreCriticalEntry && timeToNextEvent !== null) {
      const hoursUntil = timeToNextEvent / (60 * 60 * 1000);
      const criticalUpcoming = upcomingEvents.filter(e => e.importance === EventImportance.CRITICAL);

      if (criticalUpcoming.length > 0 && hoursUntil <= this.config.preCriticalAvoidanceHours) {
        multiplier *= this.config.criticalPositionFactor;
      }
    }

    // Increase post-resolution (assuming recent events have resolved)
    if (phase === EventPhase.POST_EVENT_IMMEDIATE && this.config.increasePostResolution) {
      multiplier *= this.config.postResolutionMultiplier;
    }

    return Math.max(0.1, Math.min(2, multiplier));
  }

  /**
   * Get volatility contribution for importance level
   */
  private getVolatilityForImportance(importance: EventImportance): number {
    switch (importance) {
      case EventImportance.CRITICAL:
        return 0.5;
      case EventImportance.HIGH:
        return 0.3;
      case EventImportance.MEDIUM:
        return 0.15;
      case EventImportance.LOW:
        return 0.05;
      default:
        return 0.1;
    }
  }

  /**
   * Get numeric importance level
   */
  private getImportanceLevel(importance: EventImportance): number {
    switch (importance) {
      case EventImportance.CRITICAL:
        return 4;
      case EventImportance.HIGH:
        return 3;
      case EventImportance.MEDIUM:
        return 2;
      case EventImportance.LOW:
        return 1;
      default:
        return 0;
    }
  }

  /**
   * Check if question matches keywords
   */
  private matchesKeywords(question: string, keywords: string[]): boolean {
    const lowerQuestion = question.toLowerCase();
    return keywords.some(kw => lowerQuestion.includes(kw.toLowerCase()));
  }

  /**
   * Extract keywords from event name
   */
  private extractKeywords(name: string): string[] {
    // Simple keyword extraction - remove common words
    const stopWords = new Set([
      'the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or',
      'will', 'be', 'is', 'are', 'was', 'were', 'has', 'have', 'had',
    ]);

    return name
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(word => word.length > 2 && !stopWords.has(word));
  }

  /**
   * Generate unique event ID
   */
  private generateEventId(): string {
    return `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Clear cache for specific markets
   */
  private clearCacheForMarkets(marketIds: string[]): void {
    for (const marketId of marketIds) {
      this.marketEventCache.delete(marketId);
    }
  }

  /**
   * Prune old events to stay under limit
   */
  private pruneOldEvents(): void {
    const now = Date.now();
    const maxAgeMs = 7 * 24 * 60 * 60 * 1000; // 7 days

    const eventsToRemove: string[] = [];

    for (const [id, event] of this.events) {
      const eventEndTime = event.scheduledTime.getTime() + (event.durationMinutes || 0) * 60 * 1000;
      if (eventEndTime + maxAgeMs < now) {
        eventsToRemove.push(id);
      }
    }

    for (const id of eventsToRemove) {
      this.events.delete(id);
    }

    this.logger.debug({ removed: eventsToRemove.length }, 'Pruned old events');
  }

  /**
   * Initialize default patterns based on historical knowledge
   */
  private initializeDefaultPatterns(): void {
    // Election day pattern
    this.patterns.set(EventSubType.ELECTION_DAY, {
      eventSubType: EventSubType.ELECTION_DAY,
      avgPriceImpact: 0.25,
      stdPriceImpact: 0.15,
      avgTimeToPeak: 120,
      sampleCount: 50,
      optimalEntryMinutes: -60,
      optimalExitMinutes: 30,
      historicalWinRate: 0.55,
      confidence: 0.7,
    });

    // Debate pattern
    this.patterns.set(EventSubType.DEBATE, {
      eventSubType: EventSubType.DEBATE,
      avgPriceImpact: 0.08,
      stdPriceImpact: 0.05,
      avgTimeToPeak: 60,
      sampleCount: 30,
      optimalEntryMinutes: -30,
      optimalExitMinutes: 60,
      historicalWinRate: 0.52,
      confidence: 0.5,
    });

    // Token unlock pattern
    this.patterns.set(EventSubType.TOKEN_UNLOCK, {
      eventSubType: EventSubType.TOKEN_UNLOCK,
      avgPriceImpact: 0.12,
      stdPriceImpact: 0.08,
      avgTimeToPeak: 240,
      sampleCount: 100,
      optimalEntryMinutes: -120,
      optimalExitMinutes: 60,
      historicalWinRate: 0.58,
      confidence: 0.65,
    });

    // Game start pattern (sports)
    this.patterns.set(EventSubType.GAME_START, {
      eventSubType: EventSubType.GAME_START,
      avgPriceImpact: 0.05,
      stdPriceImpact: 0.03,
      avgTimeToPeak: 30,
      sampleCount: 200,
      optimalEntryMinutes: -15,
      optimalExitMinutes: 15,
      historicalWinRate: 0.51,
      confidence: 0.6,
    });

    // Fed meeting pattern
    this.patterns.set(EventSubType.FED_MEETING, {
      eventSubType: EventSubType.FED_MEETING,
      avgPriceImpact: 0.15,
      stdPriceImpact: 0.10,
      avgTimeToPeak: 45,
      sampleCount: 40,
      optimalEntryMinutes: -30,
      optimalExitMinutes: 30,
      historicalWinRate: 0.54,
      confidence: 0.55,
    });
  }

  /**
   * Get current event count
   */
  getEventCount(): number {
    return this.events.size;
  }

  /**
   * Get all events (for debugging/export)
   */
  getAllEvents(): ScheduledEvent[] {
    return Array.from(this.events.values());
  }

  /**
   * Clear all events
   */
  clear(): void {
    this.events.clear();
    this.marketEventCache.clear();
    this.logger.info('Event calendar cleared');
  }
}
