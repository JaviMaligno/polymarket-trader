import { describe, expect, it } from 'vitest';

import {
  FULL_PARAMETER_SPACE,
  MINIMAL_PARAMETER_SPACE,
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
