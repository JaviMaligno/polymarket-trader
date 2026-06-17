import { pino } from 'pino';

const logger = pino({ name: 'mm-live-risk' });

export interface RiskLimits {
  maxInvPerMarket: number; maxInvTotal: number; maxNotionalTotal: number; maxCumLoss: number;
}

export interface RiskSnapshot {
  totalNotional: number;      // notional de inventario total (abs $)
  maxInvNotional: number;     // mayor inventario por mercado (abs $)
  totalInvNotional: number;   // inventario total (abs $)
  openNotional: number;       // Σ notional de órdenes abiertas
  cumPnl: number;             // realized + M2M
  balanceLow: boolean;
}

export type KillState = 'running' | 'killed';

export class RiskGuard {
  private killState: KillState = 'running';
  constructor(
    private readonly limits: RiskLimits,
    private readonly onKill: () => Promise<void>,
    private readonly persistState: (s: object) => Promise<void>,
    private readonly notify: (type: string, payload: object) => Promise<void>,
  ) {}

  state(): KillState { return this.killState; }

  private breach(s: RiskSnapshot): string | null {
    if (s.balanceLow) return 'balance_low';
    if (s.cumPnl <= -this.limits.maxCumLoss) return 'max_cum_loss';
    if (s.maxInvNotional > this.limits.maxInvPerMarket) return 'inventory_per_market';
    if (s.totalInvNotional > this.limits.maxInvTotal) return 'inventory_total';
    if (s.openNotional > this.limits.maxNotionalTotal) return 'notional_total';
    return null;
  }

  async check(s: RiskSnapshot): Promise<void> {
    if (this.killState === 'killed') return;
    const reason = this.breach(s);
    if (!reason) return;
    this.killState = 'killed';
    logger.error({ reason, snapshot: s }, 'RISK KILL — cancelando todo y pasando a off');
    await this.onKill().catch((e) => logger.error({ e }, 'onKill falló'));
    await this.persistState({ kill_state: 'killed', mode: 'off', reason, at: new Date().toISOString() })
      .catch((e) => logger.error({ e }, 'persistState falló'));
    await this.notify('mm_kill_switch', { reason, snapshot: s }).catch(() => undefined);
  }
}
