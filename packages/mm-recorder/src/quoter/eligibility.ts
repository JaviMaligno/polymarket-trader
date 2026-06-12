export interface EligibilityRow {
  hour: Date; marketId: string; eligibleMinutes: number; quotedMinutes: number;
}

/** Elegibilidad rewards por minuto EN MEMORIA; persistencia agregada por hora.
 *  (45 mercados x 1440 min/día en DB hundiría la e2-micro — spec §Operativa.) */
export class EligibilityTracker {
  // key marketId -> hourMs -> minute -> eligible
  private acc = new Map<string, Map<number, Map<number, boolean>>>();

  sample(marketId: string, time: Date, eligible: boolean): void {
    const hourMs = Date.UTC(time.getUTCFullYear(), time.getUTCMonth(), time.getUTCDate(), time.getUTCHours());
    const minute = time.getUTCMinutes();
    const hours = this.acc.get(marketId) ?? new Map();
    const mins = hours.get(hourMs) ?? new Map();
    mins.set(minute, (mins.get(minute) ?? false) || eligible);
    hours.set(hourMs, mins);
    this.acc.set(marketId, hours);
  }

  /** Devuelve y purga las horas COMPLETADAS (anteriores a la hora de `now`). */
  flushHour(now: Date): EligibilityRow[] {
    const nowHour = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours());
    const out: EligibilityRow[] = [];
    for (const [marketId, hours] of this.acc) {
      for (const [hourMs, mins] of hours) {
        if (hourMs >= nowHour) continue;
        let eligible = 0;
        for (const e of mins.values()) if (e) eligible += 1;
        out.push({ hour: new Date(hourMs), marketId, eligibleMinutes: eligible, quotedMinutes: mins.size });
        hours.delete(hourMs);
      }
    }
    return out.sort((a, b) => a.hour.getTime() - b.hour.getTime() || a.marketId.localeCompare(b.marketId));
  }
}
