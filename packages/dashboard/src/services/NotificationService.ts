import pino from 'pino';

const logger = pino({ name: 'NotificationService' });

type NotificationType = 'funds_warning' | 'funds_low' | 'mode_change' | 'trade_real' | 'error';

interface NotificationPayload {
  balance?: number;
  threshold?: number;
  from?: string;
  to?: string;
  by?: string;
  message?: string;
  [key: string]: unknown;
}

export class NotificationService {
  constructor(private readonly slackWebhookUrl: string) {}

  async notify(type: NotificationType, payload: NotificationPayload): Promise<void> {
    if (!this.slackWebhookUrl) {
      logger.debug({ type }, 'No webhook URL configured, skipping notification');
      return;
    }

    const text = this.formatMessage(type, payload);

    try {
      await fetch(this.slackWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      logger.info({ type }, 'Notification sent');
    } catch (err) {
      logger.error({ err, type }, 'Failed to send notification');
    }
  }

  private formatMessage(type: NotificationType, p: NotificationPayload): string {
    switch (type) {
      case 'funds_warning':
        return `Warning: Low USDC balance — $${p.balance} (threshold: $${p.threshold}). Consider depositing more funds.`;
      case 'funds_low':
        return `Funds critically low — $${p.balance} (min: $${p.threshold}). Switching to paper trading.`;
      case 'mode_change':
        return `Trading mode changed: ${p.from} → ${p.to} (by: ${p.by})`;
      case 'trade_real':
        return `Real trade executed — ${p.message}`;
      case 'error':
        return `Trading error — ${p.message}`;
      default:
        return `${type}: ${JSON.stringify(p)}`;
    }
  }
}

let instance: NotificationService | null = null;

export function getNotificationService(): NotificationService {
  if (!instance) {
    instance = new NotificationService(process.env.SLACK_WEBHOOK_URL || '');
  }
  return instance;
}
