/** Half-spread crossing cost as a percentage of NO stake. */
export function computeEntryCostPct(spread: number, yesPrice: number): number {
  const noMid = 1 - yesPrice;
  return ((spread / 2) / noMid) * 100;
}

/** Price actually paid for NO on the spread path = NO mid + half-spread. */
export function computeExecutedNoPrice(yesPrice: number, spread: number): number {
  return (1 - yesPrice) + spread / 2;
}

/** Per-position stake in dollars. maxPositionPct is in percentage points. */
export function computeStake(initialCapital: number, maxPositionPct: number): number {
  return (maxPositionPct / 100) * initialCapital;
}

/** Settle a held NO position at resolution (par). */
export function settle(
  noStake: number, noSize: number, feePaid: number, outcome: 'yes' | 'no',
): { grossPnl: number; netPnl: number } {
  if (outcome === 'no') {
    const payout = noSize * 1.0;
    const grossPnl = payout - noStake;
    return { grossPnl, netPnl: grossPnl - feePaid };
  }
  return { grossPnl: -noStake, netPnl: -noStake - feePaid };
}

/** ISO-8601 week key, e.g. "2026-W23", computed in UTC. */
export function isoWeekKey(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;             // Mon=0..Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3);       // nearest Thursday
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(
    ((date.getTime() - firstThursday.getTime()) / 86_400_000
      - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7,
  );
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
