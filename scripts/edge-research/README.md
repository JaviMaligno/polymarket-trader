# Edge Research harness

Validates edge hypotheses against a uniform cost-aware bar. See
`docs/superpowers/specs/2026-06-05-edge-research-program-design.md`.

## Install
    pip install -r scripts/edge-research/requirements.txt

## Test (no DB needed — synthetic fixtures)
    pytest scripts/edge-research/tests -v

## Run against real data (needs DATABASE_URL to the trading DB)
    NODE_TLS_REJECT_UNAUTHORIZED=0 DATABASE_URL=postgres://... \
      python scripts/edge-research/run.py --out scripts/edge-research/out --computed-at <ISO>

On the VM the DB is local to the timescaledb container; copy the module in and
run with the container connection string, mirroring p2-tstat.

## Run via CSV export (used for the first baseline)

The dashboard container is Node/Alpine (no Python). Easiest path: export the
resolved panel to CSV from the VM, then run locally where Python is installed:

    # on the VM
    docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading \
      -c "COPY (SELECT market_id, snapshot_at, end_date, yes_price, market_type, \
                market_score, outcome_yes FROM market_panel WHERE outcome_yes IS NOT NULL) \
          TO STDOUT WITH CSV HEADER" > panel_resolved.csv
    # locally
    python -c "import sys; sys.path.insert(0,'scripts/edge-research'); \
      import pandas as pd; from data import shape_panel; from run import run_validators; \
      from scoreboard import render_markdown; \
      df=shape_panel(pd.read_csv('panel_resolved.csv', parse_dates=['snapshot_at','end_date'])); \
      r=run_validators(df,{'market_panel_resolved'},'<ISO>'); \
      print(render_markdown(r['verdicts'], r['blocked']))"

## First baseline (2026-06-05) — calibration has no tradeable edge yet

Run over 1,178 markets (earliest snapshot per market; 96% event_long). Findings:
- Global Brier **0.0635** with base rate 0.157 — the base-rate Brier would be
  0.132, so the price is **well-calibrated in aggregate** (Brier well below it).
- `min_n` raised **50 → 200** (at 50 a thin ~66-market favourite bin read a
  noisy -23%).
- The `pass` gate requires a **positive** net edge (an *underpriced* / LONG bin
  where buying gains net of cost). Overpriced favourite bins are the known
  anti-edge (SHORT-resolves-NO artefact) and are `fail`, not a tradeable short.
- **Result: every calibration slice is `fail` or `inconclusive` — no tradeable
  (positive, net-of-cost, significant) calibration edge in the current panel.**
  The price is well-calibrated; the only significant deviations are on the
  favourite side, which is not tradeable. See `out/scoreboard.md`.

All other hypotheses (H-SUP/H-HOR/H-INE/H-MM/H-ENS) show as `blocked` in v1 —
their validators arrive in Sub-projects B/C.
