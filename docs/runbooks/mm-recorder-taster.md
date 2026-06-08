# mm-recorder — local taster

Prereq: a local Postgres (or SSH tunnel to the VM DB) with the project schema, so
`orderbook_snapshots` / `trades` / `markets` exist for the selector. The taster needs
the prod DB read access for the universe; capture writes the 3 new tables.

```bash
# 1. apply schema (creates mm_book_events / mm_trade_events / mm_capture_gaps)
DATABASE_URL=<db> pnpm --filter @polymarket-trader/mm-recorder migrate

# 2. sanity-check the universe
MM_UNIVERSE_N=15 DATABASE_URL=<db> pnpm --filter @polymarket-trader/mm-recorder select-universe

# 3. run the recorder for a few hours, then Ctrl-C
MM_UNIVERSE_N=15 DATABASE_URL=<db> pnpm --filter @polymarket-trader/mm-recorder start
```

Validate after ~2-4h:
```sql
SELECT count(*) FROM mm_book_events;           -- > 0, growing
SELECT count(*) FROM mm_trade_events;          -- > 0
SELECT count(*) FROM mm_capture_gaps;          -- ideally 0-few
SELECT token_id, count(*) FROM mm_book_events GROUP BY 1 ORDER BY 2 DESC LIMIT 5;
```
Watch RAM: the node process should sit in low tens of MB. If it grows unbounded, the
sink isn't flushing — investigate before the VM campaign.
