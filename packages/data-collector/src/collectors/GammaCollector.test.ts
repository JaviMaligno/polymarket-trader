import { describe, it, expect } from 'vitest';
import { parseResolutionOutcome } from './GammaCollector.js';

describe('parseResolutionOutcome', () => {
  it('YES outcome ["1","0"] → yes', () => {
    expect(parseResolutionOutcome('["1", "0"]')).toBe('yes');
  });
  it('NO outcome ["0","1"] → no', () => {
    expect(parseResolutionOutcome('["0", "1"]')).toBe('no');
  });
  it('near-1 yes price ≥0.99 → yes', () => {
    expect(parseResolutionOutcome('["0.995", "0.005"]')).toBe('yes');
  });
  it('near-0 yes price ≤0.01 → no', () => {
    expect(parseResolutionOutcome('["0.004", "0.996"]')).toBe('no');
  });
  it('50-50 / invalid → null', () => {
    expect(parseResolutionOutcome('["0.5", "0.5"]')).toBe(null);
  });
  it('empty array → null', () => {
    expect(parseResolutionOutcome('[]')).toBe(null);
  });
  it('malformed JSON → null', () => {
    expect(parseResolutionOutcome('not json')).toBe(null);
  });
  it('null/undefined → null', () => {
    expect(parseResolutionOutcome(null)).toBe(null);
    expect(parseResolutionOutcome(undefined)).toBe(null);
  });
});
