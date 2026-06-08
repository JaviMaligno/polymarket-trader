# B1 — Fine-cadence orderbook recorder (+ B2 maker fill-sim)

**Date:** 2026-06-07
**Status:** Design approved, pending implementation plan
**Context:** Lever B of the market-making track. H-MM-1 PASSED (event_financial +0.37%,
event_long +0.19%, n≥200, cost-aware) but it is a *passive-maker proxy at Δ≈10min with
no simulated fills*. B1 captures the fine-grained book/trade stream so B2 can measure the
maker's retained spread net of adverse selection *with realistic fills*, and decide whether
the +35bps/fill survives. See `project_next_levers_and_automation`,
`project_market_making_idea`, `project_trades_collection_corrupt_2026-06-06`.

## 1. Scope & success criteria

### Goal
Capture the fine, event-driven stream (top-of-book changes + trades) of a small set of
liquid `event_financial` markets, so that an **offline** maker fill simulator (B2) can
estimate the retained spread net of adverse selection under realistic fill assumptions.

### Success criterion (the decision B2 makes)
Maker net edge = `retained_spread − adverse_selection(fine horizon) − fees`, measured per
`(cohort × horizon × fill-rate q)`, **positive and bootstrap-significant over a plausible
region of q**. PASS → proceed to B3 (rewards) / B4 (quoting engine). FAIL → market-making
is closed at realistic fills, like the program's four prior NO-edge vías.

### Non-goals (YAGNI)
- Does **not** place real or paper orders. It only records and, offline, simulates.
- Not a production service. It does **not** touch the `data-collector`, the
  `Scheduler`, or the existing `orderbook_snapshots` table.
- No live quoting, inventory management, or rewards modelling (those are B3/B4).

### Deployment strategy (two phases, same binary)
1. **Local taster (1–2 days):** run on the developer machine to validate the end-to-end
   pipeline and produce a *preliminary* B2 reading. RAM unconstrained; a restart just ends
   the taster.
2. **VM campaign (1–2 weeks):** if the edge survives the taster, run the *same* recorder as
   a **separate, on-demand** process on the e2-micro (started for a capture campaign, stopped
   when done — never a permanent cron). Produces the robust verdict.

Rationale for ~1–2 weeks: ~10–20 liquid `event_financial` markets yield on the order of
30–100 simulated fills/day; a robust, regime-varied B2 (news days vs quiet days) needs n in
the hundreds across regimes.

## 2. Components

Four units, each with one purpose, a defined interface, and independently testable.

### 2.1 Universe selector
- **What:** SQL script, run **once per campaign**. Ranks `event_financial` markets by
  liquidity (tight spread + recent trade count) and emits the top N `asset_ids` (YES + NO
  tokens) to subscribe.
- **Interface:** input = DB connection + N; output = list of `{market_id, token_id}`.
- **Depends on:** `markets`, `orderbook_snapshots`, `trades` (read-only).

### 2.2 Websocket recorder
- **What:** standalone Node process (`packages/mm-recorder`). Connects to the Polymarket
  CLOB market channel, subscribes the selected `asset_ids`, keeps the connection alive, holds
  the current top-of-book in memory, and persists each relevant event in batches.
- **Endpoint:** `wss://ws-subscriptions-clob.polymarket.com/ws/market`
- **Subscribe:** `{ assets_ids: [...], type: "market", custom_feature_enabled: true }`
  (`custom_feature_enabled` adds `best_bid_ask`, `market_resolved` events).
- **Events consumed:** `book` (full snapshot on subscribe + when a trade moves the book),
  `price_change` (bid/ask updates), `best_bid_ask` (clean top-of-book), `last_trade_price`
  (trade prints). `tick_size_change`/`market_resolved` handled for correctness.
- **Keepalive:** send `PING` every ~10s; respond `PONG` to server pings.
- **Client:** use the `ws` library (already a data-collector dependency, 8.14.2) with
  manual subscription + PING/PONG + reconnection. NOTE: the official
  `@polymarket/real-time-data-client` covers the *activity* feed (data-api trades/comments),
  **not** the CLOB market channel `book`/`price_change` events we need — so we go direct
  against `/ws/market` with `ws`.
- **Interface:** input = asset_ids list + DB sink; output = rows in the tables below + gap
  records. No return value (long-running).
- **Depends on:** the websocket; the persistence sink.

### 2.3 Persistence (new tables, nothing existing touched)
```sql
mm_book_events (
  time        TIMESTAMPTZ NOT NULL,
  token_id    VARCHAR(128) NOT NULL,
  market_id   VARCHAR(128) NOT NULL,
  event_type  TEXT NOT NULL,          -- book | price_change | best_bid_ask
  best_bid    DECIMAL(10,6),
  best_ask    DECIMAL(10,6),
  mid         DECIMAL(10,6)
);                                     -- one row per top-of-book change

mm_trade_events (
  time        TIMESTAMPTZ NOT NULL,
  token_id    VARCHAR(128) NOT NULL,
  market_id   VARCHAR(128) NOT NULL,
  price       DECIMAL(10,6) NOT NULL,
  size        DECIMAL(20,6),
  side        TEXT                     -- taker side if provided by the feed, else NULL
);                                     -- one row per last_trade_price

mm_capture_gaps (
  token_id    VARCHAR(128),            -- NULL = whole-connection gap
  gap_start   TIMESTAMPTZ NOT NULL,
  gap_end     TIMESTAMPTZ NOT NULL,
  reason      TEXT
);                                     -- disconnections; B2 excludes these windows
```
- TimescaleDB hypertable (VM) on `time`; a plain Postgres/SQLite table locally.
- **Volume:** event-driven over ~10–20 markets → thousands–tens-of-thousands of rows/day =
  a few MB/day. Negligible against the 350MB TimescaleDB budget.
- **Retention:** short (e.g. 14 days), set per campaign.
- **Dedup:** natural key `(time, token_id, event_type)` for book events; trades may carry a
  feed sequence/trade id — use it when present, else accept near-dup tolerance (documented).

### 2.4 Maker fill simulator (B2)
- **What:** offline analysis script in the edge-research harness style (datasets → validator
  → verdict). Reads the three tables and emits a cost-aware scoreboard. **New** code — the
  existing `OrderBookExecutionSimulator` is a *taker* simulator (walks the book, slippage)
  and does not model passive fills.
- **Interface:** input = the captured tables + parameter grid; output = scoreboard rows.
- **Depends on:** `mm_book_events`, `mm_trade_events`, `mm_capture_gaps` (read-only).

## 3. B2 fill model (offline, iterable on the same capture)

This is the part that is iterated *without re-capturing* — the reason for Architecture A
(raw capture + offline sim).

- Reconstruct `top_of_book(t)` by replaying `mm_book_events` in order.
- **Base fill rule:** for each trade in `mm_trade_events`, if it crosses the side where the
  maker would be quoting (maker at `best_bid` and a sell prints into the bid → maker filled;
  symmetric on the ask), count a **maker fill** at the quoted price.
- **Iterated parameters:**
  - *Fill-rate / queue position* `q ∈ [0,1]`: queue depth ahead of us is not directly
    observable, so the edge is reported over a **grid of q** (fraction of crossing trades
    that actually fill us). The verdict reads off the q at which edge crosses zero.
  - *Adverse-selection horizon*: mid at `{10s, 1min, 5min}` after the fill;
    `retained = maker_sign · (maker_price − mid_after)` with the **same sign convention as
    H-MM-1** (`mm_trade_spreads.sql`): bid-hit (maker bought at best_bid) → `maker_sign = −1`
    so retained `= mid_after − best_bid`; ask-lift (maker sold at best_ask) → `maker_sign = +1`
    so retained `= best_ask − mid_after`. A profitable maker keeps a positive retained spread.
  - *fees = 0, rewards = 0* here (rewards is B3).
- **Output:** scoreboard (mean edge, bootstrap CI, n) per `(cohort × horizon × q)`. Verdict:
  is there a plausible q-region where edge stays positive and significant?

## 4. Robustness & errors

- **Reconnection:** exponential backoff + re-subscribe; on reconnect the `book` event
  re-synchronises the in-memory top-of-book.
- **Gaps:** every disconnection writes a `mm_capture_gaps` row; B2 excludes windows with a
  hole rather than inventing continuity.
- **RAM (VM):** in-memory top-of-book is a few KB × N markets; batched writes (buffer +
  flush every ~1–2s) avoid hammering the DB. Run as a separate container/process with its own
  `mem_limit` in compose; watch with `docker stats`. The local taster validates the footprint
  before promoting to the VM.
- **Market resolution / tick changes:** on `market_resolved`, stop recording that asset; on
  `tick_size_change`, keep going (informational).

## 5. Testing

- **Unit:** event parser against fixture JSON for `book` / `price_change` /
  `best_bid_ask` / `last_trade_price`; top-of-book update logic; the B2 maker simulator
  against a synthetic stream with known-outcome fills (asserts retained-spread and q-grid
  arithmetic).
- **Integration:** the 1–2 day local taster *is* the end-to-end smoke test (real connection →
  populated tables → B2 runs and emits a scoreboard).
- **Pattern:** reuse the edge-research test style (synthetic datasets → validator → expected
  verdict).

## 6. End-to-end flow

```
universe selector  →  websocket recorder (local taster 1–2d)  →  B2 preliminary read
   → if edge survives →  websocket recorder (VM campaign 1–2 wk)  →  B2 robust verdict
      → PASS → B3 (rewards) / B4 (quoting engine);  FAIL → market-making closed
```

## 7. Open questions (resolve during planning)

- Exact N and the liquidity ranking thresholds for the universe selector (start ~10–20).
- Local store choice for the taster: a throwaway local Postgres vs SQLite (schema is portable
  either way).
- Whether `last_trade_price` reliably carries the taker side; if not, infer side from the
  trade price vs the prevailing mid at print time (already needed for the fill rule).
- Batch flush interval and the exact `mem_limit` for the VM container (tune from the taster).
