/**
 * PR-B 2026-05-13: SIGNAL_DIRECTIONS_DISABLED parser.
 */
import { describe, it, expect } from 'vitest';
import { parseDisabledSignalDirections } from './SignalEngine.js';

describe('parseDisabledSignalDirections', () => {
  it('returns empty Set when env unset/empty', () => {
    expect(parseDisabledSignalDirections(undefined).size).toBe(0);
    expect(parseDisabledSignalDirections('').size).toBe(0);
  });

  it('parses single valid token', () => {
    const out = parseDisabledSignalDirections('momentum:short');
    expect(out.has('momentum:short')).toBe(true);
    expect(out.size).toBe(1);
  });

  it('parses multiple tokens, trims whitespace, lowercases', () => {
    const out = parseDisabledSignalDirections(' MOMENTUM:Short , Ofi:LONG ,mean_reversion:short');
    expect(out.has('momentum:short')).toBe(true);
    expect(out.has('ofi:long')).toBe(true);
    expect(out.has('mean_reversion:short')).toBe(true);
    expect(out.size).toBe(3);
  });

  it('drops invalid tokens silently (typo-tolerant)', () => {
    const out = parseDisabledSignalDirections('momentum,ofi:both,bad:long:extra,:short,mean_reversion:short');
    // Only the well-formed `mean_reversion:short` survives.
    expect(out.has('mean_reversion:short')).toBe(true);
    expect(out.size).toBe(1);
  });

  it('does not accept upper-case direction (must be lowercase after normalize)', () => {
    // After lowercase: "momentum:long" → valid.
    const out = parseDisabledSignalDirections('Momentum:LONG');
    expect(out.has('momentum:long')).toBe(true);
  });

  it('does not allow non-long/short directions', () => {
    const out = parseDisabledSignalDirections('momentum:neutral,momentum:up,momentum:long');
    expect(out.has('momentum:long')).toBe(true);
    expect(out.has('momentum:neutral')).toBe(false);
    expect(out.has('momentum:up')).toBe(false);
    expect(out.size).toBe(1);
  });
});
