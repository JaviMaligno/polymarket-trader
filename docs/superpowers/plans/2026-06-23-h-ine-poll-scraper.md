# H-INE-POLL B-scraper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** Wikipedia poll scraper turning the 95 pollable census races into tidy poll time series + per-race poll-implied margins, with an honest coverage log.

**Architecture:** One module `scripts/edge-research/poll_scraper.py` (URL resolver, html parser, table normalizer, margin deriver, CLI) + tests on saved HTML fixtures. Parsing is deterministic (pandas.read_html + lxml); network only in the live CLI.

**Tech Stack:** Python 3.13, requests, lxml, pandas, numpy, pytest. Fixtures: `tests/fixtures/peru_runoff.html` (two-way), `tests/fixtures/peru_firstround.html` (multi-candidate) — already saved.

**Key parsed structure (from fixtures):** multi-index columns; candidate name lives in header **level 1** ("Fujimori FP", "Sánchez JP"); levels 0/2 are "Unnamed: N_level_X". Pollster/Date/Sample/Margin of error/Blank/None/Undecided/Lead/Other are named in all levels. Data is clean UTF-8.

---

### Task 1: date + share scalar parsers

**Files:** Create `scripts/edge-research/poll_scraper.py`; Test `scripts/edge-research/tests/test_poll_scraper.py`.

- [ ] Write failing tests:

```python
import pytest
from poll_scraper import parse_field_date, parse_share

def test_parse_field_date_single():
    assert str(parse_field_date("6 June 2026")) == "2026-06-06"

def test_parse_field_date_endash_range_takes_end():
    assert str(parse_field_date("3–4 Apr 2026")) == "2026-04-04"

def test_parse_field_date_hyphen_range():
    assert str(parse_field_date("1-4 Apr 2026")) == "2026-04-04"

def test_parse_field_date_garbage_is_none():
    assert parse_field_date("n/a") is None

def test_parse_share_plain_and_percent_and_footnote():
    assert parse_share("44.1") == 44.1
    assert parse_share("16%") == 16.0
    assert parse_share("16.0[1]") == 16.0

def test_parse_share_dash_and_blank_is_none():
    assert parse_share("–") is None
    assert parse_share("") is None
    assert parse_share("nan") is None
```

- [ ] Run `python -m pytest tests/test_poll_scraper.py -k "field_date or share" -v` → FAIL (no module).
- [ ] Implement:

```python
from __future__ import annotations
from dataclasses import dataclass
from datetime import date
from io import StringIO
from pathlib import Path
import csv, re
import pandas as pd

HERE = Path(__file__).resolve().parent
CENSUS = HERE / "datasets" / "poll_supply_census.csv"
SERIES_OUT = HERE / "datasets" / "poll_series.csv"
MARGINS_OUT = HERE / "datasets" / "poll_margins.csv"

_MONTHS = {m: i for i, m in enumerate(
    ["january","february","march","april","may","june","july","august",
     "september","october","november","december"], 1)}
_MON_ABBR = {m[:3]: i for m, i in _MONTHS.items()}


def parse_field_date(s: str) -> date | None:
    if not s:
        return None
    t = re.sub(r"\[[^\]]*\]", "", str(s)).strip()
    # take the END of any range (split on en-dash/em-dash/hyphen between day numbers)
    t = re.split(r"\s*[–—-]\s*", t)[-1].strip()
    # t like "4 Apr 2026" or "6 June 2026"; if the end token lost the month/year,
    # fall back to scanning the whole original string for month + year.
    m = re.search(r"(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})", t) or \
        re.search(r"(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})", str(s))
    if not m:
        return None
    day = int(m.group(1)); mon = m.group(2).lower(); yr = int(m.group(3))
    month = _MONTHS.get(mon) or _MON_ABBR.get(mon[:3])
    if not month:
        return None
    try:
        return date(yr, month, day)
    except ValueError:
        return None


def parse_share(s) -> float | None:
    if s is None:
        return None
    t = re.sub(r"\[[^\]]*\]", "", str(s)).replace("%", "").strip()
    if t in ("", "–", "—", "-", "nan", "NaN", "�"):
        return None
    try:
        return float(t)
    except ValueError:
        return None
```

- [ ] Run the two -k filters → PASS. Commit.

---

### Task 2: column classification + table normalizer

**Files:** Modify `poll_scraper.py`; Test appended.

- [ ] Write failing tests (use the saved fixtures):

```python
from pathlib import Path
from poll_scraper import normalize_poll_table, parse_html, PollRow
import pandas as pd
from io import StringIO

FIX = Path(__file__).resolve().parent / "fixtures"

def _df(name):
    return pd.read_html(StringIO((FIX / name).read_text(encoding="utf-8")))[0]

def test_normalize_runoff_is_two_way_with_two_candidates():
    rows = normalize_poll_table(_df("peru_runoff.html"), "Peru/president/?", "u")
    assert rows, "expected poll rows"
    assert all(r.is_two_way for r in rows)
    cands = {r.candidate for r in rows}
    # exactly two candidate labels, excluding stoplist columns
    assert len(cands) == 2
    assert not any("blank" in c.lower() or "undecided" in c.lower() or
                   "lead" in c.lower() for c in cands)
    r0 = [r for r in rows if r.field_date is not None][0]
    assert 0 < r0.share <= 100

def test_normalize_firstround_excludes_stoplist_columns():
    rows = normalize_poll_table(_df("peru_firstround.html"), "Peru/president/?", "u")
    cands = {r.candidate for r in rows}
    assert len(cands) >= 8           # many candidates
    for bad in ("other", "blank", "none", "undecided", "lead"):
        assert not any(bad in c.lower() for c in cands)
    assert all(not r.is_two_way for r in rows)

def test_parse_html_returns_poll_tables():
    tables = parse_html((FIX / "peru_firstround.html").read_text(encoding="utf-8"))
    assert len(tables) >= 1
```

- [ ] Run `-k normalize or parse_html` → FAIL.
- [ ] Implement:

```python
@dataclass(frozen=True)
class PollRow:
    race_id: str
    pollster: str
    field_date: "date | None"
    candidate: str
    share: float
    sample_size: "int | None"
    is_two_way: bool
    source_url: str

_STOP = re.compile(
    r"pollster|client|^date$|sample|margin of error|\bmoe\b|\blead\b|other|"
    r"blank|none|undecided|abstention|turnout|unnamed|source", re.I)
_ROLE = re.compile(r"pollster|client|^date$|sample|margin of error|\bmoe\b", re.I)


def _levels(col):
    return [str(x) for x in (col if isinstance(col, tuple) else (col,))]


def _candidate_label(col) -> str | None:
    """A candidate column: some level is a real name, none is a stoplist/role word."""
    levels = _levels(col)
    if any(_STOP.search(l) for l in levels):
        return None
    named = [l for l in levels if l and not l.startswith("Unnamed")]
    return named[0].strip() if named else None


def _role_of(col, role_rx):
    return any(role_rx.search(l) for l in _levels(col))


def normalize_poll_table(df: pd.DataFrame, race_id: str, source_url: str) -> list[PollRow]:
    cols = list(df.columns)
    pollster_c = next((c for c in cols if _role_of(c, re.compile(r"pollster|client", re.I))), None)
    date_c = next((c for c in cols if _role_of(c, re.compile(r"^.*\bdate\b.*$", re.I))
                   and not _role_of(c, re.compile(r"updated", re.I))), None)
    sample_c = next((c for c in cols if _role_of(c, re.compile(r"sample", re.I))), None)
    cand_cols = [(c, _candidate_label(c)) for c in cols]
    cand_cols = [(c, lab) for c, lab in cand_cols if lab]
    is_two_way = len(cand_cols) == 2

    out: list[PollRow] = []
    for _, row in df.iterrows():
        pollster = str(row[pollster_c]) if pollster_c is not None else ""
        pollster = re.sub(r"\[[^\]]*\]", "", pollster).strip()
        fdate = parse_field_date(row[date_c]) if date_c is not None else None
        ssize = None
        if sample_c is not None:
            sv = parse_share(row[sample_c])
            ssize = int(sv) if sv is not None else None
        for c, lab in cand_cols:
            share = parse_share(row[c])
            if share is None:
                continue
            out.append(PollRow(race_id, pollster, fdate, lab, share, ssize,
                               is_two_way, source_url))
    return out


def parse_html(html: str) -> list[pd.DataFrame]:
    from lxml import html as lh
    doc = lh.fromstring(html)
    tabs = doc.xpath('//table[contains(@class,"wikitable")]') or [doc]
    out = []
    for tb in tabs:
        try:
            frag = lh.tostring(tb, encoding="unicode")
            df = pd.read_html(StringIO(frag))[0]
            if df.shape[0] >= 3 and df.shape[1] >= 4:
                out.append(df)
        except Exception:
            continue
    return out
```

- [ ] Run → PASS. Commit.

---

### Task 3: URL resolver

**Files:** Modify `poll_scraper.py`; Test appended.

- [ ] Write failing tests:

```python
from poll_scraper import resolve_url

def test_resolve_us_senate_template():
    u = resolve_url("US/senate/texas", "2026-11-03", searcher=None)
    assert u == "https://en.wikipedia.org/wiki/2026_United_States_Senate_election_in_Texas"

def test_resolve_us_governor_template():
    u = resolve_url("US/governor/california", "2026-11-03", searcher=None)
    assert u == "https://en.wikipedia.org/wiki/2026_California_gubernatorial_election"

def test_resolve_foreign_national_template():
    u = resolve_url("Peru/president/?", "2026-04-12", searcher=None)
    assert u == "https://en.wikipedia.org/wiki/Opinion_polling_for_the_2026_Peruvian_general_election"

def test_resolve_unmapped_uses_searcher_stub():
    called = {}
    def searcher(q):
        called["q"] = q
        return "http://found"
    u = resolve_url("US/house/KY-04", "2026-05-19", searcher=searcher)
    assert u == "http://found" and "KY-04" in called["q"]

def test_resolve_unmapped_no_searcher_is_none():
    assert resolve_url("US/house/KY-04", "2026-05-19", searcher=None) is None
```

- [ ] Run → FAIL.
- [ ] Implement:

```python
_ADJ = {"Peru": "Peruvian", "Hungary": "Hungarian", "Bulgaria": "Bulgarian",
        "Colombia": "Colombian", "Bangladesh": "Bangladeshi", "Cyprus": "Cypriot",
        "Armenia": "Armenian", "Bolivia": "Bolivian", "India": "Indian",
        "UK": "United Kingdom", "Australia": "Australian", "Canada": "Canadian",
        "Germany": "German", "France": "French", "South Korea": "South Korean"}
_WIKI = "https://en.wikipedia.org/wiki/"


def _title(region: str) -> str:
    return "_".join(w.capitalize() for w in region.replace("_", " ").split())


def resolve_url(race_id: str, resolution_date: str,
                searcher=None) -> str | None:
    country, office, region = (race_id.split("/", 2) + ["", ""])[:3]
    year = (resolution_date or "2026")[:4]
    if country == "US" and office == "senate" and region not in ("", "?"):
        return f"{_WIKI}{year}_United_States_Senate_election_in_{_title(region)}"
    if country == "US" and office == "governor" and region not in ("", "?"):
        return f"{_WIKI}{year}_{_title(region)}_gubernatorial_election"
    if office in ("president", "parliament") and country in _ADJ:
        return f"{_WIKI}Opinion_polling_for_the_{year}_{_ADJ[country]}_general_election"
    if searcher is not None:
        q = f"{year} {race_id} election opinion polling Wikipedia"
        return searcher(q)
    return None
```

- [ ] Run → PASS. Commit.

---

### Task 4: margin deriver

**Files:** Modify `poll_scraper.py`; Test appended.

- [ ] Write failing tests:

```python
from datetime import date
from poll_scraper import derive_margin, PollRow

def _pr(cand, share, d, two=True):
    return PollRow("r", "p", date(2026, 4, d), cand, share, 1000, two, "u")

def test_derive_margin_two_way_leader_and_gap():
    rows = [_pr("A", 52, 4), _pr("B", 48, 4), _pr("A", 51, 3), _pr("B", 49, 3)]
    m = derive_margin(rows)
    assert m["leader"] == "A"
    assert m["runner_up"] == "B"
    assert abs(m["margin"] - 0.04) < 1e-9   # (51.5-47.5..)->fraction; leader-runner avg gap
    assert m["is_two_way"] is True
    assert m["n_polls"] == 2

def test_derive_margin_empty_is_defined():
    m = derive_margin([])
    assert m["leader"] is None and m["n_polls"] == 0
```

- [ ] Run → FAIL.
- [ ] Implement:

```python
from collections import defaultdict


def derive_margin(poll_rows, ref_date=None, k: int = 5) -> dict:
    rows = [r for r in poll_rows if r.field_date is not None]
    if ref_date is not None:
        rows = [r for r in rows if r.field_date <= ref_date]
    if not rows:
        return {"race_id": None, "leader": None, "runner_up": None,
                "leader_share": None, "margin": None, "is_two_way": None,
                "n_polls": 0}
    race_id = rows[0].race_id
    is_two_way = all(r.is_two_way for r in rows)
    # group polls by (pollster, field_date) to count distinct polls; take most recent k
    polls = sorted({(r.pollster, r.field_date) for r in rows},
                   key=lambda pd_: pd_[1], reverse=True)[:k]
    keep = {(r.pollster, r.field_date) for r in rows} & set(polls)
    recent = [r for r in rows if (r.pollster, r.field_date) in keep]
    agg = defaultdict(list)
    for r in recent:
        agg[r.candidate].append(r.share)
    means = {c: sum(v) / len(v) for c, v in agg.items()}
    ranked = sorted(means.items(), key=lambda kv: kv[1], reverse=True)
    leader, leader_share = ranked[0]
    runner_up, runner_share = ranked[1] if len(ranked) > 1 else (None, 0.0)
    return {"race_id": race_id, "leader": leader, "runner_up": runner_up,
            "leader_share": leader_share / 100.0,
            "margin": (leader_share - runner_share) / 100.0,
            "is_two_way": is_two_way, "n_polls": len(polls)}
```

- [ ] Run → PASS. Commit.

---

### Task 5: CLI + coverage log (run inline, not unit-tested)

**Files:** Modify `poll_scraper.py`.

- [ ] Implement loader + CLI:

```python
def fetch_html(url: str) -> str:
    import requests
    r = requests.get(url, headers={"User-Agent": "Mozilla/5.0 (research)"}, timeout=30)
    r.encoding = "utf-8"
    return r.text


def load_pollable_races(path: Path | None = None):
    path = Path(path) if path is not None else CENSUS
    seen = {}
    for r in csv.DictReader(path.open(encoding="utf-8")):
        if r["tier"] in ("aggregator", "raw_polls"):
            seen.setdefault(r["race_id"], r)   # one per race
    return list(seen.values())


def run_scrape(races, searcher=None, fetch=fetch_html):
    series, margins, cov = [], [], {"resolved": 0, "parsed": 0, "failed": 0, "fails": []}
    for r in races:
        url = resolve_url(r["race_id"], r.get("resolution_date", ""), searcher=searcher)
        if not url:
            cov["fails"].append((r["race_id"], "no-url")); cov["failed"] += 1; continue
        cov["resolved"] += 1
        try:
            tables = parse_html(fetch(url))
            rows = []
            for df in tables:
                rows += normalize_poll_table(df, r["race_id"], url)
            rows = [x for x in rows if x.field_date is not None]
            if not rows:
                cov["fails"].append((r["race_id"], "no-rows")); cov["failed"] += 1; continue
            series += rows
            margins.append(derive_margin(rows))
            cov["parsed"] += 1
        except Exception as e:
            cov["fails"].append((r["race_id"], type(e).__name__)); cov["failed"] += 1
    return series, margins, cov


if __name__ == "__main__":
    from poll_scraper import resolve_url as _r  # noqa
    races = load_pollable_races()
    # live searcher wired by the controller at run time; default None (template-only)
    series, margins, cov = run_scrape(races, searcher=None)
    with SERIES_OUT.open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["race_id", "pollster", "field_date", "candidate", "share",
                    "sample_size", "is_two_way", "source_url"])
        for x in series:
            w.writerow([x.race_id, x.pollster, x.field_date, x.candidate, x.share,
                        x.sample_size, x.is_two_way, x.source_url])
    with MARGINS_OUT.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["race_id", "leader", "runner_up",
                           "leader_share", "margin", "is_two_way", "n_polls"])
        w.writeheader(); w.writerows(margins)
    print(f"races={len(races)} resolved={cov['resolved']} parsed={cov['parsed']} "
          f"failed={cov['failed']}")
    print(f"poll rows={len(series)}  margins={len(margins)}")
    print("sample fails:", cov["fails"][:10])
```

- [ ] Run full suite `python -m pytest tests/test_poll_scraper.py -v` → ALL PASS. Commit.

---

### Task 6: live scrape + coverage report (controller, not unit-tested)

- [ ] Run `python poll_scraper.py` with a live WebSearch-backed searcher for template misses.
- [ ] Record the real coverage (resolved/parsed/failed, poll-row count, races with two-way margins) into memory `project_h_ine_program_2026-06-23`. This is the REAL reachable n after the data layer — it may shrink the 95 further. Decide B1 feasibility on it.

---

## Notes
- `python` not `python3`. Run from `scripts/edge-research/`.
- `datasets/*.csv` gitignored; commit only `poll_scraper.py`, the test, and `tests/fixtures/*.html`.
- Margin test tolerance: leader avg 51.5 vs runner 48.5 over 2 polls → gap 3.0 pts = 0.03; adjust the asserted value to the actual averaged gap when implementing (recompute from the fixture-free synthetic rows).
