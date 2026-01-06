/**
 * Alert System
 *
 * Handles notification delivery across multiple channels:
 * console, webhooks, Slack, email, etc.
 */

import pino from 'pino';
import { EventEmitter } from 'eventemitter3';
import type {
  Alert,
  AlertConfig,
  AlertChannel,
  AlertSeverity,
} from '../types/index.js';

const logger = pino({ name: 'AlertSystem' });

// ============================================
// Types
// ============================================

export interface AlertSystemEvents {
  'sent': (alert: Alert, channel: AlertChannel) => void;
  'failed': (alert: Alert, channel: AlertChannel, error: Error) => void;
  'suppressed': (alert: Alert, reason: string) => void;
}

export interface AlertRule {
  id: string;
  name: string;
  condition: (data: Record<string, unknown>) => boolean;
  severity: AlertSeverity;
  title: string;
  message: (data: Record<string, unknown>) => string;
  channels?: AlertChannel[];
  cooldownMs?: number;
  enabled: boolean;
}

interface RateLimitState {
  minute: { count: number; resetAt: number };
  hour: { count: number; resetAt: number };
}

// ============================================
// Default Configuration
// ============================================

const DEFAULT_CONFIG: AlertConfig = {
  channels: ['CONSOLE'],
  minSeverity: 'INFO',
  rateLimit: {
    maxPerMinute: 10,
    maxPerHour: 100,
  },
};

// ============================================
// Alert System
// ============================================

export class AlertSystem extends EventEmitter<AlertSystemEvents> {
  private config: AlertConfig;
  private rules: Map<string, AlertRule> = new Map();
  private alertHistory: Alert[] = [];
  private rateLimitState: RateLimitState;
  private lastAlertByRule: Map<string, number> = new Map();
  private alertCount: number = 0;

  constructor(config?: Partial<AlertConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.rateLimitState = {
      minute: { count: 0, resetAt: Date.now() + 60000 },
      hour: { count: 0, resetAt: Date.now() + 3600000 },
    };
  }

  // ============================================
  // Alert Sending
  // ============================================

  /**
   * Send an alert
   */
  async send(alert: Alert): Promise<boolean> {
    // Check minimum severity
    if (!this.meetsSeverityThreshold(alert.severity)) {
      this.emit('suppressed', alert, 'Below minimum severity');
      return false;
    }

    // Check rate limits
    if (!this.checkRateLimits()) {
      this.emit('suppressed', alert, 'Rate limit exceeded');
      logger.warn({ alertId: alert.id }, 'Alert suppressed due to rate limit');
      return false;
    }

    // Store in history
    this.alertHistory.push(alert);
    if (this.alertHistory.length > 1000) {
      this.alertHistory = this.alertHistory.slice(-1000);
    }

    // Update rate limit counters
    this.incrementRateLimits();

    // Send to all configured channels
    const results = await Promise.allSettled(
      this.config.channels.map(channel => this.sendToChannel(alert, channel))
    );

    // Check if at least one succeeded
    return results.some(r => r.status === 'fulfilled');
  }

  /**
   * Create and send an alert
   */
  async createAndSend(
    severity: AlertSeverity,
    title: string,
    message: string,
    source: string,
    data?: Record<string, unknown>
  ): Promise<Alert> {
    const alert: Alert = {
      id: `alert_${++this.alertCount}_${Date.now()}`,
      severity,
      title,
      message,
      timestamp: new Date(),
      source,
      data,
      acknowledged: false,
    };

    await this.send(alert);
    return alert;
  }

  /**
   * Send to a specific channel
   */
  private async sendToChannel(alert: Alert, channel: AlertChannel): Promise<void> {
    try {
      switch (channel) {
        case 'CONSOLE':
          this.sendToConsole(alert);
          break;
        case 'WEBHOOK':
          await this.sendToWebhook(alert);
          break;
        case 'SLACK':
          await this.sendToSlack(alert);
          break;
        case 'EMAIL':
          await this.sendToEmail(alert);
          break;
        case 'SMS':
          await this.sendToSms(alert);
          break;
      }

      this.emit('sent', alert, channel);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.emit('failed', alert, channel, err);
      logger.error({ alertId: alert.id, channel, error: err.message }, 'Failed to send alert');
      throw err;
    }
  }

  /**
   * Send to console
   */
  private sendToConsole(alert: Alert): void {
    const emoji = this.getSeverityEmoji(alert.severity);
    const timestamp = alert.timestamp.toISOString();
    const prefix = `${emoji} [${alert.severity}] ${timestamp}`;

    switch (alert.severity) {
      case 'CRITICAL':
      case 'ERROR':
        console.error(`${prefix}\n  ${alert.title}\n  ${alert.message}`);
        break;
      case 'WARNING':
        console.warn(`${prefix}\n  ${alert.title}\n  ${alert.message}`);
        break;
      default:
        console.log(`${prefix}\n  ${alert.title}\n  ${alert.message}`);
    }
  }

  /**
   * Send to webhook
   */
  private async sendToWebhook(alert: Alert): Promise<void> {
    if (!this.config.webhookUrl) {
      throw new Error('Webhook URL not configured');
    }

    const response = await fetch(this.config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: alert.id,
        severity: alert.severity,
        title: alert.title,
        message: alert.message,
        timestamp: alert.timestamp.toISOString(),
        source: alert.source,
        data: alert.data,
      }),
    });

    if (!response.ok) {
      throw new Error(`Webhook failed: ${response.status}`);
    }
  }

  /**
   * Send to Slack
   */
  private async sendToSlack(alert: Alert): Promise<void> {
    if (!this.config.slackWebhookUrl) {
      throw new Error('Slack webhook URL not configured');
    }

    const color = this.getSeverityColor(alert.severity);
    const emoji = this.getSeverityEmoji(alert.severity);

    const payload = {
      attachments: [
        {
          color,
          blocks: [
            {
              type: 'header',
              text: {
                type: 'plain_text',
                text: `${emoji} ${alert.title}`,
                emoji: true,
              },
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: alert.message,
              },
            },
            {
              type: 'context',
              elements: [
                {
                  type: 'mrkdwn',
                  text: `*Source:* ${alert.source} | *Severity:* ${alert.severity} | *Time:* ${alert.timestamp.toISOString()}`,
                },
              ],
            },
          ],
        },
      ],
    };

    const response = await fetch(this.config.slackWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Slack webhook failed: ${response.status}`);
    }
  }

  /**
   * Send to email (placeholder)
   */
  private async sendToEmail(alert: Alert): Promise<void> {
    if (!this.config.emailConfig) {
      throw new Error('Email not configured');
    }

    // In production, would use nodemailer or similar
    logger.info({
      to: this.config.emailConfig.to,
      subject: `[${alert.severity}] ${alert.title}`,
    }, 'Email alert (placeholder)');
  }

  /**
   * Send to SMS (placeholder)
   */
  private async sendToSms(alert: Alert): Promise<void> {
    // In production, would use Twilio or similar
    logger.info({ severity: alert.severity, title: alert.title }, 'SMS alert (placeholder)');
  }

  // ============================================
  // Alert Rules
  // ============================================

  /**
   * Register an alert rule
   */
  registerRule(rule: AlertRule): void {
    this.rules.set(rule.id, rule);
    logger.info({ ruleId: rule.id, name: rule.name }, 'Alert rule registered');
  }

  /**
   * Unregister an alert rule
   */
  unregisterRule(ruleId: string): void {
    this.rules.delete(ruleId);
  }

  /**
   * Evaluate all rules against data
   */
  async evaluateRules(data: Record<string, unknown>, source: string): Promise<Alert[]> {
    const alerts: Alert[] = [];

    for (const rule of this.rules.values()) {
      if (!rule.enabled) continue;

      // Check cooldown
      const lastAlert = this.lastAlertByRule.get(rule.id);
      if (lastAlert && rule.cooldownMs) {
        if (Date.now() - lastAlert < rule.cooldownMs) {
          continue;
        }
      }

      try {
        if (rule.condition(data)) {
          const alert = await this.createAndSend(
            rule.severity,
            rule.title,
            rule.message(data),
            source,
            data
          );

          this.lastAlertByRule.set(rule.id, Date.now());
          alerts.push(alert);
        }
      } catch (error) {
        logger.error({ ruleId: rule.id, error }, 'Error evaluating rule');
      }
    }

    return alerts;
  }

  /**
   * Get registered rules
   */
  getRules(): AlertRule[] {
    return Array.from(this.rules.values());
  }

  /**
   * Enable/disable a rule
   */
  setRuleEnabled(ruleId: string, enabled: boolean): void {
    const rule = this.rules.get(ruleId);
    if (rule) {
      rule.enabled = enabled;
    }
  }

  // ============================================
  // Pre-defined Rules
  // ============================================

  /**
   * Register common trading alert rules
   */
  registerDefaultRules(): void {
    // Large drawdown
    this.registerRule({
      id: 'large_drawdown',
      name: 'Large Drawdown',
      condition: (data) => (data.drawdown as number) > 0.1,
      severity: 'WARNING',
      title: 'Large Drawdown Detected',
      message: (data) => `Portfolio drawdown is ${((data.drawdown as number) * 100).toFixed(1)}%`,
      cooldownMs: 300000, // 5 minutes
      enabled: true,
    });

    // Critical drawdown
    this.registerRule({
      id: 'critical_drawdown',
      name: 'Critical Drawdown',
      condition: (data) => (data.drawdown as number) > 0.2,
      severity: 'CRITICAL',
      title: 'Critical Drawdown',
      message: (data) => `Portfolio drawdown has reached ${((data.drawdown as number) * 100).toFixed(1)}%!`,
      cooldownMs: 60000, // 1 minute
      enabled: true,
    });

    // Daily loss limit
    this.registerRule({
      id: 'daily_loss',
      name: 'Daily Loss Limit',
      condition: (data) => (data.dailyLoss as number) > (data.dailyLossLimit as number) * 0.8,
      severity: 'WARNING',
      title: 'Approaching Daily Loss Limit',
      message: (data) => `Daily loss is $${(data.dailyLoss as number).toFixed(2)} (${((data.dailyLoss as number) / (data.dailyLossLimit as number) * 100).toFixed(0)}% of limit)`,
      cooldownMs: 300000,
      enabled: true,
    });

    // Position concentration
    this.registerRule({
      id: 'concentration',
      name: 'Position Concentration',
      condition: (data) => (data.concentration as number) > 0.5,
      severity: 'WARNING',
      title: 'High Position Concentration',
      message: (data) => `Portfolio concentration index is ${((data.concentration as number) * 100).toFixed(0)}%`,
      cooldownMs: 600000,
      enabled: true,
    });

    // Trade execution failure
    this.registerRule({
      id: 'trade_failure',
      name: 'Trade Failure',
      condition: (data) => data.orderStatus === 'REJECTED',
      severity: 'ERROR',
      title: 'Trade Rejected',
      message: (data) => `Order ${data.orderId} was rejected: ${data.reason}`,
      enabled: true,
    });

    // System health
    this.registerRule({
      id: 'high_latency',
      name: 'High Latency',
      condition: (data) => (data.latencyMs as number) > 1000,
      severity: 'WARNING',
      title: 'High System Latency',
      message: (data) => `System latency is ${data.latencyMs}ms`,
      cooldownMs: 60000,
      enabled: true,
    });

    // Feed disconnection
    this.registerRule({
      id: 'feed_disconnect',
      name: 'Feed Disconnection',
      condition: (data) => data.feedStatus === 'DISCONNECTED' || data.feedStatus === 'ERROR',
      severity: 'ERROR',
      title: 'Data Feed Disconnected',
      message: (data) => `Data feed status: ${data.feedStatus}${data.feedError ? ` - ${data.feedError}` : ''}`,
      enabled: true,
    });

    logger.info('Default alert rules registered');
  }

  // ============================================
  // Rate Limiting
  // ============================================

  /**
   * Check if within rate limits
   */
  private checkRateLimits(): boolean {
    const now = Date.now();

    // Reset minute counter if needed
    if (now > this.rateLimitState.minute.resetAt) {
      this.rateLimitState.minute = { count: 0, resetAt: now + 60000 };
    }

    // Reset hour counter if needed
    if (now > this.rateLimitState.hour.resetAt) {
      this.rateLimitState.hour = { count: 0, resetAt: now + 3600000 };
    }

    const limits = this.config.rateLimit;
    if (!limits) return true;

    return (
      this.rateLimitState.minute.count < limits.maxPerMinute &&
      this.rateLimitState.hour.count < limits.maxPerHour
    );
  }

  /**
   * Increment rate limit counters
   */
  private incrementRateLimits(): void {
    this.rateLimitState.minute.count++;
    this.rateLimitState.hour.count++;
  }

  // ============================================
  // Helpers
  // ============================================

  /**
   * Check if severity meets threshold
   */
  private meetsSeverityThreshold(severity: AlertSeverity): boolean {
    const levels: AlertSeverity[] = ['INFO', 'WARNING', 'ERROR', 'CRITICAL'];
    const alertLevel = levels.indexOf(severity);
    const minLevel = levels.indexOf(this.config.minSeverity);
    return alertLevel >= minLevel;
  }

  /**
   * Get emoji for severity
   */
  private getSeverityEmoji(severity: AlertSeverity): string {
    switch (severity) {
      case 'INFO': return 'i';
      case 'WARNING': return '!';
      case 'ERROR': return 'X';
      case 'CRITICAL': return '!!!';
    }
  }

  /**
   * Get color for severity (Slack)
   */
  private getSeverityColor(severity: AlertSeverity): string {
    switch (severity) {
      case 'INFO': return '#36a64f';
      case 'WARNING': return '#ff9800';
      case 'ERROR': return '#f44336';
      case 'CRITICAL': return '#b71c1c';
    }
  }

  /**
   * Get alert history
   */
  getHistory(count?: number): Alert[] {
    return count ? this.alertHistory.slice(-count) : [...this.alertHistory];
  }

  /**
   * Clear alert history
   */
  clearHistory(): void {
    this.alertHistory = [];
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<AlertConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

/**
 * Create an alert system
 */
export function createAlertSystem(config?: Partial<AlertConfig>): AlertSystem {
  return new AlertSystem(config);
}
