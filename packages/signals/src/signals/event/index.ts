/**
 * Event-Driven Signals
 *
 * Signals based on scheduled events that affect prediction markets.
 */

export * from './types.js';
export {
  EventCalendar,
  type EventCalendarConfig,
  type IEventProvider,
} from './EventCalendar.js';
export {
  EventDrivenSignal,
  type EventDrivenSignalConfig,
  DEFAULT_EVENT_SIGNAL_PARAMS,
} from './EventDrivenSignal.js';
