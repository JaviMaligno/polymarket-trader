import { describe, it, expect, beforeEach } from 'vitest';

import { GoogleTrendsSource } from './GoogleTrendsSource.js';

describe('GoogleTrendsSource', () => {
  let source: GoogleTrendsSource;

  beforeEach(() => {
    source = new GoogleTrendsSource();
  });

  it('extractKeywords removes stop words and returns top 3 by length', () => {
    const keywords = source.extractKeywords('Will the Federal Reserve raise interest rates before 2027?');
    expect(keywords.length).toBeLessThanOrEqual(3);
    // Stop words like 'will', 'the', 'before' should be removed
    expect(keywords).not.toContain('will');
    expect(keywords).not.toContain('the');
    expect(keywords).not.toContain('before');
    // Meaningful words should be present
    expect(keywords).toContain('Federal');
    expect(keywords).toContain('Reserve');
    expect(keywords).toContain('interest');
  });

  it('extractKeywords handles empty string', () => {
    const keywords = source.extractKeywords('');
    expect(keywords).toEqual([]);
  });

  it('fetchInterest returns empty array when daily limit reached', async () => {
    // Exhaust the daily limit by calling fetchInterest many times
    // dailyLimit = 60, so we need to make 60 requests worth of keywords
    for (let i = 0; i < 60; i++) {
      await source.fetchInterest([`keyword${i}`]);
    }
    const results = await source.fetchInterest(['overflow']);
    expect(results).toEqual([]);
  });

  it('getRemainingRequests decrements after fetch calls', async () => {
    const before = source.getRemainingRequests();
    await source.fetchInterest(['bitcoin', 'ethereum']);
    const after = source.getRemainingRequests();
    expect(after).toBe(before - 2);
  });
});
