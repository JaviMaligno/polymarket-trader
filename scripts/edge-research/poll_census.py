#!/usr/bin/env python3
"""H-INE-POLL Sub-project A — poll-supply census + margin->win-prob calibrator.

Self-contained (no DB). Reads the on-disk political catalog, classifies every race by
poll-coverage tier (aggregator / raw_polls / none / unknown), reports two n's (distinct
races = conservative independent count; candidate-markets = optimistic raw count), and
— gated on enough dual-coverage — fits/validates a logistic margin->win-prob transform.

Spec: docs/superpowers/specs/2026-06-23-h-ine-poll-census-design.md
Plan: docs/superpowers/plans/2026-06-23-h-ine-poll-census.md
"""
from __future__ import annotations
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional
import csv
import json
import re
import numpy as np

HERE = Path(__file__).resolve().parent
CATALOG = HERE / "datasets" / "conditional_catalog_political.csv"
CENSUS_OUT = HERE / "datasets" / "poll_supply_census.csv"
PARAMS_OUT = HERE / "datasets" / "poll_transform_params.json"


@dataclass(frozen=True)
class Race:
    race_id: str
    country: str
    office: str  # senate|governor|house|president|parliament|mayor|other
    stage: str  # primary|nominee|advance|general|other
    candidate: str
    resolution_date: str


@dataclass(frozen=True)
class Coverage:
    race_id: str
    tier: str  # aggregator|raw_polls|none|unknown
    source_url: str | None


# Country keyword -> canonical name. Order matters (first hit wins).
_COUNTRY = [
    ("hungarian", "Hungary"), ("bulgarian", "Bulgaria"), ("peruvian", "Peru"),
    ("colombian", "Colombia"), ("bangladesh", "Bangladesh"), ("tamil nadu", "India"),
    ("kerala", "India"), ("assam", "India"), ("bolivia", "Bolivia"),
    ("cochabamba", "Bolivia"), ("la paz", "Bolivia"), ("santa cruz", "Bolivia"),
    ("gyeonggi", "South Korea"), ("chungcheong", "South Korea"),
    ("gangwon", "South Korea"), ("province", "South Korea"),
    ("cyprus", "Cyprus"), ("armenian", "Armenia"), ("scottish", "UK"),
    ("marseille", "France"), ("australian", "Australia"), ("farrer", "Australia"),
]

_OFFICE = [
    (re.compile(r"\bsenate\b|\bsenator\b", re.I), "senate"),
    (re.compile(r"\bgovernor\b|gubernatorial", re.I), "governor"),
    (re.compile(r"\bpresident", re.I), "president"),
    (re.compile(r"\bmayor\b", re.I), "mayor"),
    (re.compile(r"\bparliament|national list|legislative assembly|chamber of", re.I), "parliament"),
    (re.compile(r"\bhouse\b|\bcongress\b", re.I), "house"),
]

_SEAT = re.compile(r"\b([A-Z]{2}-\d+)\b")
_US_STATES = {
    "alabama", "alaska", "arizona", "arkansas", "california", "colorado",
    "connecticut", "delaware", "florida", "georgia", "hawaii", "idaho",
    "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine",
    "maryland", "massachusetts", "michigan", "minnesota", "mississippi",
    "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey",
    "new mexico", "new york", "north carolina", "north dakota", "ohio",
    "oklahoma", "oregon", "pennsylvania", "rhode island", "south carolina",
    "south dakota", "tennessee", "texas", "utah", "vermont", "virginia",
    "washington", "west virginia", "wisconsin", "wyoming",
}

# countries whose national elections have English-language Wikipedia poll tables
_RAW_POLL_COUNTRIES = {"UK", "Australia", "Canada", "Germany", "France", "India"}


def _candidate(q: str) -> str:
    m = re.match(r"\s*Will\s+(.+?)\s+(?:be|win|advance|finish)\b", q, re.I)
    return m.group(1).strip().lower() if m else ""


def _stage(q: str) -> str:
    ql = q.lower()
    if "advance from" in ql:
        return "advance"
    if "nominee" in ql:
        return "nominee"
    if "primary" in ql:
        return "primary"
    if re.search(r"win the .*(election|seat|governorship|senate|race)", ql):
        return "general"
    return "other"


def _us_state_in(q: str) -> str | None:
    ql = q.lower()
    for st in _US_STATES:
        if re.search(r"\b" + re.escape(st) + r"\b", ql):
            return st
    return None


def _slug_region(q: str, office: str) -> str | None:
    m = re.search(
        r"\b(20\d\d\s+)?([A-Z][\w.'-]+(?:\s+[A-Z][\w.'-]+){0,3})\s+"
        r"(?:Governor|Gubernatorial|Senate|President|Mayor|Parliament|Legislative)",
        q,
    )
    return m.group(2).strip().lower() if m else None


def parse_race(question: str, end_date: str, resolved_at: str) -> Race:
    cand = _candidate(question)
    stage = _stage(question)
    office = next((name for rx, name in _OFFICE if rx.search(question)), "other")

    seat = _SEAT.search(question)
    country = next((c for kw, c in _COUNTRY if kw in question.lower()), None)
    state = _us_state_in(question)

    if seat:
        return Race(f"US/house/{seat.group(1).upper()}", "US", "house", stage, cand, resolved_at)
    if country is None and state is not None:
        country = "US"
    if country is None:
        country = "US" if re.search(r"\bU\.?S\.?\b|United States", question) else "unknown"

    region = state if (country == "US" and state) else _slug_region(question, office)
    race_id = f"{country}/{office}/{region}" if region else f"{country}/{office}/?"
    return Race(race_id, country, office, stage, cand, resolved_at)


def _prior_tier(race: Race) -> str:
    if race.country == "unknown" or race.office == "other":
        return "unknown"
    if race.country == "US":
        if race.office in ("senate", "governor", "president"):
            return "aggregator"  # 2026 US Senate/Gov: Silver/Economist forecasts
        if race.office == "house":
            return "raw_polls"  # district polling on Wikipedia, no win-prob agg
        return "raw_polls"
    if race.country in _RAW_POLL_COUNTRIES and race.office in (
        "parliament", "president", "house", "senate",
    ):
        return "raw_polls"
    return "none"  # foreign minor (provincial/state, niche)


def classify_coverage(
    race: Race, verifier: "Optional[Callable[[Race], Optional[Coverage]]]" = None
) -> Coverage:
    prior = _prior_tier(race)
    if verifier is not None:
        try:
            got = verifier(race)
            if got is not None:
                return got
        except Exception:
            pass  # verifier failure -> fall back to prior, never crash the census
    return Coverage(race.race_id, prior, None)


def run_census(rows, verifier=None, out_path: Path | None = None):
    """rows: iterable of catalog dicts. Returns (list[per-market record], summary)."""
    out_path = Path(out_path) if out_path is not None else CENSUS_OUT
    records = []
    for r in rows:
        race = parse_race(r["question"], r.get("end_date", ""), r.get("resolved_at", ""))
        cov = classify_coverage(race, verifier=verifier)
        records.append({
            "market_id": r.get("market_id", ""),
            "race_id": race.race_id,
            "country": race.country,
            "office": race.office,
            "stage": race.stage,
            "candidate": race.candidate,
            "resolution_date": race.resolution_date,
            "tier": cov.tier,
            "source_url": cov.source_url or "",
        })

    tiers = ("aggregator", "raw_polls", "none", "unknown")
    by_tier = {t: {"races": 0, "candidate_markets": 0} for t in tiers}
    seen_races_by_tier = {t: set() for t in tiers}
    for rec in records:
        t = rec["tier"]
        by_tier[t]["candidate_markets"] += 1
        if rec["race_id"] not in seen_races_by_tier[t]:
            seen_races_by_tier[t].add(rec["race_id"])
            by_tier[t]["races"] += 1

    summary = {
        "candidate_markets_total": len(records),
        "races_total": len({rec["race_id"] for rec in records}),
        "by_tier": by_tier,
        "reachable_n_conservative":
            by_tier["aggregator"]["races"] + by_tier["raw_polls"]["races"],
        "reachable_n_optimistic":
            by_tier["aggregator"]["candidate_markets"] + by_tier["raw_polls"]["candidate_markets"],
    }

    if out_path is not None:
        fields = list(records[0].keys()) if records else [
            "market_id", "race_id", "country", "office", "stage",
            "candidate", "resolution_date", "tier", "source_url",
        ]
        with out_path.open("w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=fields)
            w.writeheader()
            w.writerows(records)
    return records, summary


def _sigmoid(z):
    return 1.0 / (1.0 + np.exp(-np.clip(z, -30, 30)))


def _corr(p, agg_winprob):
    if agg_winprob is None:
        return None
    a = np.asarray(agg_winprob, dtype=float)
    p = np.asarray(p, dtype=float)
    if a.size != p.size or a.size < 2 or np.std(a) == 0 or np.std(p) == 0:
        return None
    return float(np.corrcoef(p, a)[0, 1])


def fit_margin_to_winprob(margin, outcome, agg_winprob=None, iters: int = 50):
    """Hand-rolled IRLS logistic: P(win) = sigmoid(b0 + b1*margin).

    Returns dict with b0, b1, brier, agg_corr, n, status. Degenerate input
    (all-same outcome) returns status='uninformative' with a defined Brier.
    """
    x = np.asarray(margin, dtype=float)
    y = np.asarray(outcome, dtype=float)
    n = x.size
    base = float(y.mean()) if n else float("nan")

    if n == 0 or len(np.unique(y)) < 2:
        p = np.full(n, base if n else 0.5)
        brier = float(np.mean((p - y) ** 2)) if n else float("nan")
        return {"b0": float(np.log(base / (1 - base))) if 0 < base < 1 else 0.0,
                "b1": 0.0, "brier": brier, "agg_corr": _corr(p, agg_winprob),
                "n": n, "status": "uninformative"}

    X = np.column_stack([np.ones(n), x])
    beta = np.zeros(2)
    for _ in range(iters):
        p = _sigmoid(X @ beta)
        W = np.clip(p * (1 - p), 1e-6, None)
        XtWX = X.T @ (X * W[:, None])
        grad = X.T @ (y - p)
        try:
            step = np.linalg.solve(XtWX, grad)
        except np.linalg.LinAlgError:
            break
        beta = beta + step
        if np.max(np.abs(step)) < 1e-8:
            break

    p = _sigmoid(X @ beta)
    brier = float(np.mean((p - y) ** 2))
    return {"b0": float(beta[0]), "b1": float(beta[1]), "brier": brier,
            "agg_corr": _corr(p, agg_winprob), "n": n, "status": "ok"}


def load_catalog_rows(path: Path | None = None) -> list[dict]:
    path = Path(path) if path is not None else CATALOG
    with path.open(encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def _print_summary(summary: dict) -> None:
    print(f"candidate-markets: {summary['candidate_markets_total']}  "
          f"races: {summary['races_total']}")
    print(f"reachable n  conservative(races): {summary['reachable_n_conservative']}  "
          f"optimistic(markets): {summary['reachable_n_optimistic']}")
    print("by tier:")
    for t, c in summary["by_tier"].items():
        print(f"  {t:11s} races={c['races']:4d}  candidate-markets={c['candidate_markets']:4d}")
    floor = 200
    verdict = "GO" if summary["reachable_n_conservative"] >= floor else "NO-GO"
    print(f"\nGO/NO-GO (floor {floor} races): {verdict}")


if __name__ == "__main__":
    rows = load_catalog_rows()
    records, summary = run_census(rows, verifier=None)
    _print_summary(summary)
    print(f"\nwrote {CENSUS_OUT}")
