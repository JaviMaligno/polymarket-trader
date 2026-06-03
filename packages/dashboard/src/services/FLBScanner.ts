import { query } from '../database/index.js';
import type { FLBConfig } from './FLBConfig.js';
import type { FLBCandidate } from './flbGates.js';

interface MarketRow {
  id: string;
  market_type: string;
  current_price_yes: string;
  spread: string | null;
  clob_token_id_no: string | null;
  end_date: string;
  ttr_hours: string;
}

export class FLBScanner {
  async scan(cfg: FLBConfig): Promise<FLBCandidate[]> {
    const res = await query<MarketRow>(
      `SELECT id, market_type, current_price_yes, spread, clob_token_id_no, end_date,
              EXTRACT(EPOCH FROM (end_date - NOW())) / 3600 AS ttr_hours
         FROM markets
        WHERE is_active = true
          AND COALESCE(is_resolved, false) = false
          AND current_price_yes BETWEEN $1 AND $2
          AND end_date > NOW() + ($3 || ' hours')::interval
          AND market_type = ANY($4)`,
      [cfg.longshotLo, cfg.longshotHi, cfg.minTtrHours, cfg.eligibleTypes]);

    return res.rows.map(r => ({
      marketId: r.id,
      marketType: r.market_type,
      yesPrice: parseFloat(r.current_price_yes),
      spread: r.spread == null ? null : parseFloat(r.spread),
      ttrHours: parseFloat(r.ttr_hours),
      noTokenId: r.clob_token_id_no,
      endDate: r.end_date,
    }));
  }
}
