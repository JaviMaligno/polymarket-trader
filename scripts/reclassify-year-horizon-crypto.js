#!/usr/bin/env node
/**
 * reclassify-year-horizon-crypto — backfill for crypto_* markets that were
 * classified BEFORE the year-horizon fix (PR #211, e8fcd32) and never
 * re-classified (MarketClassifier only touches `market_type IS NULL`).
 *
 * daily-review #308 (2026-06-05): 11/12 tracked `crypto_daily` markets are
 * year-horizon binaries (end_date 2027-01-01, e.g. "Will December be the best
 * month for Bitcoin in 2026?"). crypto_daily is an ALLOWED live type, so the
 * executor spends REAL capital on what the design treats as shadow-only
 * event_long — the source of the #308 edge-gap alert (-$69.59) and a chunk of
 * the 31-loss streak.
 *
 * This re-runs the live classifier's regex path over every already-classified
 * crypto_* market and corrects the diffs. The regex path is a verbatim port of
 * MarketClassifier.classifyWithRegex; for crypto markets ending > 7 days out it
 * routes to event_long exactly as the live gate would.
 *
 * Dry-run by default. Pass --apply to persist.
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 DATABASE_URL=... node scripts/reclassify-year-horizon-crypto.js
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 DATABASE_URL=... node scripts/reclassify-year-horizon-crypto.js --apply
 */

// --- verbatim port of MarketClassifier regex helpers (keep in sync) ---

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

/** Verbatim port of MarketClassifier.classifyWithRegex (regex path). */
function classifyWithRegex(question, endDate) {
  const q = question.toLowerCase();
  const isCrypto = questionLooksCryptoPriceMarket(question);
  const isUpDown = /up or down|price.*above|reach.*\$|dip to|hit.*\$/i.test(q);

  if (isCrypto) {
    if (endDate) {
      const hoursUntilEnd = (endDate.getTime() - Date.now()) / (1000 * 60 * 60);
      if (hoursUntilEnd <= 4) return 'crypto_intraday';
      if (hoursUntilEnd <= 7 * 24) return 'crypto_daily';
      return 'event_long';
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

module.exports = { classifyWithRegex, questionLooksCryptoPriceMarket };

// --- CLI ---

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const { Pool } = require('pg');
  const apply = process.argv.includes('--apply');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // Already-classified crypto_* markets that are still LIVE (end_date in the
    // future). Resolved markets are excluded on purpose: they never trade again,
    // and rewriting their market_type would corrupt the historical attribution
    // in shadow_trades / category stats (which group by the current type). The
    // leak only exists for markets that can still be rotated into the live pool.
    const result = await pool.query(`
      SELECT id, question, end_date, market_type, tracking_status
      FROM markets
      WHERE market_type IN ('crypto_intraday', 'crypto_daily')
        AND end_date IS NOT NULL
        AND end_date > NOW()
      ORDER BY tracking_status, updated_at DESC NULLS LAST, id
    `);

    const updates = result.rows
      .map((row) => ({
        id: row.id,
        question: row.question,
        tracking: row.tracking_status,
        currentType: row.market_type,
        nextType: classifyWithRegex(row.question, row.end_date ? new Date(row.end_date) : null),
      }))
      .filter((row) => row.currentType !== row.nextType);

    console.log(`Scanned ${result.rows.length} crypto_* markets`);
    console.log(`Found ${updates.length} that would be reclassified:\n`);

    // Breakdown by transition so the leak is obvious at a glance.
    const byTransition = {};
    for (const u of updates) {
      const k = `${u.currentType} → ${u.nextType}`;
      byTransition[k] = (byTransition[k] || 0) + 1;
    }
    console.table(byTransition);

    const active = updates.filter((u) => u.tracking === 'active');
    console.log(`\n${active.length} of these are tracking_status='active' (live-tradeable now):`);
    console.table(
      active.slice(0, 50).map((row) => ({
        id: row.id,
        from: row.currentType,
        to: row.nextType,
        question: row.question.slice(0, 80),
      }))
    );

    if (!apply) {
      console.log('\nDry run only. Re-run with --apply to persist changes.');
      return;
    }

    let n = 0;
    for (const row of updates) {
      await pool.query(
        'UPDATE markets SET market_type = $1, updated_at = NOW() WHERE id = $2',
        [row.nextType, row.id]
      );
      n += 1;
    }
    console.log(`\nApplied ${n} market_type updates.`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
