import { describe, it, expect, beforeEach } from 'vitest';
import { getKSigma } from './concentrationGate.js';

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
