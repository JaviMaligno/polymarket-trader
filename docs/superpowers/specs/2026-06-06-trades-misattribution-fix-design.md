# Trades Misattribution Fix (design)

**Date:** 2026-06-06
**Status:** approved (brainstorm), pending implementation plan

## Problem

The raw `trades` hypertable is fully misattributed. `ClobCollector.fetchTrades(tokenId)`
(`packages/data-collector/src/collectors/ClobCollector.ts`) queries
`data-api.polymarket.com/trades?asset_id=<tokenId>`, but **the data-api ignores
`asset_id` and returns a GLOBAL feed of recent trades across all markets**.
`syncTradesToDb` then stores every returned trade tagged with the queried
`token_id` and `market_id`. So for any token/market, the `trades` rows are random
trades from *other* markets — price/size/side do not correspond to that token.

Confirmed empirically (2026-06-06):
- For a token with a tight book (bid 0.961 / ask 0.967), its stored "trades" print
  at 0.05, 0.18, 0.56, 0.79, 0.89 — impossible against that book.
- Raw data-api response: every returned trade's `asset` field ≠ the queried
  `asset_id` (0/15 match); outcomes are "Up"/"Down"/"No" from unrelated markets.
- Parameter probe: `asset_id`, `asset`, `takerAssetId` are all ignored (global
  feed). **Only `market=<conditionId>` filters correctly** (asset_match 10/10).

Secondary defect: `trades` PK is `(time, id)` with `id SERIAL`, and the insert uses
`ON CONFLICT DO NOTHING` — which **never fires** (a fresh `id` each time), so the
table also accumulates duplicates of the global feed every poll.

## Blast radius (audited)

Two **live-trading** signals consume the raw `trades` table via
`SignalEngine.computeSignals` (`packages/dashboard/src/services/SignalEngine.ts`,
`SELECT ... FROM trades WHERE market_id = $1 AND time > NOW() - INTERVAL '30 minutes' LIMIT 200`
→ `context.recentTrades`):

- **OrderFlowImbalanceSignal** — buy/sell volume imbalance. Currently blends a
  garbage trade-OFI with the (clean) book-OFI → corrupted strength/direction.
- **HawkesSignal** — trade-arrival clustering. Currently models bursts from other
  markets → spurious intensity/side.

Both feed `AutoSignalExecutor` (live). **Not affected:** `MultiLevelOFISignal`
(order book), `VolumeAnomalyGenerator` (OHLCV bars), all other generators
(`recentTrades: []`), backtest, optimizer, `MarketScorer`, `CircuitBreakerService`,
and the `paper_trades` / `shadow_trades` tables (separate). This likely explains the
historical anti-edge of OFI/Hawkes in the P2 analysis.

## Goal

Make `trades` reflect real per-token executions, so the two live microstructure
signals compute on truthful order flow (and so the parked H-MM-1 realized-spread
measurement becomes computable). One focused PR + a one-time VM ops step.

## Design

### 1. Collection fix (`ClobCollector`)

- **Query by market, not asset.** `fetchTrades(conditionId)` calls the data-api with
  `params: { market: conditionId, limit: 100 }` (drop `asset_id`). The response is
  the market's real trades (both YES and NO outcomes).
- **Store under the real asset.** In `syncTradesToDb`, for each returned trade set
  `token_id = trade.asset` (the CLOB asset/token the trade actually belongs to),
  `market_id =` the market being synced, and `side`/`price`/`size` from the trade.
  Map `side` exactly as today (`BUY`→`buy`, else `sell`).
- **Defensive guard.** Accept a trade only if `trade.asset ∈ {clob_token_id_yes,
  clob_token_id_no}` for that market; skip otherwise (guards against API surprises).
- **Caller wiring.** `syncAllTrades` selects `condition_id` alongside
  `id, clob_token_id_yes, clob_token_id_no` and passes `condition_id` to
  `syncTradesToDb`; the per-market call replaces the current per-token (yes/no) calls
  (one `market=` query returns both sides). Keep the `lastSyncTimeCache` newer-than
  filter, keyed per market.

### 2. Dedup (make `ON CONFLICT` real)

Add a unique index that includes the hypertable partition column `time`:
`UNIQUE (time, tx_hash, token_id, side, price, size)`, and change the insert to
`ON CONFLICT (time, tx_hash, token_id, side, price, size) DO NOTHING`. This stops the
re-insertion of overlapping recent trades each poll. (`tx_hash` from the data-api
`transactionHash`; trades with a null `tx_hash` are not deduped — acceptable.) The
index goes in `001_schema.sql` for fresh installs; on the existing VM volume it is
applied manually (init SQL only runs on first volume init).

### 3. Purge contaminated history (VM ops, one-time)

Every existing `trades` row is contaminated, so after the fixed collector deploys,
run once on the VM: `TRUNCATE trades;` (`paper_trades` / `shadow_trades` untouched).
The collector repopulates correct, per-token trades within minutes. **Order matters:
deploy fix → `TRUNCATE trades` → create the unique index.** The index must be created
on the empty table — building it on the contaminated table would fail, since the
existing duplicates violate the uniqueness constraint.

### 4. No signal gate (justified by code)

No weight/enable changes are needed:
- **OFI** — `calculateTradeOFI` returns `null` when `trades.length < minTrades`, and
  `compute` then falls back to **book-only OFI** (clean) or `null`. Empty/sparse
  trades never produce a spurious trade-OFI.
- **Hawkes** — skips ingestion when `recentTrades` is empty and returns `null` when
  `events < minTrades`. Its in-memory event state is cleared by the **process
  restart on deploy**, so it starts fresh on clean data.

The corruption only occurs when contaminated rows are *present*; deploy + truncate
removes them, and both signals degrade to neutral/book-only meanwhile.

### 5. Verification (post-deploy)

- Re-run the reconciliation check: sampled trade prices for a token must cluster near
  that token's book (`best_bid`/`best_ask`), not span 0–1. This confirms the fix.
- **Follow-up (separate session, not this PR):** once several days of clean trades
  accumulate, re-measure OFI/Hawkes edge with `scripts/p2-tstat.js` to see whether
  they regain edge now that they no longer consume noise. Record in memory.

## Testing

Unit tests for `ClobCollector` (`ClobCollector.test.ts`, create if absent) with
`axios` and the `query` layer mocked:

1. `fetchTrades` issues the request with `market=<conditionId>` and no `asset_id`.
2. Given a mocked data-api response of trades for a market's two assets, each row is
   inserted with `token_id = trade.asset`, the correct `market_id`, and mapped
   `side`/`price`/`size`.
3. A trade whose `asset` is neither of the market's two tokens is skipped.
4. The INSERT statement targets `ON CONFLICT (time, tx_hash, token_id, side, price, size) DO NOTHING`.

DB-level dedup is validated by the unique index plus the manual VM reconciliation
check (CI also has a Postgres service if an integration test is wanted later).

## File inventory

- **Modify:** `packages/data-collector/src/collectors/ClobCollector.ts`
  (`fetchTrades`, `syncTradesToDb`, `syncAllTrades`).
- **Modify:** `packages/data-collector/src/database/init/001_schema.sql` (add the
  unique index for fresh installs).
- **Create:** `packages/data-collector/src/collectors/ClobCollector.test.ts` (if absent).
- **VM ops (post-deploy):** `TRUNCATE trades`, then `CREATE UNIQUE INDEX` on the empty table.
- **Memory:** record root cause, fix, and the OFI/Hawkes edge re-measurement follow-up.

## Scope (anti-scope-creep)

In scope: the collection fix, the dedup index, the purge ops step, the unit tests,
the verification check. **Out of scope:** re-measuring OFI/Hawkes edge (follow-up);
H-MM-1 (resumes after this lands); any change to the signals themselves; backfilling
historical trades beyond what the live collector repopulates.

## Success criteria

After deploy + index + truncate, sampled `trades` for a token reconcile with that
token's order book, duplicates stop accumulating, and OFI/Hawkes compute on truthful
per-market order flow. A clean reconciliation check is the acceptance gate.
