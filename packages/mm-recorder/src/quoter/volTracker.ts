interface Sample { time: number; mid: number }

/**
 * Tracks recent mid-price volatility per token.
 * Volatility is computed as RANGE = max(mid) − min(mid) over all samples
 * within the rolling window — NOT the max single-step |Δmid|.
 */
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

  /**
   * Returns max(mid) − min(mid) among samples within the window (range, not max step).
   * Returns 0 if fewer than 2 samples are available.
   *
   * @param now - Event-time (not wall clock) on purpose: the engine replays
   *   deterministically from recorded events; do not remove this parameter.
   */
  recentVol(tokenId: string, now: Date): number {
    const cutoff = now.getTime() - this.windowMs;
    const arr = (this.samples.get(tokenId) ?? []).filter((s) => s.time >= cutoff);
    if (arr.length < 2) return 0;
    let lo = Infinity, hi = -Infinity;
    for (const s of arr) { if (s.mid < lo) lo = s.mid; if (s.mid > hi) hi = s.mid; }
    return hi - lo;
  }
}
