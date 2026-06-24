# H-INE-POLL Sub-project B-scraper — Wikipedia poll scraper

**Date:** 2026-06-23
**Program:** H-INE-* informational edge. Parent memory: `project_h_ine_program_2026-06-23`.
**Status:** design approved, ready for plan.
**Depends on:** Sub-project A census (`poll_census.py`, `datasets/poll_supply_census.csv`).

## Why

Census A returned NO-GO on a 200-independent-race backtest (95 pollable races / structural
ceiling 125) but confirmed fuel exists. User chose "1 y 2": build BOTH the validator-now
(B1, on 95 resolved races) and the forward collector (B2, on Nov-2026 generals). Both need
ONE shared dependency — a scraper that turns a race into a poll time series. This sub-project
is that scraper.

Feasibility probed 2026-06-23: `pandas.read_html` + lxml parses Wikipedia poll tables cleanly
(Peru page: 13 wikitables, 7 poll-shaped parse with dated fieldwork, sample sizes, candidate
shares; the runoff table is a clean two-way head-to-head). No LLM extraction needed. Mojibake
in pollster names is cosmetic (fixed by explicit UTF-8); numbers parse fine.

## Goal

Produce, for each pollable race, a tidy poll time series and a derived poll-implied
margin/win-prob at a reference time, plus an honest coverage log (which of the 95 races we
actually got data for — the real reachable n after the data layer).

## Architecture — `scripts/edge-research/poll_scraper.py`

Pure-Python, harness conventions, offline-testable. Network only in the live-run CLI and in
`fetch_tables` (which is thin and not unit-tested); all parsing logic is unit-tested against
saved HTML fixtures.

### Components

1. **URL resolver** — `resolve_url(race_id, resolution_date, searcher=None) -> str | None`.
   Template-first per (country, office):
   - `US/senate/<state>` → `https://en.wikipedia.org/wiki/2026_United_States_Senate_election_in_<State>`
   - `US/governor/<state>` → `.../2026_<State>_gubernatorial_election`
   - `<country>/president|parliament` → `.../Opinion_polling_for_the_2026_<Adj>_general_election`
     using a country→adjective map (Peru→Peruvian, Hungary→Hungarian, …).
   Year is taken from `resolution_date`. On a template miss or unmapped geography, fall back to
   the injected `searcher(query) -> url|None` (WebSearch adapter at run time; stub in tests).
   US House districts are out of scope for templates (logged as unresolved).

2. **Table fetcher** — `fetch_html(url) -> str` (requests, `encoding='utf-8'`, browser UA) and
   `parse_html(html) -> list[DataFrame]` (lxml extracts `table.wikitable`, `pandas.read_html`
   per table inside a `try/except` so one malformed table is skipped, not fatal). `fetch_html`
   is network and not unit-tested; `parse_html` is tested on a saved fixture.

3. **Poll-table normalizer** (the core, fully unit-tested) —
   `normalize_poll_table(df, race_id, source_url) -> list[PollRow]`.
   - Flatten multi-index headers to single lowercased strings.
   - Classify columns: `pollster` (header has "pollster"/"client"), `date` (header == "date"),
     `sample` (header has "sample"), NON-candidate stoplist
     (`margin of error|moe|lead|other|blank|none|undecided|abstention|turnout|unnamed|source`),
     and everything else numeric → candidate columns (header = candidate name).
   - Parse field date: `parse_field_date("6 June 2026")`, ranges `"3–4 Apr 2026"`/`"1–4 Apr 2026"`
     (en-dash or hyphen) → the range END date. Unparseable → row dropped (logged).
   - Parse share: strip footnotes `[n]`, `%`, whitespace; `"44.1"`→44.1; mojibake/`"–"`/empty → skip cell.
   - Emit one `PollRow(race_id, pollster, field_date, candidate, share, sample_size,
     is_two_way, source_url)` per (poll, candidate). `is_two_way` = exactly 2 candidate columns
     in the table (runoff / head-to-head general).

4. **Margin deriver** — `derive_margin(poll_rows, ref_date=None) -> dict`.
   Per race: keep polls on/before `ref_date` (default: all), average each candidate's share
   across the most recent `k` polls (default k=5), rank, return
   `{race_id, leader, runner_up, leader_share, margin, is_two_way, n_polls}`. Margin is in
   share fraction (e.g. 0.04 for 4 points). Feeds `fit_margin_to_winprob` from `poll_census.py`.

5. **CLI** — load census pollable races (tier ∈ {aggregator, raw_polls}), resolve+fetch+
   normalize each, write `datasets/poll_series.csv` (tidy PollRows) + `datasets/poll_margins.csv`
   (per race) + a printed coverage log: races_resolved / parsed / failed and the candidate-market
   count actually covered. No silent caps — log every unresolved/failed race.

### Data flow

```
poll_supply_census.csv (95 pollable races)
   │ resolve_url (+searcher fallback)
   ▼  fetch_html → parse_html → normalize_poll_table
poll_series.csv (tidy)  ──derive_margin──►  poll_margins.csv  ──► (B1 validator / B2 forward)
   │
   └── coverage log: real reachable n after the data layer
```

## Error handling

- A table that fails `read_html` is skipped and logged, never fatal.
- A race whose URL won't resolve or whose page has no poll table is recorded in the coverage
  log with reason; the run continues. The coverage log is the honest reachable-n after data.
- Encoding forced to UTF-8 on fetch; cells with replacement chars are skipped per-cell.

## Testing (TDD, no live network)

- `parse_field_date`: single date, en-dash range, hyphen range, cross-month range, garbage→None.
- `parse_share`: plain, percent sign, footnote, mojibake→None, blank→None.
- `normalize_poll_table` on a **saved Peru runoff fixture** (two-way) → expect `is_two_way=True`,
  2 candidates/poll, correct shares & dates; and on a **saved first-round fixture** (multi-cand)
  → `is_two_way=False`, candidate cols exclude the stoplist columns.
- `resolve_url`: US senate/governor templates exact; foreign national template via adjective map;
  unmapped geography calls the stub searcher; US house → None (unresolved).
- `derive_margin`: synthetic poll rows → correct leader/margin; two-way flag propagated; k-window
  averaging; empty input → defined empty result.
- `parse_html`: on the saved Peru fixture → returns ≥5 poll-shaped DataFrames.

## Out of scope (later sub-projects)

- B1 PollValidator (race-clustered bootstrap) + Polymarket price backfill.
- B2 forward collector scheduling.
- Perfect parsing of all 95 races — build the pipeline, run it, report real coverage.

## Success criteria

- `poll_series.csv` + `poll_margins.csv` written for the resolvable races; a coverage log stating
  the real reachable n (races + candidate-markets) after the data layer.
- All unit tests green on saved fixtures (no live-network test).
- At least the high-value races (US Senate/Gov + Peru/Hungary/Bulgaria nationals) produce clean
  two-way or multi-candidate margins feeding `fit_margin_to_winprob`.
