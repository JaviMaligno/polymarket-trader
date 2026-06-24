from news_linkability import (
    classify_market, count_news_matches, run_census, MarketEntity,
)


# ---------- classifier ----------

def test_classify_commodity_oil():
    me = classify_market("Will Crude Oil (CL) hit (HIGH) $100 by end of June?")
    assert me.domain == "commodity"
    assert "oil" in me.entities


def test_classify_commodity_gold_silver():
    assert classify_market("Will Gold (GC) hit $6,000 by end of December?").domain == "commodity"
    assert classify_market("Will Silver (SI) settle over $60 in June?").domain == "commodity"


def test_classify_macro_fed_and_powell():
    assert classify_market("Will 3 Fed rate cuts happen in 2026?").domain == "macro_fed"
    assert classify_market("Jerome Powell out from Fed Board by May 30?").entities == ("powell",)
    assert classify_market("US recession by end of 2026?").entities == ("recession",)


def test_classify_geopolitical_requires_country_and_event():
    me = classify_market("US x Iran ceasefire before Oil hits $120?")
    assert me.domain == "geopolitical"
    assert "iran" in me.entities and "ceasefire" in me.entities


def test_classify_crypto_price():
    assert classify_market("Bitcoin all time high by June 30, 2026?").domain == "crypto_price"


def test_classify_sports_world_cup():
    assert classify_market("Will Argentina win the 2026 FIFA World Cup?").domain == "sports"


def test_classify_tech_release():
    assert classify_market("Will GPT-6 be released by September 30, 2026?").domain == "tech_release"


def test_classify_novelty_is_other():
    assert classify_market("Will Jesus Christ return before GTA VI?").domain == "tech_release"  # GTA matches tech
    assert classify_market("New Rihanna Album before something?").domain == "other"


# ---------- news matcher ----------

def test_count_news_matches_and_semantics():
    titles = ["Iran and US agree ceasefire deal", "Oil prices surge on Iran tension",
              "Ceasefire talks collapse in Gaza"]
    # geopolitical iran+ceasefire requires BOTH -> only the first title
    assert count_news_matches(("iran", "ceasefire"), titles) == 1
    # single entity 'oil' -> one title
    assert count_news_matches(("oil",), titles) == 1


def test_count_news_matches_empty_entities_is_zero():
    assert count_news_matches((), ["anything"]) == 0


# ---------- census ----------

def _m(mid, q, resolved="f", priced="t"):
    return {"id": mid, "market_type": "event_long", "is_resolved": resolved,
            "end_date": "2026-06-30", "has_price": priced, "question": q}


def test_run_census_counts_domains_and_modes(tmp_path):
    markets = [
        _m("1", "US x Iran ceasefire by June 30?", resolved="f", priced="t"),   # geo forward
        _m("2", "Russia Ukraine ceasefire framework?", resolved="t", priced="t"),  # geo backtest
        _m("3", "Will Crude Oil (CL) hit $100?", resolved="f", priced="t"),     # commodity forward
        _m("4", "New Rihanna Album?", resolved="f", priced="t"),               # other
    ]
    titles = ["Iran ceasefire signed", "Iran ceasefire holds", "Iran ceasefire talks",
              "Ukraine ceasefire framework agreed", "Ukraine ceasefire framework signed",
              "Ukraine ceasefire framework holds", "Oil hits new high", "Oil supply cut",
              "Oil demand falls"]
    records, summary = run_census(markets, titles, k=3, out_path=tmp_path / "c.csv")
    assert summary["markets_total"] == 4
    geo = summary["by_domain"]["geopolitical"]
    assert geo["markets"] == 2 and geo["linkable"] == 2
    assert geo["forward_n"] == 1 and geo["backtest_n"] == 1
    com = summary["by_domain"]["commodity"]
    assert com["linkable"] == 1 and com["forward_n"] == 1
    assert summary["by_domain"]["other"]["markets"] == 1
    assert (tmp_path / "c.csv").exists()


def test_run_census_below_k_not_linkable(tmp_path):
    markets = [_m("1", "US x Iran ceasefire?", priced="t")]
    titles = ["Iran ceasefire signed"]  # only 1 match, k=3
    records, summary = run_census(markets, titles, k=3, out_path=tmp_path / "c.csv")
    assert summary["by_domain"]["geopolitical"]["linkable"] == 0
