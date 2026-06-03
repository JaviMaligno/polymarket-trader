# FLB Paper Executor — Design Spec

**Date**: 2026-06-03
**Status**: Approved design — ready for implementation plan.
**Supersedes (for the build posture)**: `docs/plans/2026-05-20-flb-executor-design.md` (pre-build design; this spec adopts its settled decisions and re-scopes Phase 1/2 into a single paper-trading build).
**Related memories**: `project_flb_strategy_design.md`, `project_flb_oq_preliminary_answers_2026-05-23.md`, `project_flb_event_long_promotion_2026-05-23.md`, `project_real_trading.md`, `feedback_realistic_costs.md`.

## 1. Context and the honest verdict state

The favorite-longshot-bias (FLB) hold-to-resolution strategy — short the longshot (buy NO)
when YES ∈ [0.02, 0.10] at TTR-to-end_date ≥ 48h, hold to resolution — is the only edge with
forward out-of-sample support in the system. In-sample backtest: n=1,015, net +2.24%/trade,
t=3.49, win rate 96.3% (caveats: single ~25-day window, censored holds, −100% tail).

**The forward verdict is NOT met for the tradeable cohort.** As of 2026-06-03, the
cohort-segmented verdict query returns:

| cohort | n resolved | avg_net | t | median hold |
|---|---|---|---|---|
| TRADEABLE (crypto_daily / event_financial / event_short) | **5** | +7.56% | 4.85 | 11.6d |
| event_long (shadow-only by live policy) | 128 | +3.00% | 2.54 | 2.6d |

The celebrated pooled "n=133, t=2.78" is ~96% `event_long`. The pre-registered build gate is
**n ≥ 100 on the tradeable cohort** — currently n=5. Per the in-sample timeline the tradeable
cohort does not reach n ≥ 100 until ~Dec 2026 / Jan 2027. The `event_long` resolved sample is
itself still censored to short holds (median 2.6d; the November election cluster has not
resolved), so even its t=2.54 understates the eventual capital-efficiency picture.

**Therefore this build deliberately separates "build" from "enable live":**
- We build the full paper-trading executor plumbing now.
- It defaults OFF (`FLB_EXECUTOR_ENABLED=false`).
- Enabling it in **paper mode** starts a realistic-cost forward track (the gap the zero-cost
  shadow recorder cannot fill). This does NOT front-run the verdict — it adds cost-aware
  forward data and exercises the accounting.
- **Live trading with a real wallet is out of scope** and remains gated on (a) the
  tradeable-cohort verdict and (b) `project_real_trading` wallet infra (not yet built).

## 2. Scope

### In scope
- `FLBExecutor` service in `packages/dashboard`, parallel to `AutoSignalExecutor`.
- `FLBScanner` — daily band+TTR scan (reuses `flb-shadow-snapshot` selection logic) that
  additionally resolves the NO token id and reads `orderbook_snapshots` for cost realism.
- Paper SHORT-longshot opens (buy NO) with **realistic entry cost from `markets.spread`**
  (the half-spread crossing cost, same source/formula as Lever 1 — covers 100% of the
  universe). `fill_source='spread'` in this build. An **opportunistic order-book walk** via
  `OrderBookExecutionSimulator` is supported by the gate chain (`fill_source='orderbook'`) and
  unit-tested, but is NOT wired into the live scanner in this build — see the "Build status"
  note under Data Reality (deliberate YAGNI: books cover only ~2.5% of the universe).
- New `flb_positions` table + capital-lockup accounting (independent FLB sub-ledger).
- `FLBReconciler` — daily settle on market resolution; release locked capital; alert on
  overdue-unresolved.
- Cohort: **tradeable + event_long**, in paper mode only (zero real capital). The shadow-only
  policy for event_long was a live-4h-trading decision; paper-trading it under FLB is what
  produces the cost-aware forward data needed for the eventual promotion decision.
- Unit + integration tests (TDD). Daily-review "FLB paper PnL" line.

### Out of scope
- Real-wallet order placement / live fills (depends on `project_real_trading`).
- Stop-loss / time-exit on FLB positions (explicitly rejected — the edge IS holding to
  resolution).
- Cross-strategy capital allocation between the 4h trader and FLB (4h trades near zero; FLB
  gets an independent notional sub-ledger).
- Optuna tuning of FLB params (params are env-driven with documented ranges; tuning is later).
- Replacing the shadow recorder or the Lever 1/2/3 kill-criteria — those stay; the paper
  executor complements them with realistic cost.

## 3. Architecture

```
[dashboard server.ts — setInterval, gated on FLB_EXECUTOR_ENABLED]
   │
   ├─ scan tick (every FLB_SCAN_INTERVAL_MS, default 6h)
   │     FLBScanner.scan()
   │        → select active markets: YES ∈ [LO,HI], TTR ≥ MIN_TTR, not resolved
   │        → resolve NO token id; read latest orderbook_snapshot for NO token
   │     FLBExecutor.execute(signals)
   │        → per signal: gate chain flb_0a..0g
   │        → cost model: entry_cost_pct = (spread/2)/no_price  [fill_source='spread'],
   │          OR OrderBookExecutionSimulator.simulateBuy(NO) when a fresh NO snapshot
   │          exists [fill_source='orderbook']
   │        → insert flb_positions (status=open); lock capital
   │
   └─ reconcile tick (every FLB_RECONCILE_INTERVAL_MS, default 6h)
         FLBReconciler.run()
            → for each open flb_position: load market
            → market is_resolved → settle: gross_pnl, net_pnl, hold_days,
              status=resolved, release locked capital, add flb_realized_pnl
            → resolution_outcome not in (yes,no) (voided) → status=voided, refund stake
            → not resolved but NOW > end_date + 24h → log alert (no settle)
```

### Why in-process dashboard `setInterval` (not data-collector Scheduler, not GHA)
`FLBExecutor` needs `OrderBookExecutionSimulator` and `paper_account`, both in the dashboard
package. The dashboard already runs periodic services via `setInterval` in `server.ts`. The
data-collector `Scheduler` is a different container without these services; a GHA workflow
(as the shadow recorder uses) adds operational surface for no benefit here.

### Why a separate `flb_positions` table and sub-ledger
`paper_positions` and every consumer (`PositionClosingService`, `RiskManager`,
`StopLossService`, `MAX_HOLD_TIME_HOURS`) assume short rotating-capital holds with stop-loss /
time-exit. FLB holds 6 months with no exits. Mixing them entangles two capital models and two
exit semantics. A separate table + independent sub-ledger keeps the strategy classes
orthogonal and the rollback clean (drop nothing; flip the flag off).

### Bypass of the 4h gate chain
`FLBExecutor` does NOT run `AutoSignalExecutor`'s gates 0a–0f — they are hostile to FLB
(e.g. the near-resolved-price gate would block the entire 0.02–0.10 band). It runs its own
minimal chain (§5).

### Data Reality (verified 2026-06-03 — drives the cost model)
Verified against the VM DB; these facts are load-bearing:
- **`markets.clob_token_id_no` exists** (indexed). The NO token id is directly available — no
  derivation needed. ✓
- **`markets.spread` covers 100%** of the active tail-band universe (event_long 1728/1728,
  event_financial 139/139, crypto_daily 16/16, event_short 13/13). Median spread: event_long
  0.020, event_financial 0.042, crypto_daily 0.010, event_short 0.017.
- **`orderbook_snapshots` covers only ~47 markets** (the 35-market 4h-tracked set), i.e. ~2.5%
  of the ~1,896-market tail-band universe. `volume_24h` covers only ~40%.

**Consequence — the cost engine is `markets.spread`, NOT the order-book simulator.** Using the
simulator as the primary fill source would reject ~58% of FLB signals ("no market data") and
crudely volume-estimate the rest. The honest, fully-covered realistic cost is the half-spread
crossing cost `entry_cost_pct = (spread / 2) / no_price` — the exact formula Lever 1
(`flb-cost-realism-check`) already validated. A signal whose `spread` is null/≤0 is rejected by
flb_0d (cannot price the entry).

> **Build status (2026-06-03): order-book walk is a tested extension point, NOT wired live.**
> The gate chain (`flbGates.evaluateSignal`) fully supports an `fill_source='orderbook'` branch
> (a fresh NO snapshot's book-walk price overrides the spread cost) and it is unit-tested. But
> `FLBScanner` does **not** read `orderbook_snapshots` in this build, so no live candidate sets
> the `book*` fields and **every live fill is `fill_source='spread'`**. This is deliberate YAGNI:
> order books cover only ~2.5% of the FLB universe and the spread cost is already realistic and
> 100%-covered, so the marginal value of the walk does not justify the per-scan book-fetch load
> on the e2-micro. Wiring it (an executor pre-pass that calls `OrderBookExecutionSimulator`
> for candidates with a fresh NO snapshot) is a clean future extension; the gate already accepts
> the result.

## 4. Data model

### New table `flb_positions`
```sql
CREATE TABLE IF NOT EXISTS flb_positions (
  id                 BIGSERIAL PRIMARY KEY,
  market_id          TEXT NOT NULL UNIQUE,          -- enforces flb_0g (one position per market)
  market_type        TEXT NOT NULL,
  opened_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  entry_yes_price    NUMERIC(10,6) NOT NULL,
  entry_no_price     NUMERIC(10,6) NOT NULL,        -- mid NO = 1 - entry_yes_price
  executed_no_price  NUMERIC(10,6) NOT NULL,        -- price actually paid = no_mid + half-spread (or book-walk avg)
  no_size            NUMERIC(18,6) NOT NULL,        -- NO shares bought = no_stake / executed_no_price
  no_stake           NUMERIC(18,6) NOT NULL,        -- dollars committed (the locked capital)
  fee_paid           NUMERIC(18,6) NOT NULL DEFAULT 0,
  slippage_pct       NUMERIC(10,4),
  fill_source        TEXT,                          -- 'spread' | 'orderbook'
  entry_cost_pct     NUMERIC(10,4),                 -- (spread/2)/no_price (percent); the value checked by flb_0d
  ttr_hours_at_entry NUMERIC(10,2),
  end_date           TIMESTAMPTZ,
  status             TEXT NOT NULL DEFAULT 'open',   -- open | resolved | voided
  resolved_at        TIMESTAMPTZ,
  resolution_outcome TEXT,
  gross_pnl          NUMERIC(18,6),
  net_pnl            NUMERIC(18,6),
  hold_days          NUMERIC(10,3)
);
CREATE INDEX IF NOT EXISTS idx_flb_positions_status ON flb_positions (status);
CREATE INDEX IF NOT EXISTS idx_flb_positions_end_date ON flb_positions (end_date);
```

### `paper_account` additions
```sql
ALTER TABLE paper_account ADD COLUMN IF NOT EXISTS flb_locked_capital NUMERIC(18,6) NOT NULL DEFAULT 0;
ALTER TABLE paper_account ADD COLUMN IF NOT EXISTS flb_realized_pnl   NUMERIC(18,6) NOT NULL DEFAULT 0;
```

Note: schema lives in init SQL for fresh volumes AND a startup `CREATE TABLE IF NOT EXISTS` /
`ALTER TABLE ... IF NOT EXISTS` path, because init SQL only runs on first volume init (memory:
"new tables need startup CREATE TABLE IF NOT EXISTS"). The plan must add both, and the VM
deploy step creates the table/columns manually (existing volume).

### Capital model — independent FLB sub-ledger
- FLB notional budget = `FLB_MAX_LOCKED_CAPITAL_PCT × paper_account.initial_capital`.
- FLB does **not** draw from the 4h trader's `current_capital` / `available_capital`.
- Open: `flb_locked_capital += no_stake + fee` (guarded by flb_0f).
- Settle: release the stake; `flb_realized_pnl += net_pnl`; `flb_locked_capital -= (no_stake + fee)`.
- Invariants (checked in tests and addable to daily-review):
  - `flb_locked_capital ≥ 0` and `flb_locked_capital ≤ FLB_MAX_LOCKED_CAPITAL_PCT × initial_capital`.
  - `flb_realized_pnl = SUM(net_pnl) FROM flb_positions WHERE status='resolved'`.
  - `flb_locked_capital = SUM(no_stake + fee_paid) FROM flb_positions WHERE status='open'`.

### Entry pricing and PnL (dollars; the entry cost is baked into `executed_no_price`)
- `no_mid = 1 − entry_yes_price`. `entry_cost_pct = (spread / 2) / no_mid` (a fraction).
- `executed_no_price = no_mid + spread/2` (spread path) — or the book-walk avg price when
  `fill_source='orderbook'`. The cost is in the price (we get fewer shares), so no separate
  cost subtraction is needed; `fee_paid` defaults 0 (Polymarket has no trading fee; the
  book-walk path may carry the simulator's fee).
- Stake `S = no_stake` (the locked capital) buys `no_size = S / executed_no_price` NO shares.
- Resolves NO (longshot loses, our short wins): payout `= no_size × 1.0`;
  `gross_pnl = no_size − S`; `net_pnl = gross_pnl − fee_paid`.
- Resolves YES (wipeout): `net_pnl = −S − fee_paid`.
- Resolution settles at par — no exit fee, no exit slippage (the structural reason FLB beats
  the 4h paradigm).
- Sanity tie-out: per-dollar net `= no_size/S − 1 = 1/executed_no_price − 1`. With
  `executed_no_price ≈ no_mid + spread/2`, this reproduces the shadow's
  `entry_yes/(1−entry_yes) − entry_cost` form to first order — the executor must tie out to the
  shadow recorder on a zero-spread fixture.

## 5. Gate chain (`FLBExecutor`)

```
flb_0a  market active AND not resolved
flb_0b  TTR-to-end_date ≥ FLB_MIN_TTR_HOURS (48h)
flb_0c  YES ∈ [FLB_LONGSHOT_LO, FLB_LONGSHOT_HI] = [0.02, 0.10]
flb_0d  entry_cost_pct = (spread/2)/no_mid ≤ FLB_MAX_ENTRY_COST_PCT (1.0%);
        reject if spread is null/≤0 (cannot price); when a fresh NO snapshot exists,
        use the book-walk avg price instead and reject if simulator executed=false
flb_0e  ISO-week concentration cap: open positions resolving in the same ISO week
        (by end_date) < FLB_MAX_SAME_WEEK_POSITIONS (default 50)
flb_0f  flb_locked_capital + (no_stake + fee) ≤ FLB_MAX_LOCKED_CAPITAL_PCT × initial_capital
flb_0g  no existing open flb_position on this market_id (UNIQUE constraint + pre-check)
→ execute: simulateBuy(NO) → insert flb_positions(status=open) → lock capital
```

Each gate rejection is logged with a structured reason (mirrors `AutoSignalExecutor`'s
REJECTED log format so the daily-review gate-fire-log query picks it up).

## 6. Sizing (from OQ#4, 1/4 Kelly)

> **Units:** every `*_PCT` parameter is in **percentage points** (e.g. `5.0` = 5%, `0.21` =
> 0.21%). All formulas divide by 100: `stake = (FLB_MAX_POSITION_PCT / 100) × initial_capital`.

- Per-position stake = `(FLB_MAX_POSITION_PCT / 100) × initial_capital`, default **0.21%**
  (≈ $21 on $10,000), the 1/4-Kelly figure. (The 2026-05-20 doc's 0.5% default is superseded by the OQ#4
  data-derived 0.21%.)
- Total locked cap = `FLB_MAX_LOCKED_CAPITAL_PCT` = **5%** of initial capital (flb_0f).
- ISO-week cap = 50 positions resolving the same week (flb_0e) — the "10% capital per week"
  equivalent binds via flb_0f.
- If forward weekly realized wipeout rate exceeds 1.5× the in-sample worst (> 10%) over ≥ 3
  forward weeks, drop to 1/8 Kelly (`FLB_MAX_POSITION_PCT=0.10`). Documented, not automated.

## 7. Parameters (env-driven)

| Env var | Default | Optuna range | Kind | Meaning |
|---|---|---|---|---|
| `FLB_EXECUTOR_ENABLED` | `false` | — | structural | Master on/off. |
| `FLB_DRY_RUN` | `false` | — | structural | If true: run gates + log intents, do NOT insert positions. Optional smoke-test aid. |
| `FLB_SCAN_INTERVAL_MS` | `21600000` (6h) | — | operational | Scan cadence. |
| `FLB_RECONCILE_INTERVAL_MS` | `21600000` (6h) | — | operational | Reconcile cadence. |
| `FLB_LONGSHOT_LO` | `0.02` | — | structural | Band lower bound. |
| `FLB_LONGSHOT_HI` | `0.10` | — | structural | Band upper bound. |
| `FLB_MIN_TTR_HOURS` | `48` | `[36, 96]` | tunable | Min TTR at entry. |
| `FLB_MAX_ENTRY_COST_PCT` | `1.0` | `[0.5, 1.5]` | tunable | Spread filter ceiling (flb_0d). |
| `FLB_MAX_POSITION_PCT` | `0.21` | `[0.10, 1.0]` | tunable | Per-position stake as % of initial capital. |
| `FLB_MAX_LOCKED_CAPITAL_PCT` | `5.0` | — | structural | Total locked ceiling (flb_0f). |
| `FLB_MAX_SAME_WEEK_POSITIONS` | `50` | `[1, 60]` | tunable | ISO-week concentration cap (flb_0e). |
| `FLB_ELIGIBLE_TYPES` | `crypto_daily,event_financial,event_short,event_long` | — | structural | Paper cohort (includes event_long; live promotion is a separate future decision). |

## 8. Testing (TDD)

### Unit — `FLBExecutor.test.ts`
| Case | Setup | Expected |
|---|---|---|
| Qualifying (spread path) | YES 0.05, TTR 96h, spread 0.01 → cost ~0.53% | SHORT NO, fill_source='spread', stake = (FLB_MAX_POSITION_PCT/100) × initial |
| Wide spread | YES 0.05, TTR 96h, spread 0.04 → cost ~2.1% | REJECT flb_0d |
| Spread null/zero | spread IS NULL | REJECT flb_0d (cannot price) |
| Fresh NO snapshot present | snapshot exists, book-walk cost 0.4% | fill_source='orderbook', uses book-walk avg price |
| Book-walk unfillable | snapshot exists but simulator executed=false | REJECT flb_0d |
| TTR too short | YES 0.05, TTR 24h | REJECT flb_0b |
| Out-of-band low | YES 0.01 | REJECT flb_0c |
| Out-of-band high | YES 0.15 | REJECT flb_0c |
| Duplicate | open flb_position exists on market | REJECT flb_0g |
| Locked-cap | new stake would exceed FLB_MAX_LOCKED_CAPITAL_PCT | REJECT flb_0f |
| Same-week cap | FLB_MAX_SAME_WEEK_POSITIONS already resolving that ISO week | REJECT flb_0e |
| Sizing math | initial 10000, pct 0.21 | stake = 0.21/100 × 10000 ≈ 21, no_size = stake / executed_no_price |

### Unit — `FLBScanner.test.ts`
- Band + TTR selection matches the shadow recorder's WHERE clause.
- NO token id read from `markets.clob_token_id_no`.
- Cost-source selection: fresh NO snapshot → book-walk path; no/stale snapshot → spread path.

### Tie-out — `flb.shadow-parity.test.ts`
- On a zero-spread, zero-fee fixture the executor's per-dollar `net_pnl` equals the shadow
  recorder's `entry_yes/(1−entry_yes)` for a NO resolution and `−1` for a YES resolution
  (guards the entry-pricing/PnL derivation against drift from the validated shadow math).

### Integration — `flb.lifecycle.test.ts`
- open → reconcile(resolves NO) → status=resolved, gross/net_pnl correct, capital released,
  flb_realized_pnl updated, invariants hold.
- open → reconcile(resolves YES) → wipeout net_pnl = −stake − fee, capital released.
- open → market voided (outcome not yes/no) → status=voided, stake refunded, pnl=0.
- open → not resolved, NOW > end_date+24h → alert logged, position stays open, no settle.
- Capital invariant after a mixed batch: locked = Σ open stakes; realized = Σ resolved net_pnl.

## 9. Phasing / rollout

1. Build (TDD) → tests green → tsc clean → merge with `FLB_EXECUTOR_ENABLED=false`.
2. Deploy: create `flb_positions` + `paper_account` columns manually on VM (existing volume);
   `docker compose pull dashboard-api && up -d`.
3. Flip `FLB_EXECUTOR_ENABLED=true` in `docker-compose.gcp.yml` (via PR, not direct VM edit) →
   starts the realistic-cost forward paper track (tradeable + event_long, zero real capital).
4. Add an "FLB paper PnL" section to the daily-review (`format-review.js` /
   `daily-review-prompt.md`): open count, locked capital, realized net_pnl, win rate, and the
   cohort-segmented breakdown so the tradeable cohort is never read off the pooled number.
5. Live (real wallet): future work, gated on tradeable-cohort verdict (n ≥ 100, ~Dec 2026)
   AND `project_real_trading` infra. Not part of this build.

## 10. Rollback
- Immediate: `FLB_EXECUTOR_ENABLED=false`, restart dashboard-api. Scan/execute stop. Open
  paper positions remain and reconcile to resolution as designed (or are simply left — paper).
- Code revert: separate PR; do NOT drop `flb_positions` (historical record).

## 11. Verdict query (unchanged — segment by cohort)
The build does not change the decision gate. The tradeable-cohort verdict (n ≥ 100, net ≥ +1%,
parametric t ≥ 2 with a confirming bootstrap, plus a hold-aware annualised hurdle) remains the
condition for *live* promotion, run on `flb_shadow_signals` AND now cross-checkable against the
realistic-cost `flb_positions` track. Never read the pooled row as the verdict.
