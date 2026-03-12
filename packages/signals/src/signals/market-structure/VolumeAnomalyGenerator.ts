import { BaseSignal } from '../../core/base/BaseSignal.js';
import type {
  SignalContext,
  SignalOutput,
} from '../../core/types/signal.types.js';

interface VolumeAnomalyParams extends Record<string, unknown> {
  lookbackDays: number;
  zScoreThreshold: number;
  minBars: number;
}

/**
 * VolumeAnomalyGenerator
 *
 * Detects statistically significant volume spikes using z-score analysis.
 * A spike is confirmed when current volume exceeds the baseline by
 * `zScoreThreshold` standard deviations. Direction is determined by
 * whether the price is rising or falling relative to the baseline close.
 */
export class VolumeAnomalyGenerator extends BaseSignal<VolumeAnomalyParams> {
  readonly signalId = 'volume_anomaly';
  readonly name = 'Volume Anomaly';
  readonly description =
    'Detects statistically significant volume spikes via z-score analysis';

  protected parameters: VolumeAnomalyParams = {
    lookbackDays: 7,
    zScoreThreshold: 2.0,
    minBars: 14,
  };

  getRequiredLookback(): number {
    return 14;
  }

  async compute(context: SignalContext): Promise<SignalOutput | null> {
    const { minBars, zScoreThreshold } = this.parameters;
    const bars = context.priceBars;

    // 1. Require minimum bars
    if (bars.length < minBars) {
      return null;
    }

    // 2. Baseline = all bars except last 2
    const baseline = bars.slice(0, bars.length - 2);
    const baselineVolumes = baseline.map(b => b.volume);

    // 3. Mean and stddev of baseline volumes
    const n = baselineVolumes.length;
    const mean = baselineVolumes.reduce((a, b) => a + b, 0) / n;
    const variance =
      baselineVolumes.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / n;
    const stddev = Math.sqrt(variance);

    // 4. Guard: no variance or empty baseline
    if (stddev === 0 || mean === 0) {
      return null;
    }

    // 5. Current volume = average of last 2 bars
    const last2 = bars.slice(-2);
    const currentVolume = (last2[0].volume + last2[1].volume) / 2;

    // 6. Z-score
    const zScore = (currentVolume - mean) / stddev;

    // 7. Threshold check
    if (zScore < zScoreThreshold) {
      return null;
    }

    // 8. Direction: last bar close vs baseline's last bar close
    const lastClose = bars[bars.length - 1].close;
    const baselineLastClose = baseline[baseline.length - 1].close;
    const rising = lastClose >= baselineLastClose;
    const direction = rising ? 'LONG' : 'SHORT';

    // 9. Strength: scaled by z-score, signed by direction
    const rawStrength = Math.min(1.0, 0.25 * zScore);
    const strength = rising ? rawStrength : -rawStrength;

    // 10. Confidence
    const confidence = Math.min(1.0, 0.2 + 0.2 * zScore);

    // 11. Return output
    return this.createOutput(context, direction, strength, confidence, {
      metadata: {
        zScore,
        currentVolume,
        baselineMean: mean,
        baselineStddev: stddev,
        lastClose,
        baselineLastClose,
      },
    });
  }
}
