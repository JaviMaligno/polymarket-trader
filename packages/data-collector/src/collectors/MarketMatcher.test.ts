import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Anthropic SDK before importing the class under test
const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  // Must use `function` keyword so `new Anthropic(...)` works as a constructor
  function MockAnthropic(this: Record<string, unknown>, _opts: unknown) {
    this.messages = { create: mockCreate };
  }
  return { default: MockAnthropic };
});

import { MarketMatcher } from './MarketMatcher.js';

describe('MarketMatcher', () => {
  let matcher: MarketMatcher;

  beforeEach(() => {
    mockCreate.mockReset();
    matcher = new MarketMatcher('test-api-key');
  });

  // Test 1: matchQuestions returns { match: true, confidence: 0.9 } when mock returns that JSON
  it('matchQuestions returns the parsed JSON result from the API', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"match": true, "confidence": 0.9}' }],
    });

    const result = await matcher.matchQuestions(
      'Will Bitcoin exceed $100k by end of 2025?',
      'Will BTC surpass $100,000 before January 2026?'
    );

    expect(result).toEqual({ match: true, confidence: 0.9 });
  });

  // Test 2: matchQuestions returns { match: false, confidence: 0 } on API error
  it('matchQuestions returns { match: false, confidence: 0 } on API error', async () => {
    mockCreate.mockRejectedValueOnce(new Error('API failure'));

    const result = await matcher.matchQuestions('Question A', 'Question B');

    expect(result).toEqual({ match: false, confidence: 0 });
  });

  // Test 3: matchBatch returns a match when confidence >= 0.7
  it('matchBatch returns matches with confidence >= 0.7', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: '{"match": true, "confidence": 0.85}' }],
    });

    const polymarketMarkets = [{ id: 'pm-1', question: 'Will ETH flip BTC in 2025?' }];
    const externalMarkets = [
      { id: 'ext-1', question: 'Will Ethereum overtake Bitcoin by market cap in 2025?', platform: 'metaculus' },
    ];

    const matches = await matcher.matchBatch(polymarketMarkets, externalMarkets);

    expect(matches).toHaveLength(1);
    expect(matches[0]).toEqual({
      polymarketId: 'pm-1',
      externalId: 'ext-1',
      platform: 'metaculus',
      confidence: 0.85,
    });
  });

  // Test 4: matchBatch skips matches with confidence < 0.7
  it('matchBatch skips matches with confidence < 0.7', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: '{"match": true, "confidence": 0.5}' }],
    });

    const polymarketMarkets = [{ id: 'pm-2', question: 'Will the Fed cut rates in March 2025?' }];
    const externalMarkets = [
      { id: 'ext-2', question: 'Federal Reserve rate decision March 2025', platform: 'manifold' },
    ];

    const matches = await matcher.matchBatch(polymarketMarkets, externalMarkets);

    expect(matches).toHaveLength(0);
  });
});
