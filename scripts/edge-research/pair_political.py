#!/usr/bin/env python3
"""Pair political conditional chains: A (primary/nominee/advance) -> B (general win).

Reads the resolved political catalog and emits conditional_pairs.csv with columns
pair_id, market_id_a, market_id_b, relation, candidate, race.

Pairing rule (a real conditional chain):
  - A market: candidate wins a NOMINATION / PRIMARY / advances from a primary.
  - B market: the SAME candidate wins the GENERAL for the SAME race.
  - Different event_id (negRisk guard) and A.resolved_at < B.resolved_at (real lag).

Determinacy / relation:
  - implies_no : A resolved NO  => B must be NO (lost primary => general NO). The
    rich, fully-determinate political case. Signal: B should reprice to 0.
  - implies_yes: A resolved YES => B becomes possible but NOT determinate (won the
    nomination, general still open). Kept as a weaker informational chain; the
    validator can split on relation.
"""
import csv
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / "datasets" / "conditional_catalog_political.csv"
OUT = HERE / "datasets" / "conditional_pairs.csv"

A_PATTERNS = [
    re.compile(r"\bbe the .*?nominee for\b", re.I),
    re.compile(r"\bwin the .*?primary\b", re.I),
    re.compile(r"\badvance from the .*?primary\b", re.I),
    re.compile(r"\bbe the .*?nominee\b", re.I),
]
# B = a general-election WIN for a candidate, never a primary/nominee/advance market.
B_NEG = re.compile(r"\b(primary|nominee|advance|turnout|posts?|by [0-9])", re.I)
B_POS = re.compile(
    r"\bwin the .*?(election|governorship|gubernatorial|senate|seat|race|presiden|mayor)",
    re.I,
)

# Race normalisers: seat code (XX-NN) or "<place> <office>".
SEAT = re.compile(r"\b([A-Z]{2}-\d+)\b")
OFFICE = re.compile(
    r"\b(governor|gubernatorial|senate|senator|president|mayor|house|congress)\b", re.I
)


def candidate(q: str):
    """Extract the candidate proper-noun phrase right after 'Will '."""
    m = re.match(r"\s*Will\s+(.+?)\s+(?:be|win|advance)\b", q, re.I)
    if not m:
        return None
    name = m.group(1).strip()
    # reject party/option rows (contain parentheses acronyms or 'the ')
    if name.lower().startswith("the "):
        return None
    return name.lower()


def race_key(q: str):
    """A coarse race identifier shared by an A and its B (seat code or place+office)."""
    seat = SEAT.search(q)
    if seat:
        return seat.group(1).upper()
    # year + place tokens before the office word
    off = OFFICE.search(q)
    if not off:
        return None
    # grab the words around the office: e.g. "2026 Alabama Governor"
    region = re.search(
        r"\b(20\d\d)?\s*([A-Z][\w.'-]+(?:\s+[A-Z][\w.'-]+){0,3})\s+"
        r"(?:Governor|Gubernatorial|Senate|Senator|President|Mayor|House)",
        q,
    )
    if region:
        return region.group(2).strip().lower()
    return off.group(1).lower()


def classify(q: str):
    if any(p.search(q) for p in A_PATTERNS):
        return "A"
    if B_POS.search(q) and not B_NEG.search(q):
        return "B"
    return None


def main():
    rows = list(csv.DictReader(SRC.open(encoding="utf-8")))
    A, B = [], []
    for r in rows:
        q = r["question"]
        cls = classify(q)
        if cls is None:
            continue
        cand = candidate(q)
        rk = race_key(q)
        if not cand or not rk:
            continue
        rec = dict(r, candidate=cand, race=rk)
        (A if cls == "A" else B).append(rec)

    print(f"A markets (clean cand+race): {len(A)}", file=sys.stderr)
    print(f"B markets (clean cand+race): {len(B)}", file=sys.stderr)

    # index B by (candidate, race)
    bidx = {}
    for b in B:
        bidx.setdefault((b["candidate"], b["race"]), []).append(b)

    pairs = []
    pid = 0
    for a in A:
        for b in bidx.get((a["candidate"], a["race"]), []):
            if a["event_id"] == b["event_id"]:
                continue  # negRisk guard
            if not (a["resolved_at"] and b["resolved_at"]):
                continue
            if a["resolved_at"] >= b["resolved_at"]:
                continue  # need A before B
            relation = "implies_no" if a["outcome_yes"] == "0" else "implies_yes"
            pid += 1
            pairs.append(
                {
                    "pair_id": f"pol-{pid}",
                    "market_id_a": a["market_id"],
                    "market_id_b": b["market_id"],
                    "relation": relation,
                    "candidate": a["candidate"],
                    "race": a["race"],
                }
            )

    print(f"PAIRS FOUND: {len(pairs)}", file=sys.stderr)
    with OUT.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(
            fh,
            fieldnames=[
                "pair_id",
                "market_id_a",
                "market_id_b",
                "relation",
                "candidate",
                "race",
            ],
        )
        w.writeheader()
        w.writerows(pairs)
    for p in pairs[:25]:
        print(p, file=sys.stderr)


if __name__ == "__main__":
    main()
