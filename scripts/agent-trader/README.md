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
./run-local.sh --dry    # evaluate + summary only; appends nothing, writes nothing
./run-local.sh --agent  # the full weekly loop, including the LLM research run
```

The script never commits or pushes — inspect `git diff` and commit yourself. Use `--dry` when
poking at state, so a debugging session doesn't append a bogus row to `metrics.jsonl`.

Individual commands, if you prefer them raw:

| Command | What it does | Network | Writes |
|---|---|---|---|
| `python agent_trader.py evaluate` | Re-fetch open bets: book the formally resolved ones, snapshot the rest as `mark_yes_price` | yes | `bets.jsonl` |
| `python agent_trader.py summary` | Record, P&L, bankroll, Brier, mark-to-market | no | — |
| `python metrics.py` | Calibration, by-confidence, cost-aware bootstrap verdict | no | — |
| `python agent_trader.py metrics <YYYY-MM-DD>` | Same, and appends the dated row to `metrics.jsonl` | no | `metrics.jsonl` |
| `python agent_trader.py candidates --research` | Liquid, ≤45d, spread ≤3%, non-sports candidate markets | yes | — |
| `python agent_trader.py email_html out.html` | Render the weekly email | no | `out.html` |

`evaluate` is deterministic and safe to run any day. The cron only evaluates weekly, so a bet
that resolves mid-week sits `open` until the next Monday unless you run it yourself.

## Placing a bet by hand

```bash
# Write the rationale to a file FIRST, then:
python agent_trader.py record <MARKET_ID> <YES|NO> <p_hat_yes> rationale.txt 25.0 medium
```

**Never pass the rationale as a shell argument.** It was inlined in a double-quoted string until
2026-08-03, and bash expanded `$4`, `$1`, `$7`, `$6` to empty positional parameters — every
dollar figure in four bets' rationales silently lost its leading digit (`$4.7M` → `.7M`). The
`record` subcommand reads the file verbatim; the corrupted rows are left in place because the log
is append-only, and are documented in `lessons.md`.

## Files

| File | Role |
|---|---|
| `bets.jsonl` | Append-only track record — the source of truth |
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
