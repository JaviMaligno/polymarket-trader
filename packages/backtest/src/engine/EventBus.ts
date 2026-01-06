import { EventEmitter } from 'events';
import pino from 'pino';
import type { BacktestEvent, EventType } from '../types/index.js';

type EventHandler<T extends BacktestEvent = BacktestEvent> = (event: T) => void | Promise<void>;

interface QueuedEvent {
  event: BacktestEvent;
  priority: number;
}

/**
 * EventBus - Central event queue for the backtesting engine
 *
 * Handles event distribution, prioritization, and chronological ordering.
 * Supports both synchronous and asynchronous event handlers.
 */
export class EventBus {
  private emitter: EventEmitter;
  private eventQueue: QueuedEvent[] = [];
  private isProcessing = false;
  private logger: pino.Logger;

  // Event statistics
  private eventCounts: Map<EventType, number> = new Map();
  private lastEventTime: Date | null = null;

  // Priority mapping (lower = higher priority)
  private static readonly PRIORITY_MAP: Record<EventType, number> = {
    'TICK': 0,
    'PRICE_UPDATE': 1,
    'ORDER_BOOK_UPDATE': 1,
    'TRADE': 2,
    'SIGNAL': 3,
    'ORDER_PLACED': 4,
    'ORDER_FILLED': 5,
    'ORDER_CANCELLED': 5,
    'POSITION_OPENED': 6,
    'POSITION_CLOSED': 6,
    'MARKET_RESOLVED': 7,
  };

  constructor(options?: { maxListeners?: number }) {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(options?.maxListeners || 100);
    this.logger = pino({ name: 'EventBus' });
  }

  /**
   * Subscribe to a specific event type
   */
  on<T extends BacktestEvent>(eventType: EventType, handler: EventHandler<T>): void {
    this.emitter.on(eventType, handler as EventHandler);
  }

  /**
   * Subscribe to a specific event type (once only)
   */
  once<T extends BacktestEvent>(eventType: EventType, handler: EventHandler<T>): void {
    this.emitter.once(eventType, handler as EventHandler);
  }

  /**
   * Unsubscribe from a specific event type
   */
  off<T extends BacktestEvent>(eventType: EventType, handler: EventHandler<T>): void {
    this.emitter.off(eventType, handler as EventHandler);
  }

  /**
   * Subscribe to all events
   */
  onAny(handler: EventHandler): void {
    const eventTypes: EventType[] = [
      'TICK',
      'PRICE_UPDATE',
      'ORDER_BOOK_UPDATE',
      'TRADE',
      'SIGNAL',
      'ORDER_PLACED',
      'ORDER_FILLED',
      'ORDER_CANCELLED',
      'POSITION_OPENED',
      'POSITION_CLOSED',
      'MARKET_RESOLVED',
    ];

    for (const eventType of eventTypes) {
      this.emitter.on(eventType, handler);
    }
  }

  /**
   * Emit an event immediately (bypasses queue)
   */
  emit(event: BacktestEvent): void {
    this.updateStats(event);
    this.emitter.emit(event.type, event);
  }

  /**
   * Queue an event for processing
   * Events are processed in chronological order, with priority for same-timestamp events
   */
  enqueue(event: BacktestEvent): void {
    const priority = EventBus.PRIORITY_MAP[event.type] ?? 10;
    this.eventQueue.push({ event, priority });
  }

  /**
   * Queue multiple events
   */
  enqueueMany(events: BacktestEvent[]): void {
    for (const event of events) {
      this.enqueue(event);
    }
  }

  /**
   * Process all queued events in chronological order
   */
  async processQueue(): Promise<void> {
    if (this.isProcessing) {
      throw new Error('EventBus is already processing');
    }

    this.isProcessing = true;

    try {
      // Sort by timestamp, then by priority
      this.eventQueue.sort((a, b) => {
        const timeDiff = a.event.timestamp.getTime() - b.event.timestamp.getTime();
        if (timeDiff !== 0) return timeDiff;
        return a.priority - b.priority;
      });

      while (this.eventQueue.length > 0) {
        const queued = this.eventQueue.shift()!;
        await this.processEvent(queued.event);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Process events up to a specific timestamp
   */
  async processUntil(until: Date): Promise<void> {
    if (this.isProcessing) {
      throw new Error('EventBus is already processing');
    }

    this.isProcessing = true;

    try {
      // Sort queue
      this.eventQueue.sort((a, b) => {
        const timeDiff = a.event.timestamp.getTime() - b.event.timestamp.getTime();
        if (timeDiff !== 0) return timeDiff;
        return a.priority - b.priority;
      });

      // Process events up to timestamp
      while (this.eventQueue.length > 0) {
        const next = this.eventQueue[0];
        if (next.event.timestamp.getTime() > until.getTime()) {
          break;
        }

        const queued = this.eventQueue.shift()!;
        await this.processEvent(queued.event);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Process a single event
   */
  private async processEvent(event: BacktestEvent): Promise<void> {
    this.updateStats(event);

    const listeners = this.emitter.listeners(event.type);

    for (const listener of listeners) {
      try {
        const result = (listener as EventHandler)(event);
        if (result instanceof Promise) {
          await result;
        }
      } catch (error) {
        this.logger.error({ error, event }, 'Error processing event');
      }
    }
  }

  /**
   * Update event statistics
   */
  private updateStats(event: BacktestEvent): void {
    const count = this.eventCounts.get(event.type) || 0;
    this.eventCounts.set(event.type, count + 1);
    this.lastEventTime = event.timestamp;
  }

  /**
   * Get pending event count
   */
  getPendingCount(): number {
    return this.eventQueue.length;
  }

  /**
   * Get event statistics
   */
  getStats(): { counts: Record<EventType, number>; lastEventTime: Date | null } {
    const counts: Record<string, number> = {};
    for (const [type, count] of this.eventCounts) {
      counts[type] = count;
    }
    return {
      counts: counts as Record<EventType, number>,
      lastEventTime: this.lastEventTime,
    };
  }

  /**
   * Peek at the next event without removing it
   */
  peek(): BacktestEvent | null {
    if (this.eventQueue.length === 0) {
      return null;
    }

    // Sort to get the next chronological event
    this.eventQueue.sort((a, b) => {
      const timeDiff = a.event.timestamp.getTime() - b.event.timestamp.getTime();
      if (timeDiff !== 0) return timeDiff;
      return a.priority - b.priority;
    });

    return this.eventQueue[0].event;
  }

  /**
   * Clear all pending events
   */
  clear(): void {
    this.eventQueue = [];
  }

  /**
   * Reset the event bus
   */
  reset(): void {
    this.clear();
    this.eventCounts.clear();
    this.lastEventTime = null;
    this.emitter.removeAllListeners();
  }

  /**
   * Check if currently processing events
   */
  get processing(): boolean {
    return this.isProcessing;
  }
}
