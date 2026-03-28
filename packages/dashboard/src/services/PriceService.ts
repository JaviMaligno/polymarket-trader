import { query } from '../database/index.js';

/**
 * Single source of truth for token price lookup.
 *
 * price_history only stores Yes token prices. For SHORT positions (No token),
 * the price is computed as 1 - yesPrice. This function centralizes that logic
 * so callers never need to implement the inversion themselves.
 */
export async function getTokenPrice(
  marketId: string,
  side: 'long' | 'short'
): Promise<number | null> {
  const result = await query<{ close: string }>(
    `SELECT ph.close
     FROM markets m
     JOIN LATERAL (
       SELECT close FROM price_history
       WHERE token_id = m.clob_token_id_yes
       ORDER BY time DESC LIMIT 1
     ) ph ON true
     WHERE m.id = $1
     LIMIT 1`,
    [marketId]
  );

  if (!result.rows[0]) return null;

  const yesPrice = parseFloat(result.rows[0].close);
  if (isNaN(yesPrice)) return null;

  return side === 'short' ? 1 - yesPrice : yesPrice;
}
