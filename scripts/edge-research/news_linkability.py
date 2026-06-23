#!/usr/bin/env python3
"""H-INE-3 Sub-project A — news->market linkability census.

Classifies priced/resolved-in-window markets by entity-domain, counts how many news
titles (in window) match each market's distinctive entities, and reports per-domain
supply (linkable / backtest-able / forward-able). Decides the domain + mode for the
H-INE-3 lag validator. Offline: reads local CSVs pulled from the VM.

Spec: docs/superpowers/specs/2026-06-23-h-ine-3-linkability-census-design.md
"""
from __future__ import annotations
from dataclasses import dataclass
from pathlib import Path
import csv
import re

HERE = Path(__file__).resolve().parent
MARKETS_CSV = HERE / "datasets" / "_markets_priced.csv"
NEWS_CSV = HERE / "datasets" / "_news_titles.csv"
CENSUS_OUT = HERE / "datasets" / "news_linkability_census.csv"


@dataclass(frozen=True)
class MarketEntity:
    domain: str          # commodity|macro_fed|geopolitical|crypto_price|sports|tech_release|other
    entities: tuple      # AND-set of lowercased terms a news title must all contain to match


# Each rule: (domain, trigger regex on the question, entities-builder).
# Ordered — first match wins. Geopolitical/crypto/tech before sports so "win" verbs
# in those domains aren't swallowed by the sports rule.
def _commodity(q):
    ql = q.lower()
    for key, ent in [("crude oil", "oil"), ("(cl)", "oil"), ("gold", "gold"),
                     ("(gc)", "gold"), ("silver", "silver"), ("(si)", "silver"),
                     ("s&p 500", "s&p"), ("spx", "s&p"), ("usd/jpy", "yen"),
                     ("nasdaq", "nasdaq"), ("dow", "dow")]:
        if key in ql:
            return (ent,)
    return None


def _macro(q):
    ql = q.lower()
    if "powell" in ql:
        return ("powell",)
    if re.search(r"\bfed\b|interest rate|rate cut|rate hike|rate cuts|rate hikes", ql):
        return ("fed",)
    if "recession" in ql:
        return ("recession",)
    if "inflation" in ql:
        return ("inflation",)
    if "gdp" in ql:
        return ("gdp",)
    return None


_GEO_COUNTRIES = ["iran", "ukraine", "russia", "israel", "gaza", "venezuela",
                  "north korea", "taiwan", "china"]
_GEO_EVENTS = ["ceasefire", "strike", "war", "invasion", "peace", "framework",
               "sovereignty", "meeting", "deal", "attack", "truce"]


def _geopolitical(q):
    ql = q.lower()
    country = next((c for c in _GEO_COUNTRIES if c in ql), None)
    event = next((e for e in _GEO_EVENTS if e in ql), None)
    if country and event:
        return (country, event)
    return None


def _crypto(q):
    ql = q.lower()
    if "bitcoin" in ql or re.search(r"\bbtc\b", ql):
        return ("bitcoin",)
    if "ethereum" in ql or re.search(r"\beth\b", ql):
        return ("ethereum",)
    return None


def _tech(q):
    ql = q.lower()
    for key, ent in [("gpt", "gpt"), ("claude", "claude"), ("gta vi", "gta"),
                     ("spacex", "spacex"), ("openai", "openai"), ("ipo", "ipo")]:
        if key in ql:
            return (ent,)
    return None


def _sports(q):
    ql = q.lower()
    if "world cup" in ql or "fifa" in ql:
        return ("world cup",)
    if re.search(r"\bwin on \d{4}-\d{2}-\d{2}|exact score|drivers' champion|"
                 r"\bf1\b|champions league|\bnba\b|\bnfl\b", ql):
        return ("sports",)
    return None


_RULES = [("commodity", _commodity), ("macro_fed", _macro),
          ("geopolitical", _geopolitical), ("crypto_price", _crypto),
          ("tech_release", _tech), ("sports", _sports)]


def classify_market(question: str) -> MarketEntity:
    for domain, fn in _RULES:
        ent = fn(question or "")
        if ent:
            return MarketEntity(domain, ent)
    return MarketEntity("other", ())


def count_news_matches(entities, news_titles) -> int:
    """AND-semantics: a title matches when it contains every term in `entities`."""
    if not entities:
        return 0
    terms = [e.lower() for e in entities]
    n = 0
    for t in news_titles:
        tl = t.lower()
        if all(term in tl for term in terms):
            n += 1
    return n


def _truthy(v) -> bool:
    return str(v).strip().lower() in ("t", "true", "1", "yes")


def run_census(markets_rows, news_titles, k: int = 3, out_path: Path | None = None):
    """markets_rows: dicts with id, market_type, is_resolved, end_date, has_price,
    question. news_titles: list[str]. Returns (records, summary)."""
    out_path = Path(out_path) if out_path is not None else CENSUS_OUT
    records = []
    for m in markets_rows:
        me = classify_market(m.get("question", ""))
        matches = count_news_matches(me.entities, news_titles)
        resolved = _truthy(m.get("is_resolved", ""))
        priced = _truthy(m.get("has_price", ""))
        records.append({
            "market_id": m.get("id", ""),
            "market_type": m.get("market_type", ""),
            "domain": me.domain,
            "entities": "|".join(me.entities),
            "n_news_matches": matches,
            "is_resolved": resolved,
            "has_price": priced,
            "end_date": m.get("end_date", ""),
            "linkable": matches >= k,
        })

    domains = ["commodity", "macro_fed", "geopolitical", "crypto_price",
               "sports", "tech_release", "other"]
    by_domain = {d: {"markets": 0, "linkable": 0, "backtest_n": 0, "forward_n": 0}
                 for d in domains}
    for r in records:
        b = by_domain[r["domain"]]
        b["markets"] += 1
        if r["linkable"]:
            b["linkable"] += 1
            if r["is_resolved"] and r["has_price"]:
                b["backtest_n"] += 1
            if (not r["is_resolved"]) and r["has_price"]:
                b["forward_n"] += 1

    summary = {"markets_total": len(records), "by_domain": by_domain,
               "linkable_total": sum(b["linkable"] for b in by_domain.values())}

    if out_path is not None and records:
        with out_path.open("w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=list(records[0].keys()))
            w.writeheader()
            w.writerows(records)
    return records, summary


def load_local_inputs(markets_path: Path | None = None, news_path: Path | None = None):
    markets_path = Path(markets_path) if markets_path is not None else MARKETS_CSV
    news_path = Path(news_path) if news_path is not None else NEWS_CSV
    markets = list(csv.DictReader(markets_path.open(encoding="utf-8")))
    titles = [r["title"] for r in csv.DictReader(news_path.open(encoding="utf-8"))]
    return markets, titles


def _print_summary(summary: dict) -> None:
    print(f"markets: {summary['markets_total']}  linkable: {summary['linkable_total']}")
    print(f"{'domain':14s} {'markets':>8s} {'linkable':>9s} {'backtest_n':>11s} {'forward_n':>10s}")
    for d, b in summary["by_domain"].items():
        print(f"{d:14s} {b['markets']:8d} {b['linkable']:9d} {b['backtest_n']:11d} {b['forward_n']:10d}")


if __name__ == "__main__":
    markets, titles = load_local_inputs()
    print(f"loaded {len(markets)} markets, {len(titles)} news titles")
    records, summary = run_census(markets, titles)
    _print_summary(summary)
    print(f"\nwrote {CENSUS_OUT}")
