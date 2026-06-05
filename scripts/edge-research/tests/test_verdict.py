import json
from verdict import Verdict

def test_verdict_json_roundtrip():
    v = Verdict(
        hypothesis_id="H-CAL-1", hclass="calibration", n=1015,
        edge_net_pct=0.0224, edge_insample_pct=0.0240, significance=3.49,
        split="full", class_metric={"brier": 0.21}, cost_model="entry_only_0.005",
        status="pass", n_caveats=["panel 96% event_long"], computed_at="2026-06-05T00:00:00Z",
    )
    s = v.to_json()
    v2 = Verdict.from_json(s)
    assert v2 == v
    assert json.loads(s)["hypothesis_id"] == "H-CAL-1"

def test_verdict_handles_nulls():
    v = Verdict(hypothesis_id="X", hclass="calibration", n=0,
        edge_net_pct=None, edge_insample_pct=None, significance=None,
        split="full", class_metric={}, cost_model="n/a",
        status="inconclusive", n_caveats=[], computed_at="t")
    assert Verdict.from_json(v.to_json()) == v
