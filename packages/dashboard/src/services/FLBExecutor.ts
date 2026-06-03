import { query, transaction } from '../database/index.js';
import type { FLBConfig } from './FLBConfig.js';
import { evaluateSignal, isoWeekKey, type FLBCandidate, type FLBContext } from './flbGates.js';

export interface ExecuteResult {
  opened: number;
  rejected: number;
  dryRunIntents: number;
}

export class FLBExecutor {
  /** Runtime DDL for existing volumes (init SQL only runs on fresh volumes). */
  async ensureFLBSchema(): Promise<void> {
    await query(`
      CREATE TABLE IF NOT EXISTS flb_positions (
        id BIGSERIAL PRIMARY KEY,
        market_id TEXT NOT NULL UNIQUE,
        market_type TEXT NOT NULL,
        opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        entry_yes_price NUMERIC(10,6) NOT NULL,
        entry_no_price NUMERIC(10,6) NOT NULL,
        executed_no_price NUMERIC(10,6) NOT NULL,
        no_size NUMERIC(18,6) NOT NULL,
        no_stake NUMERIC(18,6) NOT NULL,
        fee_paid NUMERIC(18,6) NOT NULL DEFAULT 0,
        slippage_pct NUMERIC(10,4),
        fill_source TEXT,
        entry_cost_pct NUMERIC(10,4),
        ttr_hours_at_entry NUMERIC(10,2),
        end_date TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'open',
        resolved_at TIMESTAMPTZ,
        resolution_outcome TEXT,
        gross_pnl NUMERIC(18,6),
        net_pnl NUMERIC(18,6),
        hold_days NUMERIC(10,3)
      )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_flb_positions_status ON flb_positions (status)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_flb_positions_end_date ON flb_positions (end_date)`);
    await query(`ALTER TABLE paper_account ADD COLUMN IF NOT EXISTS flb_locked_capital NUMERIC(18,6) NOT NULL DEFAULT 0`);
    await query(`ALTER TABLE paper_account ADD COLUMN IF NOT EXISTS flb_realized_pnl NUMERIC(18,6) NOT NULL DEFAULT 0`);
  }

  private async loadContext(): Promise<FLBContext> {
    const acct = await query<{ initial_capital: string; flb_locked_capital: string }>(
      'SELECT initial_capital, flb_locked_capital FROM paper_account ORDER BY id LIMIT 1');
    const open = await query<{ market_id: string }>(
      "SELECT market_id FROM flb_positions WHERE status = 'open'");
    const weeks = await query<{ week_key: string; n: string }>(`
      SELECT to_char(end_date, 'IYYY"-W"IW') AS week_key, COUNT(*) AS n
      FROM flb_positions WHERE status = 'open' AND end_date IS NOT NULL
      GROUP BY 1`);

    const sameWeekOpenCounts = new Map<string, number>();
    for (const r of weeks.rows) sameWeekOpenCounts.set(r.week_key, Number(r.n));

    return {
      now: new Date(),
      initialCapital: Number(acct.rows[0]?.initial_capital ?? '10000'),
      lockedCapital: Number(acct.rows[0]?.flb_locked_capital ?? '0'),
      openMarketIds: new Set(open.rows.map(r => r.market_id)),
      sameWeekOpenCounts,
    };
  }

  /** Caller must invoke ensureFLBSchema() once before the first executeCandidates() (FLBService does this on start). */
  async executeCandidates(candidates: FLBCandidate[], cfg: FLBConfig): Promise<ExecuteResult> {
    const ctx = await this.loadContext();
    let opened = 0, rejected = 0, dryRunIntents = 0;

    for (const c of candidates) {
      const decision = evaluateSignal(c, ctx, cfg);
      if (!decision.accept) {
        rejected++;
        console.log(`[FLB] REJECTED market=${c.marketId} reason=${decision.reason}`);
        continue;
      }
      if (cfg.dryRun) {
        dryRunIntents++;
        console.log(`[FLB] DRY-RUN intent market=${c.marketId} stake=${decision.noStake?.toFixed(2)} cost=${decision.entryCostPct?.toFixed(3)}%`);
        continue;
      }

      const lockDelta = (decision.noStake ?? 0) + (decision.feePaid ?? 0);

      // Atomic: position row and locked-capital move together or not at all.
      const inserted = await transaction(async (client) => {
        const ins = await client.query(
          `INSERT INTO flb_positions
             (market_id, market_type, entry_yes_price, entry_no_price, executed_no_price,
              no_size, no_stake, fee_paid, slippage_pct, fill_source, entry_cost_pct,
              ttr_hours_at_entry, end_date, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'open')
           ON CONFLICT (market_id) DO NOTHING`,
          [c.marketId, c.marketType, c.yesPrice, 1 - c.yesPrice, decision.executedNoPrice,
           decision.noSize, decision.noStake, decision.feePaid, decision.slippagePct,
           decision.fillSource, decision.entryCostPct, c.ttrHours, c.endDate]);

        if ((ins.rowCount ?? 0) === 0) return false; // lost a race / duplicate

        await client.query(
          'UPDATE paper_account SET flb_locked_capital = flb_locked_capital + $1 WHERE id = (SELECT id FROM paper_account ORDER BY id LIMIT 1)',
          [lockDelta]);
        return true;
      });

      if (!inserted) { rejected++; continue; } // lost a race / duplicate; ctx left untouched

      // keep in-memory ctx consistent across the batch
      ctx.lockedCapital += lockDelta;
      ctx.openMarketIds.add(c.marketId);
      const wk = decision.isoWeekKey ?? isoWeekKey(new Date(c.endDate));
      ctx.sameWeekOpenCounts.set(wk, (ctx.sameWeekOpenCounts.get(wk) ?? 0) + 1);
      opened++;
      console.log(`[FLB] OPENED market=${c.marketId} type=${c.marketType} stake=${decision.noStake?.toFixed(2)} fill=${decision.fillSource}`);
    }

    return { opened, rejected, dryRunIntents };
  }
}
