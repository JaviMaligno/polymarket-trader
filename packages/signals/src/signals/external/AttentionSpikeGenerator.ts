import { BaseSignal } from '../../core/base/BaseSignal.js';
import type { SignalContext, SignalOutput } from '../../core/types/signal.types.js';

interface AttentionSpikeParams extends Record<string, unknown> {
  spikeThreshold: number;
  maxMultiplier: number;
}

/**
 * Amplifies other signals when Google Trends shows elevated search interest.
 * Fires NEUTRAL with a confidenceMultiplier in metadata so combiners can
 * scale confidence of co-occurring directional signals.
 */
export class AttentionSpikeGenerator extends BaseSignal<AttentionSpikeParams> {
  readonly signalId = 'attention_spike';
  readonly name = 'Attention Spike Detector';
  readonly description =
    'Amplifies other signals when Google Trends shows elevated search interest';

  protected parameters: AttentionSpikeParams = {
    spikeThreshold: 2.0,
    maxMultiplier: 1.5,
  };

  async compute(context: SignalContext): Promise<SignalOutput | null> {
    const currentInterest = context.custom?.currentInterest as number | undefined;
    const baselineInterest = context.custom?.baselineInterest as number | undefined;

    // Guard: both values must be present and positive
    if (!currentInterest || !baselineInterest || currentInterest <= 0 || baselineInterest <= 0) {
      return null;
    }

    const ratio = currentInterest / baselineInterest;
    const { spikeThreshold, maxMultiplier } = this.parameters;

    // Only fire when ratio meets or exceeds the spike threshold
    if (ratio < spikeThreshold) {
      return null;
    }

    const strength = Math.min(1.0, 0.2 * ratio);
    const confidence = Math.min(1.0, 0.3 + 0.1 * ratio);
    const confidenceMultiplier = Math.min(maxMultiplier, 1.0 + (ratio - 1) * 0.1);

    const metadata = {
      currentInterest,
      baselineInterest,
      spikeRatio: ratio,
      confidenceMultiplier,
    };

    return this.createOutput(context, 'NEUTRAL', strength, confidence, { metadata });
  }

  getRequiredLookback(): number {
    return 0;
  }

  isReady(context: SignalContext): boolean {
    return (
      context.custom?.currentInterest !== undefined &&
      context.custom?.baselineInterest !== undefined
    );
  }
}
