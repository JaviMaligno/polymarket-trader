# H-INE-3 Sub-project A — News→market linkability census

**Date:** 2026-06-23
**Program:** H-INE-* informational edge. Parent memory: `project_h_ine_program_2026-06-23`.
**Status:** design approved, ready for plan.

## Why

H-INE-3 hypothesis: a news event drops, the logically-relevant market is slow to reprice;
enter in the news direction, capture the lag, hold, cost-aware verdict on the edge-research
harness. The binding constraint — confirmed by the prior failure of `news_sentiment` (broad,
low-precision, generalised poorly) — is **news→market semantic linkage**. So, as with the poll
route: **measure linkability first**, choose the linkage method and domain from data, build the
lag validator only on a domain with confirmed supply.

Probed 2026-06-23: `price_history` is 4-second granularity (excellent for intraday lag),
~120 markets priced in 7d (types event_financial/long/short, NOT crypto). `news_articles` =
93,089 rows, google_rss, fresh, categories sports/business/technology/world, **0 market
linkage**. Eyeballing the priced markets shows a clearly linkable subset: commodity/index/fx
thresholds (Oil/Gold/Silver/SPX/USD-JPY), macro/Fed (rate cuts, recession, Powell), and —
the most promising lag domain — **geopolitical binary events** (US-Iran / Russia-Ukraine
ceasefire), where a headline IS the resolving information and human interpretation can lag.
Commodity markets track a liquid spot (efficient, little lag expected); geopolitical binaries
are the lever.

## Goal

A data-backed go/no-go: per entity-domain, how many markets are (a) linkable to news (≥k
title matches in window), (b) resolved-in-window with price history (backtest-able), (c)
active with price history (forward-able). Decide which domain + mode (backtest vs forward)
the lag validator should target.

## Decisions locked in brainstorming

- **Linkage strategy:** measure linkability first (not pre-committing narrow-clean vs LLM).
- **Domain priority:** geopolitical-binary is the a-priori best lag candidate; commodities are
  the efficient control. Let the census confirm supply per domain.
- **Mode:** H-INE-3 is uniquely testable **forward NOW** (active markets, 4s prices, live news,
  events resolving within weeks) — a differentiator vs the poll route. Census reports both
  backtest and forward supply.

## Architecture

A self-contained module `scripts/edge-research/news_linkability.py` (harness conventions,
offline-testable). DB pulls are done once into local CSVs by a thin loader; the census logic
runs offline on those CSVs and on saved fixtures in tests.

### Components

1. **Market entity classifier** — `classify_market(question) -> MarketEntity` →
   `(domain, entities)` where `domain ∈ {commodity, macro_fed, geopolitical, crypto_price,
   sports, tech_release, other}` and `entities` is the lowercased term list to match against
   news (e.g. "Will Crude Oil (CL) hit $100…" → (commodity, ["crude oil","oil","cl"]);
   "US x Iran ceasefire…" → (geopolitical, ["iran","ceasefire"])). Rule-based with per-domain
   keyword/entity dictionaries; unmatched → (other, []).

2. **News-side matcher** — `count_news_matches(entities, news_titles) -> int`. Counts news
   titles (in the window) containing ALL of a required-entity subset (AND match on the
   distinctive entity, e.g. "iran" AND "ceasefire"; or the asset name). A market is *linkable*
   when matches ≥ k (default k=3).

3. **Census report** — per domain: `markets_total`, `linkable` (≥k matches),
   `resolved_in_window_priced` (backtest n), `active_priced` (forward n). Writes
   `datasets/news_linkability_census.csv` (one row per market: market_id, domain, entities,
   n_news_matches, is_resolved, has_price, end_date) + a printed summary. No silent drops —
   `other`/unlinkable counted explicitly.

4. **Data loader** — `pull_inputs(database_url)` runs three queries (priced markets +
   questions; resolved-in-window markets; news titles in window) → local CSVs
   `datasets/_markets_priced.csv`, `datasets/_news_titles.csv`. Network-only; the census reads
   the CSVs. (Mirrors the poll census's offline-CSV pattern.)

### Data flow

```
VM: markets + price_history + news_articles
   │ pull_inputs (3 queries -> local CSVs)
   ▼  classify_market           count_news_matches
markets_priced.csv ───────────► per-market (domain, entities, n_matches)
news_titles.csv ──────────────►        │
                                        ▼
                          news_linkability_census.csv  ──► GO/NO-GO per domain + mode
```

## Error handling

- A market the classifier can't place → `domain=other`, counted, never dropped.
- The loader is resumable: if the local CSVs exist, the census runs without re-querying the VM
  (the VM is fragile — minimise round-trips).

## Testing (TDD, no live network)

- `classify_market`: table of known questions → expected (domain, entities): commodity (Oil,
  Gold, Silver, SPX, USD/JPY), macro_fed (rate cut, recession, Powell), geopolitical (Iran/
  Ukraine ceasefire), crypto_price (Bitcoin ATH), sports (World Cup winner), tech_release
  (GPT-6), and a novelty row ("Jesus Christ return before GTA VI") → other.
- `count_news_matches`: entities present in N of M titles → N; AND-semantics (one entity term
  present but not the required co-term → no match); case-insensitive.
- `run_census` on a small fixture (markets + titles) → expected per-domain counts and a written
  CSV with the right schema; `other`/unlinkable counted.

## Out of scope (Sub-project B, gated on this)

- The lag validator (link news→market, news timestamp, post-news price-move window, enter/hold,
  event-clustered cost-aware OOS) and its registry/run.py wiring.
- The forward collector (capture news→price-move on active markets going forward).
- Any LLM-based linkage (only considered if the rule-based census shows narrow-clean lacks
  supply in the geopolitical/commodity domains).

## Success criteria

- `news_linkability_census.csv` classifies every priced/resolved-in-window market (no silent
  drops; `other` counted), with per-market n_news_matches.
- A printed per-domain table of linkable / backtest-n / forward-n that supports an explicit
  domain+mode choice for Sub-project B (or a NO-GO if no domain has linkable supply).
- All unit tests green on fixtures.
