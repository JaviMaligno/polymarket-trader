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
});
