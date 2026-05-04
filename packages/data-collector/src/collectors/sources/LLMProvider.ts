import Anthropic from '@anthropic-ai/sdk';
import { pino } from 'pino';

const logger = pino({ name: 'llm-provider' });

export interface Headline {
  id: string;
  title: string;
}

export interface Market {
  id: string;
  question: string;
  currentPrice: number;
}

export interface HeadlineEvaluation {
  headlineId: string;
  marketId: string;
  direction: 'LONG' | 'SHORT';
  impact: number;
  reasoning?: string;
}

export interface EvaluationResult {
  evaluations: HeadlineEvaluation[];
  usage: { inputTokens: number; outputTokens: number };
}

export interface LLMProvider {
  evaluateHeadlines(headlines: Headline[], markets: Market[]): Promise<EvaluationResult>;
  getName(): string;
  isAvailable(): boolean;
}

const TOOL_DEFINITION = {
  name: 'evaluate_headlines',
  description: 'Evaluate which news headlines are relevant to which prediction markets and their directional impact',
  input_schema: {
    type: 'object' as const,
    properties: {
      matches: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            headline_id: { type: 'string' as const },
            market_id: { type: 'string' as const },
            direction: { type: 'string' as const, enum: ['LONG', 'SHORT'] },
            impact: { type: 'number' as const, minimum: 0, maximum: 1 },
            reasoning: { type: 'string' as const },
          },
          required: ['headline_id', 'market_id', 'direction', 'impact'],
        },
      },
    },
    required: ['matches'],
  },
};

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  private apiKey: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
    this.client = new Anthropic({ apiKey: this.apiKey });
  }

  getName(): string {
    return 'anthropic';
  }

  isAvailable(): boolean {
    return this.apiKey.length > 0;
  }

  async evaluateHeadlines(headlines: Headline[], markets: Market[]): Promise<EvaluationResult> {
    // Use short synthetic IDs (h1, h2, ..., m1, m2, ...) in the prompt. The
    // previous version embedded full URLs and UUIDs as identifiers and the
    // LLM consistently returned the leading letter/number tokens (A, B, 1, 2)
    // instead, so headlineMap.get(...) in the caller missed every match and
    // signalCount was 0 for ~21 days starting 2026-04-13. We translate the
    // synthetic IDs back to the caller's real IDs before returning.
    const headlineIdMap = new Map<string, string>();
    const marketIdMap = new Map<string, string>();

    const headlineList = headlines.map((h, i) => {
      const synth = `h${i + 1}`;
      headlineIdMap.set(synth, h.id);
      return `[${synth}] "${h.title}"`;
    }).join('\n');

    const marketList = markets.map((m, i) => {
      const synth = `m${i + 1}`;
      marketIdMap.set(synth, m.id);
      return `[${synth}] "${m.question}" (price: ${m.currentPrice.toFixed(2)})`;
    }).join('\n');

    const prompt = `You are evaluating news headlines for their relevance to prediction markets.

MARKETS:
${marketList}

HEADLINES:
${headlineList}

For each headline-market pair where the headline provides ACTIONABLE information about the market outcome, call the evaluate_headlines tool. Only include genuinely relevant pairs. Direction: LONG if the headline makes the YES outcome more likely, SHORT if less likely. Impact: 0.0-1.0 scale of how much the headline should move the market price.

When you call the tool, set headline_id and market_id to the bracketed identifier shown above (e.g. "h1", "m2") — exactly that token, nothing else. If no headlines are relevant to any market, call the tool with an empty matches array.`;

    const response = await this.client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      tools: [TOOL_DEFINITION],
      tool_choice: { type: 'tool', name: 'evaluate_headlines' },
      messages: [{ role: 'user', content: prompt }],
    });

    const evaluations: HeadlineEvaluation[] = [];
    let unresolved = 0;
    for (const block of response.content) {
      if (block.type === 'tool_use' && block.name === 'evaluate_headlines') {
        const input = block.input as { matches: Array<{ headline_id: string; market_id: string; direction: string; impact: number; reasoning?: string }> };
        for (const match of input.matches || []) {
          // Translate synthetic IDs back to real IDs. If the LLM somehow
          // returns an ID that isn't in our map (hallucinated, misformatted),
          // pass it through verbatim — caller (NewsCollector) ignores rows
          // that don't match its own map, so a stray ID becomes a no-op.
          const realHeadlineId = headlineIdMap.get(match.headline_id) ?? match.headline_id;
          const realMarketId = marketIdMap.get(match.market_id) ?? match.market_id;
          if (!headlineIdMap.has(match.headline_id) || !marketIdMap.has(match.market_id)) {
            unresolved++;
          }
          evaluations.push({
            headlineId: realHeadlineId,
            marketId: realMarketId,
            direction: match.direction as 'LONG' | 'SHORT',
            impact: Math.max(0, Math.min(1, match.impact)),
            reasoning: match.reasoning,
          });
        }
      }
    }

    if (unresolved > 0) {
      logger.warn({ unresolved, totalEvaluations: evaluations.length }, 'LLM returned unresolved synthetic IDs');
    }
    logger.debug({ evaluationCount: evaluations.length }, 'Headlines evaluated');

    return {
      evaluations,
      usage: {
        inputTokens: response.usage?.input_tokens || 0,
        outputTokens: response.usage?.output_tokens || 0,
      },
    };
  }
}
