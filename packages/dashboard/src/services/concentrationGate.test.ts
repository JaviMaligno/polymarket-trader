import { describe, it, expect, beforeEach } from 'vitest';
import { getKSigma, shouldBlockReopen, type PrevCloseSignal, type IncomingSignal } from './concentrationGate.js';

describe('getKSigma', () => {
  beforeEach(() => {
    delete process.env.OPTIMIZER_CONCENTRATION_K_SIGMA;
  });

  it('defaults to 1.0 when env var unset', () => {
    expect(getKSigma()).toBe(1.0);
  });

  it('honours valid env var override', () => {
    process.env.OPTIMIZER_CONCENTRATION_K_SIGMA = '1.5';
    expect(getKSigma()).toBe(1.5);
  });

  it('parses 0.5 correctly', () => {
    process.env.OPTIMIZER_CONCENTRATION_K_SIGMA = '0.5';
    expect(getKSigma()).toBe(0.5);
  });

  it('falls back to 1.0 on non-numeric env value', () => {
    process.env.OPTIMIZER_CONCENTRATION_K_SIGMA = 'abc';
    expect(getKSigma()).toBe(1.0);
  });

  it('falls back to 1.0 on zero or negative env value', () => {
    process.env.OPTIMIZER_CONCENTRATION_K_SIGMA = '0';
    expect(getKSigma()).toBe(1.0);
    process.env.OPTIMIZER_CONCENTRATION_K_SIGMA = '-1';
    expect(getKSigma()).toBe(1.0);
  });
});

describe('shouldBlockReopen', () => {
  const baseSigma = 0.353; // event_financial empirical
  const baseK = 1.0;

  it('allows when prevClose is null (first action on this market)', () => {
    const sig: IncomingSignal = { direction: 'long', strength: 0.5, confidence: 0.7 };
    expect(shouldBlockReopen(sig, null, baseSigma, baseK)).toBe(false);
  });

  it('allows when direction differs from prev close (legitimate flip)', () => {
    const sig: IncomingSignal = { direction: 'long', strength: 0.5, confidence: 0.7 };
    const prev: PrevCloseSignal = { direction: 'short', strength: 0.5, confidence: 0.8 };
    expect(shouldBlockReopen(sig, prev, baseSigma, baseK)).toBe(false);
  });

  it('blocks when same direction and conviction equal to prev', () => {
    const sig: IncomingSignal = { direction: 'short', strength: 0.5, confidence: 0.8 };  // s×c = 0.40
    const prev: PrevCloseSignal = { direction: 'short', strength: 0.5, confidence: 0.8 }; // s×c = 0.40
    expect(shouldBlockReopen(sig, prev, baseSigma, baseK)).toBe(true);
  });

  it('blocks when same direction but conviction weaker', () => {
    const sig: IncomingSignal = { direction: 'short', strength: 0.4, confidence: 0.6 };  // s×c = 0.24
    const prev: PrevCloseSignal = { direction: 'short', strength: 0.5, confidence: 0.8 }; // s×c = 0.40
    expect(shouldBlockReopen(sig, prev, baseSigma, baseK)).toBe(true);
  });

  it('blocks when same direction stronger but not by 1σ', () => {
    const sig: IncomingSignal = { direction: 'short', strength: 0.6, confidence: 0.9 };  // s×c = 0.54
    const prev: PrevCloseSignal = { direction: 'short', strength: 0.5, confidence: 0.8 }; // s×c = 0.40
    // delta = 0.14, threshold = 0.40 + 0.353 = 0.753 → 0.54 < 0.753 → block
    expect(shouldBlockReopen(sig, prev, baseSigma, baseK)).toBe(true);
  });

  it('allows when same direction stronger by ≥ 1σ', () => {
    const sig: IncomingSignal = { direction: 'short', strength: 0.95, confidence: 0.9 }; // s×c = 0.855
    const prev: PrevCloseSignal = { direction: 'short', strength: 0.5, confidence: 0.8 }; // s×c = 0.40
    // 0.855 ≥ 0.40 + 0.353 = 0.753 → allow
    expect(shouldBlockReopen(sig, prev, baseSigma, baseK)).toBe(false);
  });

  it('uses absolute values (signed strength does not affect logic)', () => {
    const sig: IncomingSignal = { direction: 'short', strength: -0.5, confidence: 0.8 }; // |s|×c = 0.40
    const prev: PrevCloseSignal = { direction: 'short', strength: -0.5, confidence: 0.8 };
    expect(shouldBlockReopen(sig, prev, baseSigma, baseK)).toBe(true);
  });

  it('honours custom k value', () => {
    const sig: IncomingSignal = { direction: 'short', strength: 0.6, confidence: 0.9 };  // s×c = 0.54
    const prev: PrevCloseSignal = { direction: 'short', strength: 0.5, confidence: 0.8 }; // s×c = 0.40
    // With k=0.5, threshold = 0.40 + 0.5*0.353 = 0.5765 → 0.54 < 0.5765 → still block
    expect(shouldBlockReopen(sig, prev, baseSigma, 0.5)).toBe(true);
    // With k=0.0, threshold = 0.40 → 0.54 > 0.40 → allow
    expect(shouldBlockReopen(sig, prev, baseSigma, 0.0)).toBe(false);
  });
});
