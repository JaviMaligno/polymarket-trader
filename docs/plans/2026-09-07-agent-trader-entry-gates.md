# Agent-Trader entry gates implementation plan

**Goal:** Enforce concentration, structured evidence and an independent critical review before recording paper bets.

**Architecture:** Capture open exposure before evaluation in a per-run state file. A guarded JSON proposal entry point validates evidence and current market data, invokes a fresh read-only Claude reviewer, rechecks the executable quote, and stores the evidence and verdict with the bet. Both runners initialize and audit the run; legacy prose-only recording is rejected.

**Tech Stack:** Python standard library, requests, unittest, existing Claude CLI and Bash runners.

**Risks:** Semantic truth and grouping still need model judgment; these are application controls, not a sandbox against malicious filesystem edits. Provider failures must reject entries. Historical bets and entry probabilities must remain unchanged. No paid live model calls or paper trades during implementation tests.

### Task 1: Entry gates and regression tests
- Create `scripts/agent-trader/entry_gate.py` and `tests/test_entry_gate.py`.
- Test same-run resolution/replacement, same-event exposure, unknown legacy groups, next-run release, malformed/missing evidence, weighted probabilities, reviewer veto/error, stale quote and successful audited append.
- Run `python -m unittest discover -s scripts/agent-trader/tests -p test_entry_gate.py -v`; observe missing behavior, implement and rerun.

### Task 2: Integrate recording and runners
- Modify `agent_trader.py`, `run-local.sh`, `.github/workflows/agent-trader-weekly.yml`.
- Replace prose-only recording with guarded proposals; initialize before evaluate, preserve run state across repeated evaluate calls, audit before reporting and persistence.
- Tests must prove the legacy entry point cannot append and runner ordering protects resolved exposure.

### Task 3: Research and reviewer contracts
- Modify `agent-trader-prompt.md`, `README.md`; create `critical-review-prompt.md` and `proposal.example.json`.
- Document exact evidence schema, source verification, mixed electoral systems, counterarguments, price history, risk groups and fail-closed review.
- Verify CLI flags using installed `claude --help`, run all Agent-Trader tests, Python compilation and Bash syntax checks. Review final diff; leave changes uncommitted.
