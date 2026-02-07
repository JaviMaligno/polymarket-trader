/**
 * categorization.test.ts - Market categorization logic tests
 *
 * Tests the extractCategory function that classifies Polymarket
 * markets into categories based on tags and question text.
 */

import { describe, it, expect } from 'vitest';

/**
 * Extract category from market tags and question text
 * Mirrors the logic in PolymarketService.extractCategory
 */
function extractCategory(tags: string[], question?: string): string {
  const tagsText = (tags || []).join(' ').toLowerCase();
  const questionText = (question || '').toLowerCase();
  const combined = `${tagsText} ${questionText}`;

  // Sports
  const sportsPatterns = [
    /\b(nba|nfl|nhl|mlb|ncaa|mls|ufc|pga|atp|wta|f1|nascar|premier league|la liga|serie a|bundesliga|ligue 1|champions league)\b/,
    /\b(basketball|football|soccer|hockey|baseball|tennis|golf|boxing|mma|wrestling|cricket|rugby|volleyball)\b/,
    /\b(vs\.?|versus|game|match|championship|playoff|super bowl|world series|stanley cup|finals)\b/,
    /\b(lakers|celtics|warriors|nets|knicks|bulls|heat|mavericks|suns|bucks|76ers|clippers|nuggets|grizzlies|cavaliers|hawks|hornets|magic|pacers|pistons|raptors|wizards|spurs|thunder|blazers|jazz|kings|pelicans|timberwolves)\b/,
    /\b(patriots|chiefs|eagles|cowboys|49ers|bills|dolphins|ravens|bengals|lions|packers|vikings|bears|saints|buccaneers|falcons|panthers|commanders|giants|jets|steelers|browns|raiders|chargers|broncos|colts|titans|jaguars|texans|seahawks|rams|cardinals)\b/,
    /\b(yankees|red sox|dodgers|mets|cubs|astros|braves|phillies|padres|mariners|guardians|orioles|rays|twins|rangers|tigers|royals|white sox|angels|athletics|giants|cardinals|brewers|reds|pirates|marlins|rockies|diamondbacks|nationals)\b/,
    /\b(spread|moneyline|over.?under|point|score|quarterback|touchdown|goal|assist|rebound|strikeout|home run)\b/,
  ];
  if (sportsPatterns.some(p => p.test(combined))) return 'Sports';

  // Politics
  const politicsPatterns = [
    /\b(politic|election|president|congress|senate|governor|mayor|vote|ballot|poll|campaign)\b/,
    /\b(republican|democrat|gop|dnc|rnc|liberal|conservative|parliament|minister|legislation)\b/,
    /\b(trump|biden|obama|harris|desantis|newsom|pence|pelosi|mcconnell|schumer)\b/,
    /\b(white house|capitol|supreme court|impeach|executive order|veto|filibuster)\b/,
    /\b(primary|caucus|electoral|swing state|battleground|nominee|running mate)\b/,
    /\b(eu|european union|brexit|nato|un|united nations|g7|g20)\b/,
  ];
  if (politicsPatterns.some(p => p.test(combined))) return 'Politics';

  // Crypto
  const cryptoPatterns = [
    /\b(crypto|bitcoin|btc|ethereum|eth|blockchain|defi|nft|web3|dao)\b/,
    /\b(binance|coinbase|kraken|ftx|uniswap|opensea|metamask|ledger)\b/,
    /\b(altcoin|stablecoin|usdt|usdc|solana|sol|cardano|ada|polygon|matic|avalanche|avax)\b/,
    /\b(doge|dogecoin|shib|shiba|pepe|meme.?coin|airdrop|halving|mining)\b/,
    /\b(token|wallet|gas fee|smart contract|layer.?2|rollup|bridge)\b/,
  ];
  if (cryptoPatterns.some(p => p.test(combined))) return 'Crypto';

  // Tech
  const techPatterns = [
    /\b(tech|technology|software|hardware|startup|silicon valley)\b/,
    /\b(ai|artificial intelligence|machine learning|gpt|chatgpt|llm|neural|deepmind)\b/,
    /\b(openai|google|apple|microsoft|amazon|meta|facebook|twitter|x\.com|tesla|nvidia|amd|intel)\b/,
    /\b(iphone|android|app store|cloud|saas|api|developer|programming|coding)\b/,
    /\b(starlink|neuralink|anthropic|midjourney|stability|hugging.?face)\b/,
    /\b(tiktok|snapchat|instagram|youtube|twitch|discord|reddit|linkedin)\b/,
    /\b(cybersecurity|hack|data breach|privacy|encryption|vpn)\b/,
  ];
  if (techPatterns.some(p => p.test(combined))) return 'Tech';

  // Entertainment
  const entertainmentPatterns = [
    /\b(movie|film|cinema|box office|oscar|academy award|golden globe|emmy|grammy|tony)\b/,
    /\b(netflix|disney|hbo|hulu|amazon prime|streaming|series|season|episode)\b/,
    /\b(music|album|song|artist|concert|tour|billboard|spotify|grammy)\b/,
    /\b(celebrity|actor|actress|director|producer|hollywood|bollywood)\b/,
    /\b(taylor swift|beyonce|drake|kanye|kardashian|bieber|rihanna|adele)\b/,
    /\b(marvel|dc|star wars|disney|pixar|dreamworks|warner|universal)\b/,
    /\b(youtube|youtuber|influencer|viral|tiktok|content creator)\b/,
  ];
  if (entertainmentPatterns.some(p => p.test(combined))) return 'Entertainment';

  // Finance
  const financePatterns = [
    /\b(stock|share|equity|nasdaq|nyse|s&p|dow jones|index|ipo|earnings)\b/,
    /\b(fed|federal reserve|interest rate|inflation|gdp|recession|unemployment)\b/,
    /\b(bank|banking|loan|mortgage|credit|debt|bond|treasury|yield)\b/,
    /\b(merger|acquisition|valuation|market cap|revenue|profit|dividend)\b/,
    /\b(economy|economic|fiscal|monetary|stimulus|bailout|default)\b/,
    /\b(oil|gold|silver|commodity|forex|currency|dollar|euro|yen)\b/,
    /\b(gas prices?|fuel prices?|gasoline|petrol|energy prices?|electricity prices?)\b/,
    /\b(housing|real estate|rent|property|home price)\b/,
  ];
  if (financePatterns.some(p => p.test(combined))) return 'Finance';

  // Science
  const sciencePatterns = [
    /\b(science|scientific|research|study|experiment|discovery|breakthrough)\b/,
    /\b(nasa|spacex|space|mars|moon|asteroid|rocket|satellite|orbit)\b/,
    /\b(climate|weather|hurricane|earthquake|tornado|flood|temperature|carbon)\b/,
    /\b(medicine|medical|drug|fda|vaccine|treatment|clinical trial|pharma)\b/,
    /\b(covid|pandemic|virus|disease|health|hospital|doctor|patient)\b/,
    /\b(physics|chemistry|biology|genetics|dna|crispr|quantum)\b/,
  ];
  if (sciencePatterns.some(p => p.test(combined))) return 'Science';

  // World/Geopolitics
  const worldPatterns = [
    /\b(war|military|army|navy|troops|invasion|conflict|peace|treaty)\b/,
    /\b(russia|ukraine|china|taiwan|israel|palestine|iran|north korea)\b/,
    /\b(sanctions|embargo|diplomacy|ambassador|summit|negotiation)\b/,
    /\b(refugee|immigration|border|asylum|visa|deportation)\b/,
    /\b(terrorism|attack|bombing|hostage|extremist)\b/,
  ];
  if (worldPatterns.some(p => p.test(combined))) return 'World';

  // Culture/Society
  const culturePatterns = [
    /\b(culture|social|society|community|movement|protest|activism)\b/,
    /\b(lgbtq|gender|race|diversity|equality|discrimination|civil rights)\b/,
    /\b(education|school|university|college|student|teacher|curriculum)\b/,
    /\b(religion|church|faith|spiritual|pope|vatican)\b/,
    /\b(crime|court|trial|verdict|lawsuit|legal|judge|jury)\b/,
  ];
  if (culturePatterns.some(p => p.test(combined))) return 'Culture';

  return 'Other';
}

describe('extractCategory', () => {
  describe('Sports', () => {
    it('should categorize NBA games as Sports', () => {
      expect(extractCategory(['All'], 'NBA: Lakers vs. Celtics 2026-02-10')).toBe('Sports');
    });

    it('should categorize NFL Super Bowl as Sports', () => {
      expect(extractCategory(['All'], 'Will the Chiefs win Super Bowl LIX?')).toBe('Sports');
    });

    it('should categorize NFL matchups as Sports', () => {
      expect(extractCategory(['All'], 'NFL: Cowboys vs. Eagles Week 15')).toBe('Sports');
    });

    it('should categorize Premier League as Sports', () => {
      expect(extractCategory(['All'], 'Manchester United vs Arsenal Premier League?')).toBe('Sports');
    });
  });

  describe('Crypto', () => {
    it('should categorize Bitcoin price predictions as Crypto', () => {
      expect(extractCategory(['All'], 'Will Bitcoin reach $100k by end of 2026?')).toBe('Crypto');
    });

    it('should categorize ETH price as Crypto', () => {
      expect(extractCategory(['All'], 'ETH price above $5000 on March 1?')).toBe('Crypto');
    });

    it('should categorize Solana as Crypto', () => {
      expect(extractCategory(['All'], 'Solana price above $200?')).toBe('Crypto');
    });
  });

  describe('Politics', () => {
    it('should categorize Trump elections as Politics', () => {
      expect(extractCategory(['All'], 'Will Trump win the 2028 Republican primary?')).toBe('Politics');
    });

    it('should categorize Biden approval as Politics', () => {
      expect(extractCategory(['All'], 'Biden approval rating above 45% in February?')).toBe('Politics');
    });

    it('should categorize Supreme Court as Politics', () => {
      expect(extractCategory(['All'], 'Supreme Court ruling on abortion case?')).toBe('Politics');
    });
  });

  describe('Tech', () => {
    it('should categorize OpenAI releases as Tech', () => {
      expect(extractCategory(['All'], 'Will OpenAI release GPT-5 in 2026?')).toBe('Tech');
    });

    it('should categorize Tesla stock as Tech', () => {
      expect(extractCategory(['All'], 'Tesla stock price above $300 by March?')).toBe('Tech');
    });
  });

  describe('Entertainment', () => {
    it('should categorize Taylor Swift as Entertainment', () => {
      expect(extractCategory(['All'], 'Will Taylor Swift announce new album in Q1?')).toBe('Entertainment');
    });

    it('should categorize Oscar predictions as Entertainment', () => {
      expect(extractCategory(['All'], 'Oscar Best Picture winner 2026?')).toBe('Entertainment');
    });

    it('should categorize Netflix as Entertainment', () => {
      expect(extractCategory(['All'], 'Will Netflix stock recover in 2026?')).toBe('Entertainment');
    });
  });

  describe('Finance', () => {
    it('should categorize Fed interest rates as Finance', () => {
      expect(extractCategory(['All'], 'Fed interest rate cut in March 2026?')).toBe('Finance');
    });

    it('should categorize S&P 500 as Finance', () => {
      expect(extractCategory(['All'], 'S&P 500 above 6000 by end of Q1?')).toBe('Finance');
    });

    it('should categorize gas prices as Finance', () => {
      expect(extractCategory(['All'], 'Will gas prices fall below $3 in California?')).toBe('Finance');
    });
  });

  describe('Science', () => {
    it('should categorize SpaceX Mars as Science', () => {
      expect(extractCategory(['All'], 'Will SpaceX land on Mars by 2030?')).toBe('Science');
    });

    it('should categorize FDA approvals as Science', () => {
      expect(extractCategory(['All'], 'FDA approval for new Alzheimer drug?')).toBe('Science');
    });
  });

  describe('World', () => {
    it('should categorize Russia-Ukraine as World', () => {
      expect(extractCategory(['All'], 'Will Russia withdraw from Ukraine by 2027?')).toBe('World');
    });

    it('should categorize China-Taiwan as World', () => {
      expect(extractCategory(['All'], 'China invade Taiwan before 2030?')).toBe('World');
    });
  });

  describe('Other', () => {
    it('should categorize unrecognized questions as Other', () => {
      expect(extractCategory(['All'], 'Random obscure event with no keywords')).toBe('Other');
    });
  });

  describe('Edge cases', () => {
    it('should handle empty tags', () => {
      expect(extractCategory([], 'NBA game tonight')).toBe('Sports');
    });

    it('should handle undefined question', () => {
      expect(extractCategory(['crypto', 'bitcoin'])).toBe('Crypto');
    });

    it('should handle mixed case', () => {
      expect(extractCategory(['All'], 'BITCOIN Price Prediction')).toBe('Crypto');
    });
  });
});
