import { describe, expect, it } from 'vitest';
import {
  buildDirectionMultiplierMap,
  buildDirectionContextKey,
  clampDirectionMultiplier,
  resolveDirectionMultiplier,
  sanitizeDirectionMultiplierPolicy,
} from './DirectionMultiplierPolicy.js';

describe('DirectionMultiplierPolicy', () => {
  it('clamps multipliers into the allowed range', () => {
    expect(clampDirectionMultiplier(1.2, { minMultiplier: -1.5, maxMultiplier: 0.25 })).toBe(0.25);
    expect(clampDirectionMultiplier(-2.5, { minMultiplier: -1.5, maxMultiplier: 0.25 })).toBe(-1.5);
  });

  it('sanitizes policy and preserves valid segments', () => {
    const policy = sanitizeDirectionMultiplierPolicy({
      global: -2,
      minMultiplier: -1.25,
      maxMultiplier: 0.1,
      segments: [
        { id: 'financial-mid', multiplier: 0.2, marketTypes: ['event_financial'] },
        { id: '', multiplier: -0.5 },
      ],
    });

    expect(policy.global).toBe(-1.25);
    expect(policy.segments).toHaveLength(1);
    expect(policy.segments[0].multiplier).toBe(0.1);
  });

  it('prefers the most specific matching segment', () => {
    const policy = sanitizeDirectionMultiplierPolicy({
      global: -1,
      segments: [
        { id: 'financial', multiplier: -0.9, marketTypes: ['event_financial'] },
        {
          id: 'financial-mid',
          multiplier: -0.6,
          marketTypes: ['event_financial'],
          priceRange: { min: 0.4, max: 0.6 },
        },
      ],
    });

    const resolved = resolveDirectionMultiplier(policy, {
      marketType: 'event_financial',
      currentPrice: 0.5,
    });

    expect(resolved.multiplier).toBe(-0.6);
    expect(resolved.segmentId).toBe('financial-mid');
    expect(resolved.contextKey).toContain('financial-mid');
  });

  it('falls back to the global multiplier when no segment matches', () => {
    const policy = sanitizeDirectionMultiplierPolicy({
      global: -1,
      segments: [{ id: 'financial', multiplier: -0.8, marketTypes: ['event_financial'] }],
    });

    const resolved = resolveDirectionMultiplier(policy, {
      marketType: 'event_long',
      currentPrice: 0.75,
    });

    expect(resolved.multiplier).toBe(-1);
    expect(resolved.segmentId).toBeNull();
    expect(resolved.contextKey).toBe(buildDirectionContextKey({ marketType: 'event_long', currentPrice: 0.75 }));
  });

  it('builds direction override keys for overlapping price buckets', () => {
    const policy = sanitizeDirectionMultiplierPolicy({
      global: -1,
      segments: [
        {
          id: 'financial-mid',
          multiplier: -0.75,
          marketTypes: ['event_financial'],
          priceRange: { min: 0.35, max: 0.65 },
          durationBands: ['medium'],
        },
      ],
    });

    const map = buildDirectionMultiplierMap(policy);
    expect(map['event_financial|20to40|medium|financial-mid']).toBe(-0.75);
    expect(map['event_financial|40to60|medium|financial-mid']).toBe(-0.75);
    expect(map['event_financial|60to80|medium|financial-mid']).toBe(-0.75);
  });
});

describe('sanitizeDirectionMultiplierPolicy — perMarketType', () => {
  const baseInput = {
    global: -1,
    minMultiplier: -1.25,
    maxMultiplier: 1,
    segments: [],
  };

  it('passes through valid perMarketType values', () => {
    const result = sanitizeDirectionMultiplierPolicy({
      ...baseInput,
      perMarketType: { event_financial: 1, crypto_intraday: -1 },
    });
    expect(result.perMarketType).toEqual({ event_financial: 1, crypto_intraday: -1 });
  });

  it('clamps perMarketType values to [minMultiplier, maxMultiplier]', () => {
    const result = sanitizeDirectionMultiplierPolicy({
      ...baseInput,
      perMarketType: { event_financial: 5, crypto_intraday: -10 },
    });
    expect(result.perMarketType?.event_financial).toBe(1);
    expect(result.perMarketType?.crypto_intraday).toBe(-1.25);
  });

  it('drops NaN and Infinity entries from perMarketType', () => {
    const result = sanitizeDirectionMultiplierPolicy({
      ...baseInput,
      perMarketType: { good: 1, nan: NaN, inf: Infinity, neginf: -Infinity },
    });
    expect(result.perMarketType).toEqual({ good: 1 });
  });

  it('returns perMarketType undefined when input has no perMarketType', () => {
    const result = sanitizeDirectionMultiplierPolicy({ ...baseInput });
    expect(result.perMarketType).toBeUndefined();
  });
});
