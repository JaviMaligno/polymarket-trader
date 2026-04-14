const { Pool } = require('pg');

function questionMentionsCrypto(question) {
  const fullWords = /\b(bitcoin|ethereum|solana|cardano|dogecoin|cryptocurrency|crypto|microstrategy|megaeth|satoshi|coinbase|binance|chainlink|polkadot|stellar|monero|polygon|ripple|fdv|stablecoin)\b/i;
  const tickers = /\b(btc|eth|xrp|ada|doge|bnb|sol|usdt|usdc)\b/i;
  return fullWords.test(question) || tickers.test(question);
}

function questionLooksCryptoPriceMarket(question) {
  if (!questionMentionsCrypto(question)) return false;

  const explicitEventPatterns = /\b(airdrop|launch(?:es|ed|ing)?|mainnet|testnet|listing|list(?:ed|ing)?|points|campaign|fdv|fully diluted|market cap|governance|proposal|vote|partnership|token generation|tge|unlock|vesting)\b/i;
  if (explicitEventPatterns.test(question)) return false;

  const pricePatterns = [
    /\bprice of\b/i,
    /\b(up or down|all time high|ath)\b/i,
    /\b(above|below|greater than|less than|over|under|between|exceed(?:s|ed)?|reach(?:es|ed)?|hit(?:s|ting)?)\b.*\$/i,
    /\$\s*\d/,
  ];

  return pricePatterns.some((pattern) => pattern.test(question));
}

function questionLooksFinancial(question) {
  const commodities = /\b(crude oil|wti|brent|natural gas|gold|silver|copper|platinum|palladium|gasoline)\b/i;
  const equitiesIndices = /\b(s&p ?500|sp500|nasdaq|dow jones|djia|russell|ftse|dax|nikkei|hang seng|vix|stock market|stocks)\b/i;
  const rates = /\b(fed|federal reserve|fomc|interest rate|rate cut|rate hike|rate decision|basis points|\d+ ?bps|inflation|cpi|ppi|pce|jobs report|nfp|unemployment rate|gdp|recession)\b/i;
  const forex = /\b(eur\/usd|usd\/jpy|gbp\/usd|usd\/cny|dxy|dollar index)\b/i;
  return commodities.test(question) || equitiesIndices.test(question) || rates.test(question) || forex.test(question);
}

function classifyWithRegex(question, endDate) {
  const isCrypto = questionLooksCryptoPriceMarket(question);
  const isUpDown = /up or down|price.*above|reach.*\$|dip to|hit.*\$/i.test(question);

  if (isCrypto) {
    if (endDate) {
      const hoursUntilEnd = (endDate.getTime() - Date.now()) / (1000 * 60 * 60);
      if (hoursUntilEnd <= 4 || isUpDown) return 'crypto_intraday';
      if (hoursUntilEnd <= 7 * 24) return 'crypto_daily';
    }
    return isUpDown ? 'crypto_intraday' : 'crypto_daily';
  }

  if (questionLooksFinancial(question)) {
    return 'event_financial';
  }

  if (endDate) {
    const daysUntilEnd = (endDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    if (daysUntilEnd >= 30) return 'event_long';
  }

  return 'event_short';
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const apply = process.argv.includes('--apply');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const result = await pool.query(`
      SELECT id, question, end_date, market_type
      FROM markets
      WHERE market_type IN ('crypto_intraday', 'crypto_daily')
      ORDER BY updated_at DESC NULLS LAST, id
    `);

    const updates = result.rows
      .map((row) => {
        const nextType = classifyWithRegex(row.question, row.end_date ? new Date(row.end_date) : null);
        return {
          id: row.id,
          question: row.question,
          currentType: row.market_type,
          nextType,
        };
      })
      .filter((row) => row.currentType !== row.nextType);

    console.log(`Scanned ${result.rows.length} crypto-classified markets`);
    console.log(`Found ${updates.length} markets that would be reclassified`);

    if (updates.length > 0) {
      console.table(
        updates.slice(0, 50).map((row) => ({
          id: row.id,
          from: row.currentType,
          to: row.nextType,
          question: row.question.slice(0, 90),
        }))
      );
    }

    if (!apply) {
      console.log('\nDry run only. Re-run with --apply to persist changes.');
      return;
    }

    for (const row of updates) {
      await pool.query(
        'UPDATE markets SET market_type = $1, updated_at = NOW() WHERE id = $2',
        [row.nextType, row.id]
      );
    }

    console.log(`Applied ${updates.length} market_type updates`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
