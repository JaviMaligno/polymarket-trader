#!/usr/bin/env python3
"""H-INE-POLL Sub-project B-scraper — Wikipedia poll scraper.

Turns the census's pollable races into a tidy poll time series + per-race poll-implied
margin (feeding fit_margin_to_winprob in poll_census.py). Deterministic parsing
(pandas.read_html + lxml); network only in the live CLI (fetch_html).

Spec: docs/superpowers/specs/2026-06-23-h-ine-poll-scraper-design.md
Plan: docs/superpowers/plans/2026-06-23-h-ine-poll-scraper.md
"""
from __future__ import annotations
from collections import defaultdict
from dataclasses import dataclass
from datetime import date
from io import StringIO
from pathlib import Path
import csv
import re
import pandas as pd

HERE = Path(__file__).resolve().parent
CENSUS = HERE / "datasets" / "poll_supply_census.csv"
SERIES_OUT = HERE / "datasets" / "poll_series.csv"
MARGINS_OUT = HERE / "datasets" / "poll_margins.csv"

_MONTHS = {m: i for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july", "august",
     "september", "october", "november", "december"], 1)}
_MON_ABBR = {m[:3]: i for m, i in _MONTHS.items()}


# ---------- scalar parsers ----------

def parse_field_date(s) -> date | None:
    if not s:
        return None
    raw = str(s)
    t = re.sub(r"\[[^\]]*\]", "", raw).strip()
    t = re.split(r"\s*[–—-]\s*", t)[-1].strip()  # END of any range
    m = re.search(r"(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})", t) or \
        re.search(r"(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})", raw)
    if not m:
        return None
    day, mon, yr = int(m.group(1)), m.group(2).lower(), int(m.group(3))
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


# ---------- table normalizer ----------

@dataclass(frozen=True)
class PollRow:
    race_id: str
    pollster: str
    field_date: date | None
    candidate: str
    share: float
    sample_size: int | None
    is_two_way: bool
    source_url: str


# real stopwords (NOT "unnamed": every multi-index col carries an Unnamed level)
_STOPWORDS = re.compile(
    r"pollster|client|sample|margin of error|\bmoe\b|\blead\b|other|"
    r"blank|none|undecided|abstention|turnout|source", re.I)
_DATE_LVL = re.compile(r"^date$", re.I)
_POLLSTER = re.compile(r"pollster|client", re.I)
_SAMPLE = re.compile(r"sample", re.I)


def _levels(col):
    return [str(x) for x in (col if isinstance(col, tuple) else (col,))]


def _named_levels(col):
    return [l for l in _levels(col) if l and not l.lower().startswith("unnamed")]


def _candidate_label(col) -> str | None:
    named = _named_levels(col)
    if not named or any(_STOPWORDS.search(l) for l in named):
        return None
    if any(_DATE_LVL.search(l) for l in named):
        return None
    return named[0].strip()


def _has_role(col, rx) -> bool:
    return any(rx.search(l) for l in _named_levels(col))


def normalize_poll_table(df: pd.DataFrame, race_id: str, source_url: str) -> list[PollRow]:
    cols = list(df.columns)
    pollster_c = next((c for c in cols if _has_role(c, _POLLSTER)), None)
    date_c = next((c for c in cols if _has_role(c, _DATE_LVL)), None)
    sample_c = next((c for c in cols if _has_role(c, _SAMPLE)), None)
    cand_cols = [(c, lab) for c in cols if (lab := _candidate_label(c))]
    is_two_way = len(cand_cols) == 2

    out: list[PollRow] = []
    for _, row in df.iterrows():
        pollster = ""
        if pollster_c is not None:
            pollster = re.sub(r"\[[^\]]*\]", "", str(row[pollster_c])).strip()
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
            df = pd.read_html(StringIO(lh.tostring(tb, encoding="unicode")))[0]
            if df.shape[0] >= 3 and df.shape[1] >= 4:
                out.append(df)
        except Exception:
            continue
    return out


# ---------- URL resolver ----------

_ADJ = {"Peru": "Peruvian", "Hungary": "Hungarian", "Bulgaria": "Bulgarian",
        "Colombia": "Colombian", "Bangladesh": "Bangladeshi", "Cyprus": "Cypriot",
        "Armenia": "Armenian", "Bolivia": "Bolivian", "India": "Indian",
        "Australia": "Australian", "Canada": "Canadian", "Germany": "German",
        "France": "French", "South Korea": "South Korean"}
_WIKI = "https://en.wikipedia.org/wiki/"


def _title(region: str) -> str:
    return "_".join(w.capitalize() for w in region.replace("_", " ").split())


def resolve_url(race_id: str, resolution_date: str, searcher=None) -> str | None:
    parts = (race_id.split("/", 2) + ["", ""])[:3]
    country, office, region = parts
    year = (resolution_date or "2026")[:4]
    if country == "US" and office == "senate" and region not in ("", "?"):
        return f"{_WIKI}{year}_United_States_Senate_election_in_{_title(region)}"
    if country == "US" and office == "governor" and region not in ("", "?"):
        return f"{_WIKI}{year}_{_title(region)}_gubernatorial_election"
    if office in ("president", "parliament") and country in _ADJ:
        return f"{_WIKI}Opinion_polling_for_the_{year}_{_ADJ[country]}_general_election"
    if searcher is not None:
        return searcher(f"{year} {race_id} election opinion polling Wikipedia")
    return None


# ---------- margin deriver ----------

def derive_margin(poll_rows, ref_date=None, k: int = 5) -> dict:
    rows = [r for r in poll_rows if r.field_date is not None]
    if ref_date is not None:
        rows = [r for r in rows if r.field_date <= ref_date]
    if not rows:
        return {"race_id": None, "leader": None, "runner_up": None,
                "leader_share": None, "margin": None, "is_two_way": None, "n_polls": 0}
    race_id = rows[0].race_id
    is_two_way = all(r.is_two_way for r in rows)
    polls = sorted({(r.pollster, r.field_date) for r in rows},
                   key=lambda pr: pr[1], reverse=True)[:k]
    keep = set(polls)
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


# ---------- live CLI ----------

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
            seen.setdefault(r["race_id"], r)
    return list(seen.values())


def run_scrape(races, searcher=None, fetch=fetch_html):
    series, margins = [], []
    cov = {"resolved": 0, "parsed": 0, "failed": 0, "fails": []}
    for r in races:
        url = resolve_url(r["race_id"], r.get("resolution_date", ""), searcher=searcher)
        if not url:
            cov["fails"].append((r["race_id"], "no-url")); cov["failed"] += 1; continue
        cov["resolved"] += 1
        try:
            rows = []
            for df in parse_html(fetch(url)):
                rows += normalize_poll_table(df, r["race_id"], url)
            rows = [x for x in rows if x.field_date is not None]
            if not rows:
                cov["fails"].append((r["race_id"], "no-rows")); cov["failed"] += 1; continue
            series += rows
            margins.append(derive_margin(rows))
            cov["parsed"] += 1
        except Exception as e:  # noqa: BLE001 - one bad page must not kill the run
            cov["fails"].append((r["race_id"], type(e).__name__)); cov["failed"] += 1
    return series, margins, cov


if __name__ == "__main__":
    races = load_pollable_races()
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
        w.writeheader()
        w.writerows(margins)
    print(f"races={len(races)} resolved={cov['resolved']} parsed={cov['parsed']} "
          f"failed={cov['failed']}")
    print(f"poll rows={len(series)}  margins={len(margins)}")
    print("sample fails:", cov["fails"][:10])
