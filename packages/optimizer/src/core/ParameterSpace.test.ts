import { describe, expect, it } from 'vitest';

import {
  FULL_PARAMETER_SPACE,
  MINIMAL_PARAMETER_SPACE,
  PER_TYPE_PARAMETER_SPACE,
  createParameterSpace,
} from './ParameterSpace.js';

describe('ParameterSpace', () => {
  it('does not expose combiner.directionMultiplier in the full parameter space', () => {
    expect(FULL_PARAMETER_SPACE.map((param) => param.name)).not.toContain(
      'combiner.directionMultiplier',
    );
  });

  it('does not reintroduce combiner.directionMultiplier via the default factory', () => {
    expect(
      createParameterSpace().getParameters().map((param) => param.name),
    ).not.toContain('combiner.directionMultiplier');
  });

  it('keeps the minimal parameter space free of combiner.directionMultiplier', () => {
    expect(MINIMAL_PARAMETER_SPACE.map((param) => param.name)).not.toContain(
      'combiner.directionMultiplier',
    );
  });
});

describe('PER_TYPE_PARAMETER_SPACE — directionMultiplier', () => {
  it('exposes combiner.directionMultiplier as categorical with choices [-1, 1] only', () => {
    const dm = PER_TYPE_PARAMETER_SPACE.find(p => p.name === 'combiner.directionMultiplier');
    expect(dm).toBeDefined();
    expect(dm!.type).toBe('categorical');
    expect((dm as any).choices).toEqual([-1.0, 1.0]);
  });

  it('never exposes combiner.directionMultiplier as continuous (float/int)', () => {
    const dm = PER_TYPE_PARAMETER_SPACE.find(p => p.name === 'combiner.directionMultiplier');
    expect(dm?.type).not.toBe('float');
    expect(dm?.type).not.toBe('int');
  });
});
