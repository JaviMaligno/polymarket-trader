# November research observation window

The operator agreed on 2026-11-02 to observe four weeks of the Monday/Thursday
research cadence before deciding whether to change candidate selection or the entry
bar. The window is **2026-11-02 inclusive to 2026-11-30 exclusive**. The next operator
review is due **2026-11-30**. No threshold, sizing, model or candidate filter changes
automatically: the conservative executable, fee-adjusted entry bar remains **5%**.

Run `python decision_audit.py report` to see one row per research run. Separate
same-day runs remain separate; rerunning a snapshot of the same frozen run replaces
that row. GitHub run ID/attempt links the row to its transcript. Rehearsals and
deterministic local reporting do not add published research rows. A real local
`--agent` research run is labeled `local` and is distinguishable from the cron.

Track searches, successful fetches, candidates and sources reported, proposal
attempts, independent reviews and accepted bets. `ok_fetches` counts successful calls,
not independent sources or proof of careful reading. Candidate/source coverage and
criterion reads are explicitly self-reported through `coverage`; compare them with
the transcript and decision receipts. Revisited candidates are deduplicated by market
ID, including resumed passes. Missing coverage/decisions produces an incomplete
audit warning, including in the weekly email subject, rather than a healthy zero-bet claim.

`research_runs.jsonl` includes an archived baseline for Runs 23-27. Counts were
recomputed from the redacted GitHub transcript artifacts and retain their SHA-256
and run URL. Their identities are explicitly derived from the GitHub run, because
the original private state UUID was not archived. Candidate/source/proposal/review
counts unavailable in those artifacts remain **unknown**, not zero. Zero new bets
is independently verifiable in `bets.jsonl` (the latest placement is 2026-10-05).

At the next review, inspect whether additional primary-source research increases
defensible proposals and identify where the funnel stops: coverage, evidence,
uncertainty, numerical edge, independent review, or accepted entry. A small sample
or zero proposals is not evidence that lowering the threshold will help.
