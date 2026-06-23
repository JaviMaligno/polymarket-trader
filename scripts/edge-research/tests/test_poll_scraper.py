from datetime import date
from io import StringIO
from pathlib import Path
import pandas as pd
import pytest
from poll_scraper import (
    parse_field_date, parse_share, normalize_poll_table, parse_html, PollRow,
    resolve_url, derive_margin,
)

FIX = Path(__file__).resolve().parent / "fixtures"


def _df(name):
    return pd.read_html(StringIO((FIX / name).read_text(encoding="utf-8")))[0]


# ---------- Task 1: scalar parsers ----------

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


# ---------- Task 2: normalizer ----------

def test_normalize_runoff_is_two_way_with_two_candidates():
    rows = normalize_poll_table(_df("peru_runoff.html"), "Peru/president/?", "u")
    assert rows
    assert all(r.is_two_way for r in rows)
    cands = {r.candidate for r in rows}
    assert len(cands) == 2
    assert not any("blank" in c.lower() or "undecided" in c.lower()
                   or "lead" in c.lower() for c in cands)
    dated = [r for r in rows if r.field_date is not None]
    assert dated and all(0 < r.share <= 100 for r in dated)


def test_normalize_firstround_excludes_stoplist_columns():
    rows = normalize_poll_table(_df("peru_firstround.html"), "Peru/president/?", "u")
    cands = {r.candidate for r in rows}
    assert len(cands) >= 8
    for bad in ("other", "blank", "none", "undecided", "lead"):
        assert not any(bad in c.lower() for c in cands)
    assert all(not r.is_two_way for r in rows)


def test_parse_html_returns_poll_tables():
    tables = parse_html((FIX / "peru_firstround.html").read_text(encoding="utf-8"))
    assert len(tables) >= 1


def test_normalize_us_format_poll_source_and_dates_administered():
    # US tables use "Poll source" + "Date(s) administered" (not Pollster/Date).
    rows = normalize_poll_table(_df("us_senate_poll.html"), "US/senate/illinois", "u")
    assert rows, "US table must yield rows"
    cands = {r.candidate for r in rows}
    assert "Robin Kelly" in cands and "Raja Krishnamoorthi" in cands
    # "Poll source", "Other", "Margin of error" must NOT be candidates
    assert not any("source" in c.lower() or "other" == c.lower()
                   or "margin" in c.lower() for c in cands)
    assert any(r.field_date is not None for r in rows)


# ---------- Task 3: URL resolver ----------

def test_resolve_us_senate_template():
    u = resolve_url("US/senate/texas", "2026-11-03", searcher=None)
    assert u == "https://en.wikipedia.org/wiki/2026_United_States_Senate_election_in_Texas"


def test_resolve_us_governor_template():
    u = resolve_url("US/governor/california", "2026-11-03", searcher=None)
    assert u == "https://en.wikipedia.org/wiki/2026_California_gubernatorial_election"


def test_resolve_foreign_national_template():
    u = resolve_url("Peru/president/?", "2026-04-12", searcher=None)
    assert u == "https://en.wikipedia.org/wiki/Opinion_polling_for_the_2026_Peruvian_general_election"


def test_resolve_foreign_parliamentary_template():
    u = resolve_url("Hungary/parliament/?", "2026-04-12", searcher=None)
    assert u == "https://en.wikipedia.org/wiki/Opinion_polling_for_the_2026_Hungarian_parliamentary_election"


def test_resolve_unmapped_uses_searcher_stub():
    called = {}

    def searcher(q):
        called["q"] = q
        return "http://found"
    u = resolve_url("US/house/KY-04", "2026-05-19", searcher=searcher)
    assert u == "http://found" and "KY-04" in called["q"]


def test_resolve_unmapped_no_searcher_is_none():
    assert resolve_url("US/house/KY-04", "2026-05-19", searcher=None) is None


# ---------- Task 4: margin deriver ----------

def _pr(cand, share, d, two=True):
    return PollRow("r", "p" + str(d), date(2026, 4, d), cand, share, 1000, two, "u")


def test_derive_margin_two_way_leader_and_gap():
    rows = [_pr("A", 52, 4), _pr("B", 48, 4), _pr("A", 51, 3), _pr("B", 49, 3)]
    m = derive_margin(rows)
    assert m["leader"] == "A"
    assert m["runner_up"] == "B"
    # A avg (52+51)/2=51.5, B avg 48.5 -> gap 3.0 pts = 0.03
    assert abs(m["margin"] - 0.03) < 1e-9
    assert m["is_two_way"] is True
    assert m["n_polls"] == 2


def test_derive_margin_empty_is_defined():
    m = derive_margin([])
    assert m["leader"] is None and m["n_polls"] == 0
