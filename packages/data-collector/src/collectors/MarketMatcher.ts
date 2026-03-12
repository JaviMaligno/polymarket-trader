import Anthropic from '@anthropic-ai/sdk';

interface MatchResult {
  match: boolean;
  confidence: number;
}

export class MarketMatcher {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async matchQuestions(polymarketQuestion: string, externalQuestion: string): Promise<MatchResult> {
    try {
      const response = await this.client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: `Are these two prediction market questions about the same outcome? Reply with JSON only: {"match": true/false, "confidence": 0.0-1.0}\n\nQuestion A: "${polymarketQuestion}"\nQuestion B: "${externalQuestion}"`,
          },
        ],
      });

      const text = response.content[0].type === 'text' ? response.content[0].text : '';
      return JSON.parse(text) as MatchResult;
    } catch {
      return { match: false, confidence: 0 };
    }
  }

  async matchBatch(
    polymarketMarkets: Array<{ id: string; question: string }>,
    externalMarkets: Array<{ id: string; question: string; platform: string }>
  ): Promise<Array<{ polymarketId: string; externalId: string; platform: string; confidence: number }>> {
    const matches: Array<{ polymarketId: string; externalId: string; platform: string; confidence: number }> = [];

    for (const pmMarket of polymarketMarkets) {
      // Group external markets by platform so we find one match per PM market per platform
      const platformsSeen = new Set<string>();

      for (const extMarket of externalMarkets) {
        if (platformsSeen.has(extMarket.platform)) {
          continue;
        }

        const result = await this.matchQuestions(pmMarket.question, extMarket.question);

        if (result.match && result.confidence >= 0.7) {
          matches.push({
            polymarketId: pmMarket.id,
            externalId: extMarket.id,
            platform: extMarket.platform,
            confidence: result.confidence,
          });
          platformsSeen.add(extMarket.platform);
        }
      }
    }

    return matches;
  }
}
