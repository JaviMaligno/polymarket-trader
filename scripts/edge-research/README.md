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
