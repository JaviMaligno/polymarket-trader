/**
 * Event-Driven Signal
 *
 * Generates trading signals based on scheduled events and their
 * expected impact on market prices.
 */

import { BaseSignal } from '../../core/base/BaseSignal.js';
import type {
  SignalContext,
  SignalOutput,
  SignalDirection,
} from '../../core/types/signal.types.js';
import {
  EventCalendar,
  type EventCalendarConfig,
} from './EventCalendar.js';
import {
  EventPhase,
  EventImportance,
  EventSubType,
  MarketEventContext,
  ScheduledEvent,
  EventPattern,
} from './types.js';

/**
 * Configuration for Event-Driven Signal
 */
export interface EventDrivenSignalConfig extends Record<string, unknown> {
  /** Minimum event importance to generate signals - default: MEDIUM */
  minImportance?: EventImportance;
  /** Maximum hours before event to generate pre-event signal - default: 24 */
  maxHoursBeforeEvent?: number;
  /** Minimum confidence to emit signal - default: 0.3 */
  minConfidence?: number;
  /** Minimum strength to emit signal - default: 0.15 */
  minStrength?: number;
  /** Bias towards LONG during pre-event (positive sentiment) - default: 0.6 */
  preEventLongBias?: number;
  /** Signal strength multiplier - default: 1.0 */
  strengthMultiplier?: number;
  /** Whether to reduce signals during active events - default: true */
  reduceSignalsDuringEvents?: boolean;
  /** Event calendar configuration */
  calendarConfig?: EventCalendarConfig;
}

interface EventSignalParams extends Record<string, unknown> {
  minImportance: EventImportance;
  maxHoursBeforeEvent: number;
  minConfidence: number;
  minStrength: number;
  preEventLongBias: number;
  strengthMultiplier: number;
  reduceSignalsDuringEvents: boolean;
}

/** Default parameters */
export const DEFAULT_EVENT_SIGNAL_PARAMS: EventSignalParams = {
  minImportance: EventImportance.MEDIUM,
  maxHoursBeforeEvent: 24,
  minConfidence: 0.3,
  minStrength: 0.15,
  preEventLongBias: 0.6,
  strengthMultiplier: 1.0,
  reduceSignalsDuringEvents: true,
};

/**
 * Event-Driven Signal
 *
 * Analyzes scheduled events to predict market movements:
 * - Pre-event: Markets tend to move towards expected outcome
 * - During event: High volatility, reduced signal confidence
 * - Post-event: Resolution signals based on actual outcome
 *
 * Works with EventCalendar to track and match events to markets.
 */
export class EventDrivenSignal extends BaseSignal {
  readonly signalId = 'event_driven';
  readonly name = 'Event-Driven Signal';
  readonly description = 'Generates signals based on scheduled market events';

  protected parameters: EventSignalParams;
  private calendar: EventCalendar;

  constructor(config?: EventDrivenSignalConfig) {
    super();
    this.parameters = {
      ...DEFAULT_EVENT_SIGNAL_PARAMS,
      minImportance: config?.minImportance ?? DEFAULT_EVENT_SIGNAL_PARAMS.minImportance,
      maxHoursBeforeEvent: config?.maxHoursBeforeEvent ?? DEFAULT_EVENT_SIGNAL_PARAMS.maxHoursBeforeEvent,
      minConfidence: config?.minConfidence ?? DEFAULT_EVENT_SIGNAL_PARAMS.minConfidence,
      minStrength: config?.minStrength ?? DEFAULT_EVENT_SIGNAL_PARAMS.minStrength,
      preEventLongBias: config?.preEventLongBias ?? DEFAULT_EVENT_SIGNAL_PARAMS.preEventLongBias,
      strengthMultiplier: config?.strengthMultiplier ?? DEFAULT_EVENT_SIGNAL_PARAMS.strengthMultiplier,
      reduceSignalsDuringEvents: config?.reduceSignalsDuringEvents ?? DEFAULT_EVENT_SIGNAL_PARAMS.reduceSignalsDuringEvents,
    };

    this.calendar = new EventCalendar(config?.calendarConfig);
  }

  /**
   * Get the event calendar for external use
   */
  getCalendar(): EventCalendar {
    return this.calendar;
  }

  /**
   * Start the calendar monitoring
   */
  startCalendar(): void {
    this.calendar.start();
  }

  /**
   * Stop the calendar monitoring
   */
  stopCalendar(): void {
    this.calendar.stop();
  }

  getRequiredLookback(): number {
    return 1; // Event signals don't need price history
  }

  async compute(context: SignalContext): Promise<SignalOutput | null> {
    const params = this.parameters;

    // Get event context for this market
    const eventContext = this.calendar.getMarketEventContext(
      context.market.id,
      context.market.question
    );

    // No relevant events
    if (eventContext.currentPhase === EventPhase.NO_EVENT) {
      return null;
    }

    // Calculate signal based on event phase
    const signalResult = this.calculateEventSignal(context, eventContext, params);

    if (!signalResult) {
      return null;
    }

    const { direction, strength, confidence, metadata } = signalResult;

    // Apply thresholds
    if (Math.abs(strength) < params.minStrength || confidence < params.minConfidence) {
      return null;
    }

    return this.createOutput(context, direction, strength, confidence, {
      features: [
        this.phaseToNumber(eventContext.currentPhase),
        eventContext.activeEvents.length,
        eventContext.upcomingEvents.length,
        eventContext.expectedVolatility,
        eventContext.timeToNextEvent ? eventContext.timeToNextEvent / (60 * 60 * 1000) : -1,
        confidence,
      ],
      metadata: {
        ...metadata,
        phase: eventContext.currentPhase,
        positionMultiplier: eventContext.positionSizeMultiplier,
        expectedVolatility: eventContext.expectedVolatility,
      },
    });
  }

  /**
   * Calculate signal based on event context
   */
  private calculateEventSignal(
    context: SignalContext,
    eventContext: MarketEventContext,
    params: EventSignalParams
  ): {
    direction: SignalDirection;
    strength: number;
    confidence: number;
    metadata: Record<string, unknown>;
  } | null {
    const { currentPhase, activeEvents, nextEvent, timeToNextEvent, upcomingEvents } = eventContext;

    // During event - reduce or skip signals due to high uncertainty
    if (currentPhase === EventPhase.DURING_EVENT) {
      if (params.reduceSignalsDuringEvents) {
        return this.generateDuringEventSignal(context, activeEvents, params);
      }
      return null;
    }

    // Pre-event signals
    if (
      currentPhase === EventPhase.PRE_EVENT_IMMINENT ||
      currentPhase === EventPhase.PRE_EVENT_NEAR ||
      currentPhase === EventPhase.PRE_EVENT_DISTANT
    ) {
      return this.generatePreEventSignal(
        context,
        nextEvent,
        timeToNextEvent,
        currentPhase,
        params
      );
    }

    // Post-event signals
    if (
      currentPhase === EventPhase.POST_EVENT_IMMEDIATE ||
      currentPhase === EventPhase.POST_EVENT_NEAR
    ) {
      return this.generatePostEventSignal(context, eventContext.recentEvents, params);
    }

    return null;
  }

  /**
   * Generate signal during active events (cautious)
   */
  private generateDuringEventSignal(
    context: SignalContext,
    activeEvents: ScheduledEvent[],
    params: EventSignalParams
  ): {
    direction: SignalDirection;
    strength: number;
    confidence: number;
    metadata: Record<string, unknown>;
  } | null {
    // During events, we emit weak NEUTRAL signals to indicate high uncertainty
    // This allows position sizing to be reduced
    const mostImportant = this.getMostImportantEvent(activeEvents);

    if (!mostImportant) {
      return null;
    }

    return {
      direction: 'NEUTRAL',
      strength: 0,
      confidence: 0.2, // Low confidence during events
      metadata: {
        activeEventId: mostImportant.id,
        activeEventName: mostImportant.name,
        reason: 'high_uncertainty_during_event',
      },
    };
  }

  /**
   * Generate pre-event signal
   */
  private generatePreEventSignal(
    context: SignalContext,
    nextEvent: ScheduledEvent | null,
    timeToNextEvent: number | null,
    phase: EventPhase,
    params: EventSignalParams
  ): {
    direction: SignalDirection;
    strength: number;
    confidence: number;
    metadata: Record<string, unknown>;
  } | null {
    if (!nextEvent || timeToNextEvent === null) {
      return null;
    }

    // Check if event is important enough
    if (!this.isImportanceAboveThreshold(nextEvent.importance, params.minImportance)) {
      return null;
    }

    const hoursUntil = timeToNextEvent / (60 * 60 * 1000);

    // Too far out
    if (hoursUntil > params.maxHoursBeforeEvent) {
      return null;
    }

    // Get pattern for this event type
    const pattern = nextEvent.subType
      ? this.calendar.getPattern(nextEvent.subType)
      : undefined;

    // Calculate strength based on proximity
    let proximityFactor: number;
    if (phase === EventPhase.PRE_EVENT_IMMINENT) {
      proximityFactor = 1.0;
    } else if (phase === EventPhase.PRE_EVENT_NEAR) {
      proximityFactor = 0.7;
    } else {
      proximityFactor = 0.4;
    }

    // Importance multiplier
    const importanceMultiplier = this.getImportanceMultiplier(nextEvent.importance);

    // Base strength from pattern or default
    const baseStrength = pattern?.avgPriceImpact ?? 0.15;

    // Calculate final strength
    let strength = baseStrength * proximityFactor * importanceMultiplier * params.strengthMultiplier;

    // Determine direction based on event uncertainty increase
    // FIXED: Don't assume mean-reversion to 0.5 - prediction market prices reflect actual probabilities
    // Instead, signal increased volatility/uncertainty before events without directional bias
    const currentPrice = context.priceBars[context.priceBars.length - 1]?.close ?? 0.5;
    let direction: SignalDirection;

    // Pre-event: Focus on volatility expansion, not directional prediction
    // Only provide weak directional signal for extreme prices where mean-reversion is more likely
    if (currentPrice < 0.1 || currentPrice > 0.9) {
      // Extreme prices: weak contrarian signal (event may cause reversion)
      direction = currentPrice < 0.5 ? 'LONG' : 'SHORT';
      strength = Math.abs(strength) * 0.3; // Weak signal - events can push prices further
    } else if (currentPrice < 0.2 || currentPrice > 0.8) {
      // Strong conviction prices: very weak contrarian
      direction = currentPrice < 0.5 ? 'LONG' : 'SHORT';
      strength = Math.abs(strength) * 0.15;
    } else {
      // Normal range: no directional signal, just volatility indication
      direction = 'NEUTRAL';
      strength = 0;
    }

    // Calculate confidence
    let confidence = 0.3;

    // Proximity increases confidence
    if (phase === EventPhase.PRE_EVENT_IMMINENT) {
      confidence += 0.2;
    } else if (phase === EventPhase.PRE_EVENT_NEAR) {
      confidence += 0.1;
    }

    // Pattern confidence
    if (pattern) {
      confidence += pattern.confidence * 0.2;
    }

    // Importance confidence
    if (nextEvent.importance === EventImportance.CRITICAL) {
      confidence += 0.15;
    } else if (nextEvent.importance === EventImportance.HIGH) {
      confidence += 0.1;
    }

    // Time confirmed adds confidence
    if (nextEvent.isTimeConfirmed) {
      confidence += 0.05;
    }

    return {
      direction,
      strength: Math.max(-1, Math.min(1, strength)),
      confidence: Math.min(1, confidence),
      metadata: {
        eventId: nextEvent.id,
        eventName: nextEvent.name,
        eventCategory: nextEvent.category,
        eventSubType: nextEvent.subType,
        hoursUntil: hoursUntil.toFixed(2),
        phase,
        patternBased: !!pattern,
        reason: 'pre_event_positioning',
      },
    };
  }

  /**
   * Generate post-event signal
   */
  private generatePostEventSignal(
    context: SignalContext,
    recentEvents: ScheduledEvent[],
    params: EventSignalParams
  ): {
    direction: SignalDirection;
    strength: number;
    confidence: number;
    metadata: Record<string, unknown>;
  } | null {
    if (recentEvents.length === 0) {
      return null;
    }

    const mostRecent = recentEvents[recentEvents.length - 1];

    // Check importance
    if (!this.isImportanceAboveThreshold(mostRecent.importance, params.minImportance)) {
      return null;
    }

    // Post-event, markets often consolidate or continue moving
    // This is a mean-reversion opportunity if there was a big move
    const currentPrice = context.priceBars[context.priceBars.length - 1]?.close ?? 0.5;

    // Check for potential mean reversion after big moves
    let direction: SignalDirection;
    let strength: number;

    if (currentPrice < 0.15 || currentPrice > 0.85) {
      // Extreme prices - potential for mean reversion
      direction = currentPrice < 0.5 ? 'LONG' : 'SHORT';
      strength = 0.15;
    } else if (currentPrice >= 0.4 && currentPrice <= 0.6) {
      // Middle range - follow momentum
      direction = 'NEUTRAL';
      strength = 0;
    } else {
      // Moderate levels
      direction = 'NEUTRAL';
      strength = 0;
    }

    strength *= params.strengthMultiplier;

    const confidence = 0.35 + (mostRecent.importance === EventImportance.CRITICAL ? 0.15 : 0);

    return {
      direction,
      strength,
      confidence,
      metadata: {
        eventId: mostRecent.id,
        eventName: mostRecent.name,
        reason: 'post_event_positioning',
      },
    };
  }

  /**
   * Get most important event from list
   */
  private getMostImportantEvent(events: ScheduledEvent[]): ScheduledEvent | null {
    if (events.length === 0) return null;

    return events.reduce((most, current) =>
      this.getImportanceMultiplier(current.importance) > this.getImportanceMultiplier(most.importance)
        ? current
        : most
    );
  }

  /**
   * Get multiplier for importance level
   */
  private getImportanceMultiplier(importance: EventImportance): number {
    switch (importance) {
      case EventImportance.CRITICAL:
        return 2.0;
      case EventImportance.HIGH:
        return 1.5;
      case EventImportance.MEDIUM:
        return 1.0;
      case EventImportance.LOW:
        return 0.5;
      default:
        return 0.5;
    }
  }

  /**
   * Check if importance meets threshold
   */
  private isImportanceAboveThreshold(
    importance: EventImportance,
    threshold: EventImportance
  ): boolean {
    const levels: Record<EventImportance, number> = {
      [EventImportance.LOW]: 1,
      [EventImportance.MEDIUM]: 2,
      [EventImportance.HIGH]: 3,
      [EventImportance.CRITICAL]: 4,
    };
    return levels[importance] >= levels[threshold];
  }

  /**
   * Convert phase to numeric value for features
   */
  private phaseToNumber(phase: EventPhase): number {
    switch (phase) {
      case EventPhase.PRE_EVENT_DISTANT:
        return -3;
      case EventPhase.PRE_EVENT_NEAR:
        return -2;
      case EventPhase.PRE_EVENT_IMMINENT:
        return -1;
      case EventPhase.DURING_EVENT:
        return 0;
      case EventPhase.POST_EVENT_IMMEDIATE:
        return 1;
      case EventPhase.POST_EVENT_NEAR:
        return 2;
      case EventPhase.POST_EVENT_DISTANT:
        return 3;
      case EventPhase.NO_EVENT:
      default:
        return -99;
    }
  }
}
