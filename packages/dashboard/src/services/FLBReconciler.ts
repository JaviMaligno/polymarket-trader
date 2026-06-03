import { query, transaction } from '../database/index.js';
import { settle } from './flbMath.js';

export interface ReconcileResult {
  settled: number;
  voided: number;
  alerts: number;
}

interface OpenJoinRow {
  id: number;
  market_id: string;
  no_size: string;
  no_stake: string;
  fee_paid: string;
  opened_at: string;
  end_date: string | null;
  is_resolved: boolean;
  outcome: string | null;
  resolved_at: string | null;
}

export class FLBReconciler {
  async run(): Promise<ReconcileResult> {
    const res = await query<OpenJoinRow>(`
      SELECT f.id, f.market_id, f.no_size, f.no_stake, f.fee_paid, f.opened_at, f.end_date,
             m.is_resolved, lower(m.resolution_outcome) AS outcome, m.resolved_at
        FROM flb_positions f
        JOIN markets m ON m.id = f.market_id
       WHERE f.status = 'open'`);

    let settled = 0, voided = 0, alerts = 0;
    const now = Date.now();

    for (const r of res.rows) {
      const noStake = Number(r.no_stake);
      const feePaid = Number(r.fee_paid);
      // release = the capital locked at entry (noStake + feePaid). netPnl already nets out feePaid, so the locked-release and realized-pnl deltas are independent (no double count).
      const release = noStake + feePaid;

      if (r.is_resolved && (r.outcome === 'yes' || r.outcome === 'no')) {
        const noSize = Number(r.no_size);
        const { grossPnl, netPnl } = settle(noStake, noSize, feePaid, r.outcome);
        const holdDays = r.resolved_at
          ? (new Date(r.resolved_at).getTime() - new Date(r.opened_at).getTime()) / 86_400_000
          : null;

        await transaction(async (client) => {
          await client.query(
            `UPDATE flb_positions
                SET status = $1, resolved_at = $2, resolution_outcome = $3,
                    gross_pnl = $4, net_pnl = $5, hold_days = $6
              WHERE id = $7`,
            ['resolved', r.resolved_at, r.outcome, grossPnl, netPnl, holdDays, r.id]);
          await client.query(
            `UPDATE paper_account
                SET flb_locked_capital = flb_locked_capital - $1,
                    flb_realized_pnl   = flb_realized_pnl + $2
              WHERE id = (SELECT id FROM paper_account ORDER BY id LIMIT 1)`,
            [release, netPnl]);
        });
        settled++;
        continue;
      }

      if (r.is_resolved) {
        await transaction(async (client) => {
          await client.query(
            `UPDATE flb_positions
                SET status = $1, resolved_at = $2, resolution_outcome = $3, gross_pnl = 0, net_pnl = 0
              WHERE id = $4`,
            ['voided', r.resolved_at, r.outcome, r.id]);
          await client.query(
            `UPDATE paper_account SET flb_locked_capital = flb_locked_capital - $1
              WHERE id = (SELECT id FROM paper_account ORDER BY id LIMIT 1)`,
            [release]);
        });
        voided++;
        continue;
      }

      if (r.end_date && now > new Date(r.end_date).getTime() + 24 * 3600 * 1000) {
        console.warn(`[FLB] OVERDUE unresolved position market=${r.market_id} end_date=${r.end_date}`);
        alerts++;
      }
    }

    return { settled, voided, alerts };
  }
}
