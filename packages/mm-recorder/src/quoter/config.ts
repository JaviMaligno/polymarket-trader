export interface QuoterConfig {
  mode: 'off' | 'shadow' | 'live';
  quoteSize: number;
  orderTtlMs: number;
  requoteMinMs: number;
  nearResolutionMs: number;
  minSpread: number;
  volPause: number;
  volWindowMs: number;
  maxInvPerMarket: number;
  maxInvTotal: number;
  maxCumLoss: number;
  maxNotionalTotal: number;
  fillPollMs: number;
  walletSecretName: string;
  liveSubset: string[];
  softInvPerMarket: number;
  tick: number;
}

const num = (v: string | undefined, d: number): number => {
  if (v === undefined || v === '') return d;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Config inválida: se esperaba número, llegó "${v}"`);
  return n;
};

export function loadConfig(env: Record<string, string | undefined>): QuoterConfig {
  const mode = env.MM_QUOTER_MODE ?? 'off';
  if (mode !== 'off' && mode !== 'shadow' && mode !== 'live') {
    throw new Error(`MM_QUOTER_MODE inválido: ${mode}`);
  }
  return {
    mode,
    quoteSize: num(env.MM_QUOTE_SIZE, 20),
    orderTtlMs: num(env.MM_ORDER_TTL_MS, 30 * 60_000),
    requoteMinMs: num(env.MM_REQUOTE_MIN_MS, 1000),
    nearResolutionMs: num(env.MM_NEAR_RESOLUTION_HOURS, 24) * 3_600_000,
    // shadow-permissive defaults: quote everything and measure; live tightens with data
    minSpread: num(env.MM_MIN_SPREAD, 0),
    volPause: num(env.MM_VOL_PAUSE, Infinity),
    volWindowMs: num(env.MM_VOL_WINDOW_MS, 60_000),
    maxInvPerMarket: num(env.MM_MAX_INVENTORY_PER_MARKET, 20),
    maxInvTotal: num(env.MM_MAX_INVENTORY_TOTAL, 60),
    maxCumLoss: num(env.MM_MAX_CUM_LOSS, 50),
    maxNotionalTotal: num(env.MM_MAX_NOTIONAL_TOTAL, 100),
    fillPollMs: num(env.MM_FILL_POLL_MS, 3000),
    walletSecretName: env.MM_WALLET_SECRET_NAME ?? '',
    liveSubset: (env.MM_LIVE_SUBSET ?? '')
      .split(',').map((s) => s.trim()).filter((s) => s.length > 0),
    softInvPerMarket: num(env.MM_SOFT_INVENTORY_PER_MARKET, 10),
    tick: num(env.MM_TICK, 0.01),
  };
}
