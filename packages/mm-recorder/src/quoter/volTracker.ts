interface Sample { time: number; mid: number }

export class VolTracker {
  private samples = new Map<string, Sample[]>();
  constructor(private windowMs: number) {}

  add(tokenId: string, time: Date, mid: number): void {
    const arr = this.samples.get(tokenId) ?? [];
    arr.push({ time: time.getTime(), mid });
    const cutoff = time.getTime() - this.windowMs;
    while (arr.length && arr[0].time < cutoff) arr.shift();
    this.samples.set(tokenId, arr);
  }

  /** max(mid) − min(mid) among samples within the window. */
  recentVol(tokenId: string, now: Date): number {
    const cutoff = now.getTime() - this.windowMs;
    const arr = (this.samples.get(tokenId) ?? []).filter((s) => s.time >= cutoff);
    if (arr.length < 2) return 0;
    let lo = Infinity, hi = -Infinity;
    for (const s of arr) { if (s.mid < lo) lo = s.mid; if (s.mid > hi) hi = s.mid; }
    return hi - lo;
  }
}
