import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  }),
}));

import { AnthropicProvider, type Headline, type Market } from './LLMProvider.js';
import Anthropic from '@anthropic-ai/sdk';

describe('AnthropicProvider', () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    mockCreate.mockReset();
    provider = new AnthropicProvider('test-key');
  });

  it('returns provider name', () => {
    expect(provider.getName()).toBe('anthropic');
  });

  it('is available when API key is set', () => {
    expect(provider.isAvailable()).toBe(true);
  });

  it('is not available when API key is empty', () => {
    const noKey = new AnthropicProvider('');
    expect(noKey.isAvailable()).toBe(false);
  });

  it('parses structured tool_use response', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{
        type: 'tool_use',
        name: 'evaluate_headlines',
        input: {
          matches: [
            { headline_id: 'h1', market_id: 'm1', direction: 'SHORT', impact: 0.8, reasoning: 'team eliminated' },
          ],
        },
      }],
      usage: { input_tokens: 500, output_tokens: 100 },
    });

    const headlines: Headline[] = [{ id: 'h1', title: 'PSG eliminated from Champions League' }];
    const markets: Market[] = [{ id: 'm1', question: 'Will PSG win Champions League?', currentPrice: 0.14 }];

    const result = await provider.evaluateHeadlines(headlines, markets);
    expect(result.evaluations).toHaveLength(1);
    expect(result.evaluations[0].direction).toBe('SHORT');
    expect(result.evaluations[0].impact).toBe(0.8);
    expect(result.usage.inputTokens).toBe(500);
  });

  it('returns empty evaluations when no tool_use in response', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'No relevant matches found.' }],
      usage: { input_tokens: 500, output_tokens: 50 },
    });

    const result = await provider.evaluateHeadlines(
      [{ id: 'h1', title: 'Weather is nice today' }],
      [{ id: 'm1', question: 'Will Bitcoin reach $100K?', currentPrice: 0.50 }],
    );
    expect(result.evaluations).toHaveLength(0);
  });

  it('renders headlines and markets with synthetic h<i>/m<i> ids in the prompt (not the raw caller ids)', async () => {
    // Regression test for the 2026-04-13 → 2026-05-04 outage: the previous
    // prompt embedded full URLs and UUIDs as headline/market identifiers and
    // the LLM consistently returned its own short tokens (A, B, 1, 2),
    // missing every map lookup downstream. Now the prompt itself uses short
    // synthetic ids so there is nothing for the LLM to "shorten".
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'tool_use', name: 'evaluate_headlines', input: { matches: [] } }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const headlines: Headline[] = [
      { id: 'https://very-long-url.example.com/article/12345', title: 'Title A' },
      { id: 'https://another.example.com/x/y/z', title: 'Title B' },
    ];
    const markets: Market[] = [
      { id: '0x9f8f7d6c5b4a3928172616502f4e3d2c1b0a', question: 'Q1?', currentPrice: 0.42 },
    ];

    await provider.evaluateHeadlines(headlines, markets);

    const sentMessages = mockCreate.mock.calls[0][0].messages;
    const promptText = sentMessages[0].content as string;
    expect(promptText).toContain('[h1] "Title A"');
    expect(promptText).toContain('[h2] "Title B"');
    expect(promptText).toContain('[m1] "Q1?" (price: 0.42)');
    // The raw URL/UUID identifiers must NOT leak into the prompt — that was the source of the LLM confusion.
    expect(promptText).not.toContain('https://very-long-url');
    expect(promptText).not.toContain('0x9f8f7d6c5b4a');
  });

  it('translates synthetic ids returned by the LLM back to the original caller-supplied ids', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{
        type: 'tool_use',
        name: 'evaluate_headlines',
        input: {
          matches: [
            { headline_id: 'h2', market_id: 'm1', direction: 'LONG', impact: 0.7 },
          ],
        },
      }],
      usage: { input_tokens: 100, output_tokens: 30 },
    });

    const headlines: Headline[] = [
      { id: 'https://news.example.com/a', title: 'A' },
      { id: 'https://news.example.com/b', title: 'B' },
    ];
    const markets: Market[] = [
      { id: '0xMARKET-UUID-1234', question: 'Q?', currentPrice: 0.5 },
    ];

    const result = await provider.evaluateHeadlines(headlines, markets);

    expect(result.evaluations).toHaveLength(1);
    expect(result.evaluations[0].headlineId).toBe('https://news.example.com/b');
    expect(result.evaluations[0].marketId).toBe('0xMARKET-UUID-1234');
    expect(result.evaluations[0].direction).toBe('LONG');
  });

  it('passes through unresolved synthetic ids so the caller can drop them', async () => {
    // If the LLM hallucinates an id that isn't in the prompt (e.g. "h99"
    // when only h1 and h2 exist), the provider returns it verbatim. The
    // caller's headlineMap.get(...) lookup will miss and the stray match
    // is silently dropped — preserves the existing safety net.
    mockCreate.mockResolvedValueOnce({
      content: [{
        type: 'tool_use',
        name: 'evaluate_headlines',
        input: {
          matches: [
            { headline_id: 'h99', market_id: 'mZ', direction: 'SHORT', impact: 0.3 },
          ],
        },
      }],
      usage: { input_tokens: 50, output_tokens: 10 },
    });

    const result = await provider.evaluateHeadlines(
      [{ id: 'real-h1', title: 'A' }],
      [{ id: 'real-m1', question: 'Q?', currentPrice: 0.5 }],
    );

    expect(result.evaluations).toHaveLength(1);
    expect(result.evaluations[0].headlineId).toBe('h99');  // unresolved → passthrough
    expect(result.evaluations[0].marketId).toBe('mZ');
  });
});
