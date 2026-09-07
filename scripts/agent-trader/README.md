# Agent-Trader — local runbook

LLM-as-trader benchmark on Polymarket: **Claude is the trading signal.** A weekly GitHub
Actions cron runs a headless Claude that researches liquid markets and places hold-to-resolution
paper bets net of spread; a deterministic Python layer resolves them and snapshots metrics.
Paper only — hypothetical $1000 bankroll, flat $25/bet, no real funds.

`.github/workflows/agent-trader-weekly.yml` is the authoritative runner. Everything here is for
reproducing a run by hand.

## Setup

Needs **Python ≥ 3.10** and network access to `gamma-api.polymarket.com`. No database, no API
key for the deterministic commands.

```bash
cd scripts/agent-trader
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

To also run the LLM research loop, add the CLI and log in as you normally would:

```bash
npm install -g @anthropic-ai/claude-code
claude       # once, to authenticate
```

## Running

```bash
./run-local.sh          # evaluate -> summary -> metrics row -> email preview
./run-local.sh --dry    # evaluate + summary only; no metrics row, no email file
./run-local.sh --agent  # the full weekly loop, including the LLM research run
```

The script never commits or pushes — inspect `git diff` and commit yourself. Use `--dry` when
poking at state, so a debugging session doesn't append a bogus row to `metrics.jsonl`.

`--dry` is not read-only: `evaluate` runs in every mode, so it can still write `bets.jsonl`
(book a market that resolved, refresh the open marks). What `--dry` skips is the run history
and the email. Nothing here is destructive — but if you want a genuinely untouched tree, run
the individual read-only commands below instead.

Individual commands, if you prefer them raw:

| Command | What it does | Network | Writes |
|---|---|---|---|
| `python agent_trader.py evaluate` | Re-fetch open bets: book the formally resolved ones, snapshot the rest as `mark_yes_price` | yes | `bets.jsonl` |
| `python agent_trader.py summary` | Record, P&L, bankroll, Brier, mark-to-market | no | — |
| `python metrics.py` | Calibration, by-confidence, cost-aware bootstrap verdict | no | — |
| `python agent_trader.py metrics <YYYY-MM-DD>` | Same, and appends the dated row to `metrics.jsonl` | no | `metrics.jsonl` |
| `python agent_trader.py candidates --research` | Liquid, ≤45d, spread ≤3%, non-sports candidate markets | yes | — |
| `python agent_trader.py email_html out.html` | Render the weekly email | no | `out.html` |

`evaluate` is deterministic and safe to run any day: it rewrites `bets.jsonl` atomically (temp
file + `os.replace`), so an interrupted run cannot truncate the track record. It only evaluates
on the cron's own schedule, so a bet that resolves mid-week sits `open` until the next scheduled
run (Monday, or the 2nd-of-month catch-up) unless you run it yourself.

## Guarded entries and independent review

Every new entry must pass three gates: frozen concentration exposure, structured
evidence, and a fresh independent Claude reviewer. Both runners create private
run state **before** `evaluate`; a position resolved during the run continues to
block its underlying risk group. A new scheduled/manual run releases resolved
groups. Open groups and markets in the same Gamma event also block new entries.
Known legacy themes (Iran/Hormuz, Russia Duma, etc.) are classified automatically;
unknown legacy exposure stops the run until an explicit group is supplied through
a reviewed data migration. Historical entry probabilities are never rewritten.

The investigator writes a proposal; `record` launches a separate CLI session with
only WebSearch/WebFetch, no Bash/Write/Edit, no MCP servers and no conversation
reuse. It can veto without offering another trade. The default review model is
`claude-sonnet-4-6`; `AGENT_REVIEW_MODEL` may override it. It inherits the existing
local login or Foundry authentication. Allow up to 10 minutes per review.

Python requires the full current description and paragraph count, sourced payout
conditions, recently checked URLs, justified probability scenarios, counterargument,
falsifier and price-history analysis. It fetches the market's own history around
the motivating news and passes it to the reviewer. It then refreshes the rules and
quote; **both** probability estimates must clear 5% net edge, spread must be at
most 3%, and stake is fixed at $25 paper. Missing data, malformed output, timeouts,
provider errors and vetoes all reject the entry.

Each accepted row retains the proposal, independent verdict, reviewed market and
price history, risk group, event IDs, reviewed edge and run ID. Rejected reviews
and provider errors remain in private run state; record veto reasons in lessons.
A final audit compares entries with per-run receipts and
protects historical entry fields. Failed audits stop metrics/email/persistence.
These controls prevent accidental bypass; shared filesystem access is not an
adversarial security boundary. Source truth, scenario weights and previously unseen
correlations still require sound reviewer judgment.

## Placing a bet by hand

Use one state file per complete run, shared by all proposals. Do not initialize
again between bets or after evaluation. Run-state files expire after 12 hours.

```bash
cd scripts/agent-trader
RUN_TMP=$(mktemp -d)
export AGENT_TRADER_RUN_STATE="$RUN_TMP/run-state.json"
python entry_gate.py begin
python agent_trader.py evaluate
# Write a fully researched JSON proposal using proposal.example.json as the schema.
python agent_trader.py record "$RUN_TMP/proposal.json"
python entry_gate.py audit
```

The example is fictional and deliberately not tradeable. Source IDs must resolve
within `sources`; scenario weights must sum to 1 and reproduce `p_hat_yes` within
0.005. `accessed_at` timestamps must include a timezone and be within 48 hours.
For an edge above 0.25, `sibling_markets` is required: each item needs `market_id`,
`url`, `criterion`, `comparison`, `yes_price`, `liquidity`, and `source_ids`.
For seat markets, `seat_model` requires `chamber_size`, `method`, and `parties`:
each party needs `party`, `baseline`, `list_seats`, `constituency_seats`, and
`source_ids`. Include all parties/others so projected seats sum to the chamber.
For pure proportional systems, constituency seats are zero. The reviewer checks
the mechanisms, thresholds and joint feasibility beyond this arithmetic.
The old multi-argument CLI
and imported `record_bet(...)` now reject instead of appending unreviewed prose.

**Never pass the rationale as a shell argument.** It was inlined in a double-quoted string until
2026-08-03, and bash expanded `$4`, `$1`, `$7`, `$6` to empty positional parameters — every
dollar figure in four bets' rationales silently lost its leading digit (`$4.7M` → `.7M`). The
`record` subcommand decodes a JSON file, preserving dollar figures in its rationale;
the corrupted historical rows are left in place because the log is never rewritten by hand, and
are documented in `lessons.md`.

## Files

| File | Role |
|---|---|
| `bets.jsonl` | The track record — the source of truth. `record` only ever appends; `evaluate` updates a row in place (status/P&L on resolution, `mark_yes_price` weekly). Rows are never deleted |
| `lessons.md` | The learning loop: one `## Run N — <date>` per run, fed into every decision prompt |
| `metrics.jsonl` | Trajectory: one cumulative-metrics snapshot per run |
| `agent-trader-prompt.md` | The decision prompt handed to headless Claude |
| `agent_trader.py` | Candidates, `record`, `evaluate`, `summary`, `email_html` |
| `metrics.py` | Calibration, mark-to-market, bootstrap CI, snapshots |

## Reading the output honestly

- **`n_resolved < 20` means there is no verdict.** The bar is `mean_pnl_per_bet > 0` **and**
  bootstrap lower bound `> 0`. Below n=20 a hot or cold streak means nothing either way.
- **`edge_per_contract` is theoretical** — computed at entry from the agent's own `p_hat`. Only
  `pnl_net` is realized. Never add up edges and call it profit.
- **Mark-to-market is disclosure, not statistics.** Polymarket's formal resolution can lag the
  real-world outcome by weeks, so `summary`/email/metrics flag open positions the market has
  already decided (≤0.02 / ≥0.98) as pending wins/losses beside the headline. Calibration, Brier
  and the verdict stay on formally-resolved bets only: a mark is a price, not an outcome.
- **A green CI check does not mean the LLM ran.** `claude --print` can exit 0 on a spend cap or
  overload. The workflow detects this and prefixes the email subject with
  `⚠️ AGENT DID NOT RUN`; the corroborating tell is a weekly commit that touched only
  `metrics.jsonl`, with no new `## Run` section in `lessons.md`. `run-local.sh --agent` applies
  the same check to a local run.

## CI

Schedules: Mondays 13:07 UTC, plus a 2nd-of-month catch-up that researches **only** if the last
real research run is more than 7 days old (self-heal for a month-end spend-cap null run).
Secrets: `AZURE_FOUNDRY_RESOURCE`, `AZURE_FOUNDRY_API_KEY` (Claude via Microsoft Foundry since
2026-07-20), `GMAIL_USERNAME`, `GMAIL_APP_PASSWORD`, `GMAIL_TO_ADDRESS`.

Manual trigger: the Actions "Run workflow" button, or `gh workflow run agent-trader-weekly.yml`.

Deployment validation (tests only, no research, bets, email or history writes):
`gh workflow run agent-trader-weekly.yml -f validation_only=true`.
