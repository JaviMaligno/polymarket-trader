#!/usr/bin/env bash
# Run the Agent-Trader weekly loop on a local machine.
#
# The GitHub Actions workflow (.github/workflows/agent-trader-weekly.yml) is the
# authoritative runner — this script exists for reproducing a run by hand: recovering a
# missed week, debugging a bet, or re-rendering the email. It deliberately does NOT
# commit or push anything; inspect `git diff` and commit yourself if you want to keep it.
#
#   ./run-local.sh              # deterministic only: evaluate -> summary -> metrics -> email
#   ./run-local.sh --agent      # also run the LLM research loop (needs a model provider)
#   ./run-local.sh --dry        # evaluate + summary, no metrics row, no email file
#
# Deterministic mode needs no API key — only network access to gamma-api.polymarket.com.
set -uo pipefail
cd "$(dirname "$0")"

AGENT=0; DRY=0
for a in "$@"; do
  case "$a" in
    --agent) AGENT=1 ;;
    --dry)   DRY=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown flag: $a (try --help)"; exit 2 ;;
  esac
done

PY=${PYTHON:-python3}
"$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' || {
  echo "Need Python >= 3.10 (got $("$PY" -V 2>&1)). Set PYTHON=/path/to/python3.12"; exit 1; }
"$PY" -c 'import requests' 2>/dev/null || {
  echo "Missing deps. Run:  $PY -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt"
  exit 1; }

echo "=== 1. Evaluate open bets (resolve + mark to market) ==="
# Deterministic: re-fetches every open bet from Gamma, books the ones Polymarket has
# formally resolved, and snapshots the rest as `mark_yes_price`. Safe to run any day —
# a mid-week resolution shows up here instead of waiting for Monday's cron.
"$PY" agent_trader.py evaluate || echo "warn: evaluate failed (network?) — continuing"

if [ "$AGENT" = "1" ]; then
  echo
  echo "=== 2. LLM research loop ==="
  command -v claude >/dev/null || {
    echo "The 'claude' CLI is not on PATH. Install: npm install -g @anthropic-ai/claude-code"; exit 1; }
  # CI authenticates to Claude via Microsoft Foundry (the first-party Anthropic key was
  # revoked 2026-07-20). Locally, your normal `claude` login works — don't set the
  # FOUNDRY vars unless you want to mirror CI exactly.
  echo "Provider: ${CLAUDE_CODE_USE_FOUNDRY:+Foundry}${CLAUDE_CODE_USE_FOUNDRY:-local claude login}"
  AGENT_OK=1
  cat agent-trader-prompt.md | claude \
    --model "${AGENT_MODEL:-claude-sonnet-4-6}" \
    --print \
    --permission-mode acceptEdits \
    --allowedTools "Bash WebSearch WebFetch Read Write Edit" \
    2>&1 | tee /tmp/agent-run-local.log || AGENT_OK=0
  # `claude --print` can exit 0 on an API error (spend cap, overload), so check the log
  # content too — the same silent-null-run trap the workflow guards against.
  if [ "$AGENT_OK" = "0" ] || grep -qiE "API Error|usage limit|rate limit|Execute error|Overloaded|Not logged in" /tmp/agent-run-local.log; then
    echo
    echo "!! The LLM run did NOT complete — this produced no research."
    echo "!! See /tmp/agent-run-local.log. Do not treat the output below as a real run."
  fi
fi

echo
echo "=== 3. Record ==="
"$PY" agent_trader.py summary

if [ "$DRY" = "1" ]; then
  echo; echo "(--dry: no metrics row appended, no email rendered)"
  exit 0
fi

echo
echo "=== 4. Metrics ==="
# Appends one row to metrics.jsonl — the trajectory. Skip it with --dry when you are
# just poking at state, so a debugging session doesn't pollute the run history.
"$PY" agent_trader.py metrics "$(date -u +%Y-%m-%d)"

echo
echo "=== 5. Email preview ==="
"$PY" agent_trader.py email_html /tmp/agent-trader-email.html && \
  echo "Open it: file:///tmp/agent-trader-email.html"

echo
echo "Track-record changes (not committed):"
git -C ../.. status --short -- scripts/agent-trader/ || true
