import math
import numpy as np
import pytest
from poll_census import (
    Race, Coverage, parse_race, classify_coverage, run_census, fit_margin_to_winprob,
)


# ---------- Task 1: race parser ----------

def test_parse_us_house_seat():
    r = parse_race("Will Thomas Massie be the Republican nominee for KY-04?",
                   "2026-05-19 00:00:00+00", "2026-05-20 03:12:14+00")
    assert r.country == "US"
    assert r.office == "house"
    assert r.race_id == "US/house/KY-04"
    assert r.stage == "nominee"
    assert r.candidate == "thomas massie"


def test_parse_us_senate_state():
    r = parse_race("Will Juliana Stratton be the Democratic nominee for Senate in Illinois?",
                   "2026-03-17 00:00:00+00", "2026-04-20 00:00:00+00")
    assert r.country == "US"
    assert r.office == "senate"
    assert r.race_id == "US/senate/illinois"
    assert r.stage == "nominee"


def test_parse_us_governor_primary():
    r = parse_race("Will Tommy Tuberville win the 2026 Alabama Governor Republican primary election?",
                   "2026-05-19 00:00:00+00", "2026-05-20 04:32:15+00")
    assert r.country == "US"
    assert r.office == "governor"
    assert r.race_id == "US/governor/alabama"
    assert r.stage == "primary"


def test_parse_foreign_parliament():
    r = parse_race("Will Fidesz-KDNP win the national list vote in the 2026 Hungarian Parliamentary election by 0-3%?",
                   "2026-04-12 00:00:00+00", "2026-04-18 00:00:00+00")
    assert r.country == "Hungary"
    assert r.office == "parliament"
    assert r.stage in ("general", "other")


def test_parse_foreign_gubernatorial_is_non_us():
    r = parse_race("Will Yeom Tae-yeong win the 2026 Gyeonggi Province Gubernatorial Election?",
                   "2026-06-03 00:00:00+00", "2026-06-04 04:02:25+00")
    assert r.country == "South Korea"
    assert r.office == "governor"


def test_parse_placeholder_is_unknown():
    r = parse_race("Will Person A be the Democratic Nominee for NJ-12?",
                   "2026-06-01 00:00:00+00", "2026-06-02 00:00:00+00")
    assert r.candidate == "person a"
    assert r.country == "US" and r.office == "house"


# ---------- Task 2: coverage classifier ----------

def _race(country, office, race_id="x", stage="general"):
    return Race(race_id, country, office, stage, "cand", "2026-06-01")


def test_classifier_prior_us_senate_is_aggregator():
    assert classify_coverage(_race("US", "senate"), verifier=None).tier == "aggregator"


def test_classifier_prior_us_house_is_raw_polls():
    assert classify_coverage(_race("US", "house"), verifier=None).tier == "raw_polls"


def test_classifier_prior_foreign_minor_is_none():
    assert classify_coverage(_race("Bolivia", "governor"), verifier=None).tier == "none"


def test_classifier_prior_unknown_geo_is_unknown():
    assert classify_coverage(_race("unknown", "other"), verifier=None).tier == "unknown"


def test_classifier_verifier_overrides_prior():
    def verifier(race):
        return Coverage(race.race_id, "aggregator", "http://wiki/x")
    cov = classify_coverage(_race("US", "house"), verifier=verifier)
    assert cov.tier == "aggregator"
    assert cov.source_url == "http://wiki/x"


def test_classifier_verifier_exception_falls_back_to_prior():
    def verifier(race):
        raise RuntimeError("network down")
    cov = classify_coverage(_race("US", "senate"), verifier=verifier)
    assert cov.tier == "aggregator"
    assert cov.source_url is None


# ---------- Task 3: census runner ----------

def _row(q, rid):
    return {"market_id": rid, "event_id": "e" + rid, "market_type": "event_long",
            "question": q, "end_date": "2026-06-01 00:00:00+00",
            "resolved_at": "2026-06-02 00:00:00+00", "outcome_yes": "0"}


def test_run_census_counts_two_ns_and_tiers(tmp_path):
    rows = [
        _row("Will A win the 2026 Texas Senate election?", "1"),
        _row("Will B win the 2026 Texas Senate election?", "2"),
        _row("Will C be the Republican nominee for KY-04?", "3"),
        _row("Will D win the 2026 Cochabamba gubernatorial election?", "4"),
        _row("Will E post 40 posts this week?", "5"),
    ]
    covs, summary = run_census(rows, verifier=None, out_path=tmp_path / "c.csv")
    assert summary["candidate_markets_total"] == 5
    assert summary["races_total"] == 4
    assert summary["by_tier"]["aggregator"]["races"] == 1
    assert summary["by_tier"]["aggregator"]["candidate_markets"] == 2
    assert summary["by_tier"]["raw_polls"]["races"] == 1
    assert summary["by_tier"]["none"]["races"] == 1
    assert summary["by_tier"]["unknown"]["races"] == 1
    assert (tmp_path / "c.csv").exists()
    import csv as _csv
    written = list(_csv.DictReader((tmp_path / "c.csv").open(encoding="utf-8")))
    assert len(written) == 5
    assert set(written[0].keys()) >= {"market_id", "race_id", "country", "office",
                                      "stage", "tier", "source_url"}


def test_run_census_reachable_n_is_conservative_race_count(tmp_path):
    rows = [_row(f"Will Cand{i} win the 2026 Texas Senate election?", str(i))
            for i in range(5)]
    covs, summary = run_census(rows, verifier=None, out_path=tmp_path / "c.csv")
    assert summary["races_total"] == 1
    assert summary["candidate_markets_total"] == 5
    assert summary["reachable_n_conservative"] == summary["by_tier"]["aggregator"]["races"]


# ---------- Task 4: transform calibrator ----------

def test_fit_recovers_positive_slope_and_beats_base_brier():
    rng = np.random.default_rng(0)
    margins = rng.uniform(-0.30, 0.30, size=500)
    true_p = 1.0 / (1.0 + np.exp(-(0.0 + 12.0 * margins)))
    outcomes = (rng.uniform(size=500) < true_p).astype(float)
    res = fit_margin_to_winprob(margins, outcomes)
    assert res["b1"] > 0
    base = outcomes.mean()
    base_brier = float(np.mean((base - outcomes) ** 2))
    assert res["brier"] < base_brier
    assert 0.0 <= res["brier"] <= 0.25


def test_fit_validates_against_aggregator_winprob():
    rng = np.random.default_rng(1)
    margins = rng.uniform(-0.25, 0.25, size=400)
    true_p = 1.0 / (1.0 + np.exp(-(10.0 * margins)))
    outcomes = (rng.uniform(size=400) < true_p).astype(float)
    res = fit_margin_to_winprob(margins, outcomes, agg_winprob=true_p)
    assert res["agg_corr"] is not None and res["agg_corr"] > 0.9


def test_fit_degenerate_all_same_outcome_is_uninformative():
    margins = np.linspace(-0.2, 0.2, 50)
    outcomes = np.ones(50)
    res = fit_margin_to_winprob(margins, outcomes)
    assert res["status"] == "uninformative"
    assert not math.isnan(res["brier"])


# ---------- Task 5: loader ----------

def test_load_catalog_rows_reads_real_file_if_present():
    from poll_census import load_catalog_rows, CATALOG
    if not CATALOG.exists():
        pytest.skip("catalog CSV not on disk")
    rows = load_catalog_rows()
    assert len(rows) > 1000
    assert "question" in rows[0]
