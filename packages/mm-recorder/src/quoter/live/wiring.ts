import type { QuoterConfig } from '../config.js';
import type { RewardsParams } from '../types.js';
import { LiveEngine } from './liveEngine.js';
import { LiveLedger } from './liveLedger.js';
import { RiskGuard } from './riskGuard.js';
import type { OrderGateway } from './orderGateway.js';
import type { LivePersistence } from './livePersistence.js';

export interface BuildLiveDeps {
  cfg: QuoterConfig;
  gateway: OrderGateway;
  persistence: LivePersistence;
  marketByToken: Map<string, string>;
  endDateByMarket: Map<string, Date>;
  rewardsByMarket: Map<string, RewardsParams>;
  onKill: () => Promise<void>;
  persistState: (s: object) => Promise<void>;
  notify: (type: string, payload: object) => Promise<void>;
}

/**
 * Arma el motor live: asegura el esquema, hace cancel-all incondicional al boot
 * (sin reconciliar órfanas — v1), y cablea LiveLedger + RiskGuard + LiveEngine.
 *
 * Scope v1: el piloto opera un subset pequeño (1-3 mercados). El LiveLedger
 * multi-market es una mejora posterior; v1 usa un ledger sobre el primer mercado
 * del subset. El límite se documenta en el runbook de activación.
 */
export async function buildLiveEngine(d: BuildLiveDeps): Promise<{ engine: LiveEngine; risk: RiskGuard }> {
  await d.persistence.ensureSchema();
  // cancel-all incondicional al arrancar (sin reconciliar órfanas — v1).
  await d.gateway.cancelAll();

  const firstMarket = d.cfg.liveSubset[0] ?? '';
  const ledger = new LiveLedger(d.persistence, firstMarket);

  const risk = new RiskGuard(
    {
      maxInvPerMarket: d.cfg.maxInvPerMarket,
      maxInvTotal: d.cfg.maxInvTotal,
      maxNotionalTotal: d.cfg.maxNotionalTotal,
      maxCumLoss: d.cfg.maxCumLoss,
    },
    d.onKill, d.persistState, d.notify,
  );

  const engine = new LiveEngine({
    cfg: d.cfg, gateway: d.gateway, ledger, risk,
    marketByToken: d.marketByToken, endDateByMarket: d.endDateByMarket, rewardsByMarket: d.rewardsByMarket,
  });
  return { engine, risk };
}
