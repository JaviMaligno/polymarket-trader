/**
 * Database Event Listener
 *
 * Listens for PostgreSQL NOTIFY events on a dedicated connection (outside the pool).
 * When data-collector completes a price sync, it sends pg_notify('price_sync_complete').
 * This service receives it and emits 'price:refreshed' locally for consumers
 * (StopLoss, SignalEngine, etc.) to react to fresh data.
 *
 * Features:
 * - Dedicated pg.Client (not from pool) for LISTEN
 * - Auto-reconnect with exponential backoff
 * - 5s debounce to coalesce rapid notifications
 */

import { EventEmitter } from 'events';
import pg from 'pg';

const CHANNEL = 'price_sync_complete';
const DEBOUNCE_MS = 5000;
const INITIAL_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 30000;

export class DbEventListener extends EventEmitter {
  private client: pg.Client | null = null;
  private isRunning = false;
  private reconnectMs = INITIAL_RECONNECT_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private lastNotification: Date | null = null;
  private notificationCount = 0;

  /**
   * Start listening for database events
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[DbEventListener] Already running');
      return;
    }

    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      console.warn('[DbEventListener] DATABASE_URL not set - cannot start');
      return;
    }

    this.isRunning = true;
    await this.connect();
  }

  /**
   * Stop listening and clean up
   */
  async stop(): Promise<void> {
    this.isRunning = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.client) {
      try {
        await this.client.end();
      } catch {
        // ignore close errors
      }
      this.client = null;
    }

    console.log('[DbEventListener] Stopped');
  }

  /**
   * Connect and subscribe to LISTEN channel
   */
  private async connect(): Promise<void> {
    if (!this.isRunning) return;

    try {
      const connectionString = process.env.DATABASE_URL;
      const isCloudDb = connectionString?.includes('timescale.com') ||
                        connectionString?.includes('sslmode=require');

      this.client = new pg.Client({
        connectionString,
        ssl: isCloudDb ? { rejectUnauthorized: false } : undefined,
        application_name: 'dashboard-event-listener',
      });

      this.client.on('error', (err) => {
        console.error('[DbEventListener] Connection error:', err.message);
        this.scheduleReconnect();
      });

      this.client.on('end', () => {
        if (this.isRunning && this.client) {
          console.warn('[DbEventListener] Connection closed unexpectedly');
          this.scheduleReconnect();
        }
      });

      this.client.on('notification', (msg) => {
        if (msg.channel === CHANNEL) {
          this.handleNotification(msg.payload);
        }
      });

      await this.client.connect();
      await this.client.query(`LISTEN ${CHANNEL}`);

      this.reconnectMs = INITIAL_RECONNECT_MS; // Reset backoff on success
      console.log(`[DbEventListener] Listening on channel '${CHANNEL}'`);

    } catch (err: any) {
      console.error('[DbEventListener] Failed to connect:', err.message);
      this.scheduleReconnect();
    }
  }

  /**
   * Handle incoming notification with debounce
   */
  private handleNotification(payload: string | undefined): void {
    // Debounce: if we got a notification recently, skip
    if (this.debounceTimer) {
      return;
    }

    this.lastNotification = new Date();
    this.notificationCount++;

    let parsed: any = {};
    if (payload) {
      try { parsed = JSON.parse(payload); } catch { /* ignore */ }
    }

    console.log(`[DbEventListener] Received ${CHANNEL}${parsed.inserted ? ` (${parsed.inserted} rows)` : ''}`);
    this.emit('price:refreshed', parsed);

    // Set debounce window
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
    }, DEBOUNCE_MS);
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private scheduleReconnect(): void {
    if (!this.isRunning || this.reconnectTimer) return;

    // Clean up old client
    if (this.client) {
      try { this.client.end().catch(() => {}); } catch { /* ignore */ }
      this.client = null;
    }

    console.log(`[DbEventListener] Reconnecting in ${this.reconnectMs / 1000}s...`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      await this.connect();
    }, this.reconnectMs);

    // Exponential backoff
    this.reconnectMs = Math.min(this.reconnectMs * 2, MAX_RECONNECT_MS);
  }

  /**
   * Get listener status
   */
  getStats(): {
    isRunning: boolean;
    connected: boolean;
    lastNotification: Date | null;
    notificationCount: number;
  } {
    return {
      isRunning: this.isRunning,
      connected: this.client !== null,
      lastNotification: this.lastNotification,
      notificationCount: this.notificationCount,
    };
  }
}

// Singleton
let instance: DbEventListener | null = null;

export function getDbEventListener(): DbEventListener {
  if (!instance) {
    instance = new DbEventListener();
  }
  return instance;
}
