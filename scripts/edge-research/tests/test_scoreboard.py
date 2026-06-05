from verdict import Verdict
from scoreboard import render_markdown

def _v(hid, edge, status):
    return Verdict(hid, "calibration", 1000, edge, edge, 3.0, "full",
                   {}, "entry_only_0.005", status, [], "t")

def test_scoreboard_sorts_by_edge_desc_and_lists_blocked():
    verdicts = [_v("A", 0.01, "pass"), _v("B", 0.03, "pass"), _v("C", None, "fail")]
    blocked = [{"id": "H-MM-1", "name": "Spread capture"}]
    md = render_markdown(verdicts, blocked)
    # B (0.03) appears before A (0.01)
    assert md.index("B") < md.index("A")
    # blocked hypotheses are listed, never silently dropped
    assert "H-MM-1" in md and "blocked" in md.lower()
