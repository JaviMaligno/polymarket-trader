# Market Panel Recorder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a forward data-collection recorder — a weekly panel of liquid Polymarket markets (`market_panel` table) capturing features + price each week and backfilling the resolution outcome — to feed the calibration / supervised-model / holding-horizon research vías.

**Architecture:** One Node script, `scripts/market-panel-snapshot.js`, idempotent: creates the table if absent, records one row per `(market_id, ISO week)` for every liquid active market (`ON CONFLICT DO NOTHING` enforces weekly cadence), backfills the outcome on resolved markets, prints a report. Run daily by the existing `flb-shadow-snapshot.yml` workflow inside the dashboard container (which has `pg` + `DATABASE_URL`).

**Tech Stack:** Node.js (`pg`), PostgreSQL/TimescaleDB, GitHub Actions, `gcloud compute ssh`/`scp`.

**Testing note:** This project's `scripts/` are DB ops-scripts with no vitest harness (see `flb-shadow-snapshot.js`, `p2-tstat.js`). The test loop here is run-and-verify against the live DB, matching that convention. The script is idempotent so re-running is safe.

**Spec:** `docs/superpowers/specs/2026-05-19-market-panel-recorder-design.md`
**Branch:** `feat/market-panel-recorder` (already created and checked out).

---

### Task 1: Create the recorder script

**Files:**
- Create: `scripts/market-panel-snapshot.js`

- [ ] **Step 1: Write `scripts/market-panel-snapshot.js`**

```javascript
#!/usr/bin/env node
/**
 * market-panel-snapshot.js
 *
 * Forward data-collection recorder for the trading-edge research program
 * (calibration / supervised model / holding-horizon vías — see
 * docs/superpowers/specs/2026-05-19-market-panel-recorder-design.md).
 *
 * Weekly panel: one row per (market_id, ISO week) for every liquid active
 * market, capturing its features + price. PRIMARY KEY (market_id, iso_week)
 * + ON CONFLICT DO NOTHING makes it exactly one snapshot per market per week,
 * however often the script runs. On resolution, every row of that market is
 * backfilled with the outcome.
 *
 * Run daily; idempotent. Run inside the dashboard container (has pg +
 * DATABASE_URL):
 *   docker exec polymarket-dashboard-api node /app/market-panel.js
 */

const { Pool } = require('pg');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

// Data-hygiene floor — drops dead markets whose price is stale/default 0.50.
// Not a strict gate; tune from the first run's reported count.
const LIQUIDITY_FLOOR = parseFloat(arg('liquidity-floor', '100'));

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  console.log(`=== Market panel snapshot — ${new Date().toISOString().slice(0, 10)} ===`);
  console.log(`liquidity floor: ${LIQUIDITY_FLOOR}`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS market_panel (
      market_id        text NOT NULL,
      iso_week         text NOT NULL,
      snapshot_at      timestamptz NOT NULL DEFAULT NOW(),
      market_type      text,
      category         text,
      question         text,
      event_id         text,
      end_date         timestamptz,
      created_at       timestamptz,
      yes_price        numeric(10,6),
      last_trade_price numeric(10,6),
      best_bid         numeric(10,6),
      best_ask         numeric(10,6),
      spread           numeric(10,6),
      volume_24h       numeric(20,6),
      liquidity        numeric(20,6),
      market_score     numeric(10,4),
      realized_vol_24h numeric(12,6),
      ttr_days         numeric(10,3),
      market_age_days  numeric(10,3),
      resolved_outcome text,
      resolved_at      timestamptz,
      outcome_yes      smallint,
      PRIMARY KEY (market_id, iso_week)
    )`);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_market_panel_market ON market_panel (market_id)`);

  // Step 1 — record one row per (market, ISO week) for liquid active markets.
  const ins = await pool.query(`
    INSERT INTO market_panel (
      market_id, iso_week, market_type, category, question, event_id,
      end_date, created_at, yes_price, last_trade_price, best_bid, best_ask,
      spread, volume_24h, liquidity, market_score, realized_vol_24h,
      ttr_days, market_age_days)
    SELECT
      id, to_char(NOW(), 'IYYY"-W"IW'),
      market_type, category, question, event_id,
      end_date, created_at, current_price_yes, last_trade_price, best_bid, best_ask,
      spread, volume_24h, liquidity, market_score, realized_volatility_24h,
      EXTRACT(EPOCH FROM (end_date - NOW())) / 86400.0,
      EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400.0
    FROM markets
    WHERE is_active = true AND COALESCE(is_resolved, false) = false
      AND current_price_yes IS NOT NULL
      AND liquidity >= $1
    ON CONFLICT (market_id, iso_week) DO NOTHING`,
    [LIQUIDITY_FLOOR]);
  console.log(`Step 1 — rows recorded this run: ${ins.rowCount}`);

  // Step 2 — backfill the outcome on rows whose market has resolved.
  const upd = await pool.query(`
    UPDATE market_panel p SET
      resolved_outcome = lower(m.resolution_outcome),
      resolved_at      = m.resolved_at,
      outcome_yes      = CASE WHEN lower(m.resolution_outcome) = 'yes' THEN 1 ELSE 0 END
    FROM markets m
    WHERE m.id = p.market_id
      AND m.is_resolved = true
      AND lower(m.resolution_outcome) IN ('yes','no')
      AND p.resolved_outcome IS NULL`);
  console.log(`Step 2 — rows newly scored (market resolved): ${upd.rowCount}`);

  // Step 3 — report.
  const r = (await pool.query(`
    SELECT COUNT(*) AS rows,
      COUNT(DISTINCT market_id) AS markets,
      COUNT(DISTINCT iso_week) AS weeks,
      COUNT(*) FILTER (WHERE resolved_outcome IS NOT NULL) AS scored,
      pg_size_pretty(pg_total_relation_size('market_panel')) AS size
    FROM market_panel`)).rows[0];
  console.log('');
  console.log(`Panel total: ${r.rows} rows | ${r.markets} markets | ${r.weeks} weeks ` +
    `| ${r.scored} scored | table ${r.size}`);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Verify the file parses**

Run: `node --check scripts/market-panel-snapshot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/market-panel-snapshot.js
git commit -m "feat(panel): market-panel-snapshot recorder script"
```

---

### Task 2: First run + validate against the live DB

This is the test loop — run the script against the real DB and verify the spec's validation criteria. The script is idempotent so this is safe.

**Files:** none (validation only; a fix-commit only if a defect is found).

- [ ] **Step 1: Copy the script to the VM and into the dashboard container**

```bash
gcloud compute scp scripts/market-panel-snapshot.js polymarket-vm:/tmp/market-panel.js --zone=us-east1-b
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker cp /tmp/market-panel.js polymarket-dashboard-api:/app/market-panel.js"
```
Expected: scp shows 100%, no errors.

- [ ] **Step 2: Run it — verify the report**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker exec polymarket-dashboard-api node /app/market-panel.js"
```
Expected: `Step 1 — rows recorded this run: N` with N in the low thousands;
`Step 2 — rows newly scored: 0` (markets recorded this instant have not
resolved yet); `Panel total: N rows | N markets | 1 weeks | 0 scored | table <size>`
(rows == markets on the first run; one week).

If N is implausibly low (< ~500) or high (> ~8000), note it — the
`--liquidity-floor` default (100) may need tuning in Step 5.

- [ ] **Step 3: Verify features are populated**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -c \"
SELECT
  COUNT(*) AS rows,
  COUNT(*) FILTER (WHERE yes_price IS NULL) AS null_price,
  COUNT(*) FILTER (WHERE ttr_days IS NULL) AS null_ttr,
  COUNT(*) FILTER (WHERE market_type IS NULL) AS null_type,
  ROUND(AVG(ttr_days)::numeric,1) AS avg_ttr,
  ROUND(MIN(yes_price)::numeric,3) AS min_px,
  ROUND(MAX(yes_price)::numeric,3) AS max_px
FROM market_panel;\""
```
Expected: `null_price = 0` (the WHERE clause requires `current_price_yes IS NOT NULL`); `null_type` near 0; `null_ttr` small (only markets with no `end_date`); `avg_ttr` positive; `min_px`/`max_px` within (0,1).

- [ ] **Step 4: Verify idempotency — run again, row count must not change**

```bash
gcloud compute ssh polymarket-vm --zone=us-east1-b --command="docker exec polymarket-dashboard-api node /app/market-panel.js"
```
Expected: `Step 1 — rows recorded this run: 0` (ON CONFLICT DO NOTHING — same ISO week); `Panel total` rows unchanged from Step 2.

- [ ] **Step 5: If a defect was found, fix and commit; otherwise note "validation passed, no change"**

If Step 2/3/4 revealed a bug (wrong column, null where it should not be, idempotency broken) or the count needs a different `--liquidity-floor`, edit `scripts/market-panel-snapshot.js`, re-run Steps 1-4, then:
```bash
git add scripts/market-panel-snapshot.js
git commit -m "fix(panel): <what the validation surfaced>"
```
If validation passed clean, there is nothing to commit — record the observed counts in the Task 3 PR body.

---

### Task 3: Wire the recorder into the daily workflow

**Files:**
- Modify: `.github/workflows/flb-shadow-snapshot.yml` — the "Run shadow snapshot on VM" step.

- [ ] **Step 1: Extend the workflow step to also run the panel script**

In `.github/workflows/flb-shadow-snapshot.yml`, find the final two lines of the `Run shadow snapshot on VM` step:

```yaml
          gcloud compute scp scripts/flb-shadow-snapshot.js polymarket-vm:/tmp/flb-shadow.js --zone=$ZONE
          $SSH --command="docker cp /tmp/flb-shadow.js polymarket-dashboard-api:/app/flb-shadow.js && docker exec polymarket-dashboard-api node /app/flb-shadow.js"
```

Replace them with (adds the panel script alongside, one SSH session):

```yaml
          gcloud compute scp scripts/flb-shadow-snapshot.js polymarket-vm:/tmp/flb-shadow.js --zone=$ZONE
          gcloud compute scp scripts/market-panel-snapshot.js polymarket-vm:/tmp/market-panel.js --zone=$ZONE
          $SSH --command="docker cp /tmp/flb-shadow.js polymarket-dashboard-api:/app/flb-shadow.js && docker cp /tmp/market-panel.js polymarket-dashboard-api:/app/market-panel.js && docker exec polymarket-dashboard-api node /app/flb-shadow.js && docker exec polymarket-dashboard-api node /app/market-panel.js"
```

Also update the step `name:` from `Run shadow snapshot on VM` to `Run shadow + panel snapshots on VM`.

- [ ] **Step 2: Validate the workflow YAML**

Run: `python -c "import yaml; yaml.safe_load(open('.github/workflows/flb-shadow-snapshot.yml')); print('YAML OK')"`
Expected: `YAML OK`

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/flb-shadow-snapshot.yml
git commit -m "feat(panel): run market-panel-snapshot in the daily workflow"
```

---

### Task 4: Open the pull request

**Files:** none.

- [ ] **Step 1: Verify the GitHub account, then push and open the PR**

```bash
gh auth status | grep -q 'Active account: true.*JaviMaligno' || gh auth switch --user JaviMaligno
git push -u origin feat/market-panel-recorder
gh pr create --title "feat(panel): market-panel recorder — forward dataset for the edge research program" --body "Implements docs/superpowers/specs/2026-05-19-market-panel-recorder-design.md.

Adds scripts/market-panel-snapshot.js — a weekly panel recorder (table market_panel, one row per (market_id, ISO week), features + price, outcome backfilled on resolution) — and runs it from the daily flb-shadow-snapshot workflow. Forward data-collection foundation for the calibration / supervised-model / holding-horizon research vias.

Validation (first run, see Task 2): <fill in observed row count, null checks, idempotency result>.

Collector only — the three analyses are out of scope per the spec.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```
Expected: PR URL printed. Fill the `<...>` validation placeholder with the Task 2 observed numbers before/when creating the PR.

---

## Self-Review

**Spec coverage:**
- `market_panel` table, self-created, exact columns → Task 1 Step 1 (`CREATE TABLE`). ✓
- Record step (weekly dedup via PK + ON CONFLICT) → Task 1 Step 1, validated Task 2 Step 4. ✓
- Score step (outcome backfill) → Task 1 Step 1; first-run shows 0 (Task 2 Step 2), exercised forward. ✓
- Report step → Task 1 Step 1, verified Task 2 Step 2. ✓
- Liquidity floor (default 100, tune from first run) → `LIQUIDITY_FLOOR` arg, Task 2 Steps 2/5. ✓
- Daily scheduling via flb-shadow-snapshot.yml → Task 3. ✓
- `flb_shadow_signals` untouched → no task modifies it. ✓
- Validation plan → Task 2. ✓
- Out of scope (analyses, path features, order-book depth, retention) → no tasks for them. ✓

**Placeholder scan:** The PR body has one intentional `<...>` for the engineer to fill with observed validation numbers (Task 4 Step 1 says so explicitly). No other placeholders.

**Type consistency:** Column names in the `CREATE TABLE`, the `INSERT`, the score `UPDATE`, and the verification queries all match (`market_id`, `iso_week`, `yes_price`, `ttr_days`, `resolved_outcome`, `outcome_yes`, etc.). The script joins `markets.id = market_panel.market_id` consistently. The markets-table source columns (`current_price_yes`, `last_trade_price`, `best_bid`, `best_ask`, `realized_volatility_24h`, `event_id`, `market_score`) all exist in the verified `markets` schema.

**Scoping note:** Scoring (Step 2) cannot be fully validated on day 1 — recorded markets have not resolved yet. Verified forward by a follow-up check after a few days (the daily run exercises it); not a PR blocker. The spec's validation plan already states this.
