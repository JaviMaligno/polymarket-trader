import winkNLP from 'wink-nlp';
import model from 'wink-eng-lite-web-model';
import { pino } from 'pino';

const logger = pino({ name: 'entity-matcher' });

export interface MarketEntitySet {
  id: string;
  question: string;
  entities: string[];
  eventContext: string;
}

export interface HeadlineMatch {
  marketId: string;
  relevanceScore: number;
  isCompetitorMention: boolean;
  matchedEntities: string[];
}

export class EntityMatcher {
  private nlp: ReturnType<typeof winkNLP>;
  private markets: MarketEntitySet[] = [];

  constructor() {
    this.nlp = winkNLP(model);
  }

  extractEntities(text: string): string[] {
    const doc = this.nlp.readDoc(text);
    const entities: string[] = [];

    doc.entities().each((e: any) => {
      entities.push(e.out());
    });

    // Words that begin questions/sentences but are not entity names
    const skipWords = new Set(['Will', 'The', 'What', 'How', 'Who', 'Does', 'Is', 'Are', 'Can', 'Would', 'Should', 'By']);

    // All-caps acronyms (e.g. PSG, NBA, NFL)
    const acronyms = text.match(/\b[A-Z]{2,}\b/g) || [];
    for (const a of acronyms) {
      if (!entities.includes(a)) entities.push(a);
    }

    // Capitalized multi-word phrases (e.g. "Champions League", "Manchester City")
    // When phrase starts with a skip word, strip it and keep the meaningful remainder
    const phrases = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g) || [];
    for (const phrase of phrases) {
      const firstWord = phrase.split(' ')[0];
      if (skipWords.has(firstWord)) {
        const rest = phrase.slice(firstWord.length + 1);
        if (rest && rest.includes(' ') && !entities.includes(rest)) entities.push(rest);
        // single-word remainder will be caught below
      } else if (!entities.includes(phrase)) {
        entities.push(phrase);
      }
    }

    // Individual capitalized words (e.g. "Arsenal", "Bitcoin")
    const singleWords = text.match(/\b[A-Z][a-z]{2,}\b/g) || [];
    for (const w of singleWords) {
      if (!skipWords.has(w) && !entities.includes(w)) entities.push(w);
    }

    return [...new Set(entities)];
  }

  setMarkets(markets: Array<{ id: string; question: string }>): void {
    this.markets = markets.map(m => {
      const entities = this.extractEntities(m.question);
      const eventPatterns = /(?:Champions League|Premier League|World Cup|Stanley Cup|NBA|NFL|Eurovision|election|nomination|primary)/i;
      const eventMatch = m.question.match(eventPatterns);
      const eventContext = eventMatch ? eventMatch[0].toLowerCase() : '';

      return { id: m.id, question: m.question, entities, eventContext };
    });

    logger.info({ marketCount: this.markets.length }, 'Updated entity cache for markets');
  }

  matchHeadline(headline: string): HeadlineMatch[] {
    const headlineLower = headline.toLowerCase();
    const headlineEntities = this.extractEntities(headline);
    const headlineEntitySet = new Set(headlineEntities.map(e => e.toLowerCase()));
    const matches: HeadlineMatch[] = [];

    for (const market of this.markets) {
      const matchedEntities: string[] = [];
      for (const entity of market.entities) {
        if (headlineLower.includes(entity.toLowerCase()) || headlineEntitySet.has(entity.toLowerCase())) {
          matchedEntities.push(entity);
        }
      }

      if (matchedEntities.length === 0) continue;

      let isCompetitorMention = false;
      if (market.eventContext) {
        const competitors = this.markets.filter(
          other => other.id !== market.id && other.eventContext === market.eventContext
        );
        for (const comp of competitors) {
          const compSubject = comp.entities[0]?.toLowerCase();
          if (compSubject && headlineLower.includes(compSubject)) {
            isCompetitorMention = !headlineLower.includes(market.entities[0]?.toLowerCase() || '');
            break;
          }
        }
      }

      const relevanceScore = Math.min(1.0, matchedEntities.length / Math.max(1, market.entities.length));

      matches.push({
        marketId: market.id,
        relevanceScore: relevanceScore < 0.3 ? 0.3 : relevanceScore,
        isCompetitorMention,
        matchedEntities,
      });
    }

    return matches;
  }
}
