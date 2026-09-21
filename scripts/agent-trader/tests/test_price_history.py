#!/usr/bin/env python3
"""Tests for the price-history view attached to a market id.

Run 18 answered the mandatory open-position question "was the motivating news already
reflected in the price before entry?" for Bet 16 with: "the market opened Aug 21 at
0.415, peaked Aug 25 at 0.675, then declined to the trough of 0.270 on Sept 14, and
recovered to 0.400". Bet 16's market (Gamma 3128887) was created 2026-07-27 and its mark
that day was 0.095. 0.400 is the price of the SIBLING October-31 market, which the same
run declined two paragraphs later. The checklist answer was built on another market's
series, and nothing in the output it was quoting from could have revealed that.

The prompt already tells the agent to pull the series; it had to assemble the CLOB URL by
hand from clobTokenIds, and a hand-assembled identifier is exactly where a sibling market
substitutes itself. So the harness resolves the token from the market id and prints the
series under a header naming that id, its question and its creation date — which makes a
quote from the wrong market visible in the quote itself.

The fetch is a thin wrapper; what these tests pin is the rendering, because that is what
ends up in lessons.md.
"""
from __future__ import annotations
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent_trader import format_price_history  # noqa: E402

META = {"market_id": "3128887", "question": "US announces end of Iranian blockade?",
        "created_at": "2026-07-27T17:51:00Z"}

# (unix ts, YES price) — a rise, a peak, a fall.
SERIES = [
    (1785000000, 0.845), (1785600000, 0.60), (1786204800, 0.675),
    (1786809600, 0.27), (1787414400, 0.175), (1788019200, 0.095),
]


class HeaderTests(unittest.TestCase):
    def test_header_names_the_market_that_produced_the_series(self):
        out = format_price_history(META, SERIES)
        self.assertIn("3128887", out)
        self.assertIn("US announces end of Iranian blockade?", out)

    def test_header_states_the_creation_date(self):
        """'The market opened Aug 21' was checkable against this and was not checked."""
        self.assertIn("2026-07-27", format_price_history(META, SERIES))

    def test_first_point_is_reported_as_the_first_observed_price(self):
        out = format_price_history(META, SERIES)
        self.assertIn("0.845", out)


class SeriesTests(unittest.TestCase):
    def test_extremes_are_reported_with_their_dates(self):
        out = format_price_history(META, SERIES)
        self.assertIn("0.845", out)   # max
        self.assertIn("0.095", out)   # min, which is also the latest
        self.assertIn("max", out.lower())
        self.assertIn("min", out.lower())

    def test_latest_point_is_reported(self):
        self.assertIn("latest", format_price_history(META, SERIES).lower())

    def test_entry_date_is_marked_on_the_series(self):
        """The checklist question is about before-vs-after entry, so mark entry."""
        out = format_price_history(META, SERIES, entry_date="2026-09-07")
        self.assertIn("entry", out.lower())

    def test_an_empty_series_says_so_instead_of_rendering_nothing(self):
        out = format_price_history(META, [])
        self.assertIn("3128887", out)
        self.assertIn("no price history", out.lower())

    def test_a_single_point_does_not_claim_a_range(self):
        """One observation is a price, not a path. Don't render it as min-and-max."""
        out = format_price_history(META, [(1788019200, 0.095)])
        self.assertIn("0.095", out)
        self.assertIn("1 point", out)
        self.assertNotIn("min ", out.lower())

    def test_points_are_rendered_in_chronological_order(self):
        out = format_price_history(META, list(reversed(SERIES)))
        first_ts = out.index("0.845")
        last_ts = out.index("0.095")
        self.assertLess(first_ts, last_ts)


class TruncationTests(unittest.TestCase):
    """The window the CLOB returns depends on `fidelity`, and it is not the market's life.

    Market 3128887 was created 2026-07-27. At fidelity=60 the series starts 2026-08-21;
    at fidelity=1440 it starts 2026-07-28. Run 18 read a truncated window and reported
    "the market opened Aug 21", which is the window's left edge, not an opening. Any
    before-vs-after-entry claim drawn from a window that starts after the market was
    created is drawn from a series missing the period it is claiming about.
    """

    def test_a_series_starting_after_creation_is_flagged_as_truncated(self):
        out = format_price_history(META, SERIES[3:])   # starts well after created_at
        self.assertIn("truncated", out.lower())

    def test_the_flag_says_the_first_point_is_not_an_opening(self):
        out = format_price_history(META, SERIES[3:])
        self.assertIn("not the market's opening", out)

    def test_a_series_covering_creation_is_not_flagged(self):
        meta = dict(META, created_at="2026-07-27T17:51:00Z")
        early = [(1785000000, 0.845)] + SERIES  # 2026-07-25, before creation
        self.assertNotIn("truncated", format_price_history(meta, early).lower())

    def test_one_day_after_creation_is_not_truncation(self):
        """A daily series naturally starts the day after creation — not a gap."""
        meta = dict(META, created_at="2026-07-27T17:51:00Z")
        day_after = [(1785196800, 0.655)] + SERIES[1:]   # 2026-07-28
        self.assertNotIn("truncated", format_price_history(meta, day_after).lower())

    def test_a_week_after_creation_is_still_truncation(self):
        meta = dict(META, created_at="2026-07-27T17:51:00Z")
        later = [(1785801600, 0.655)] + SERIES[1:]       # 2026-08-04
        self.assertIn("truncated", format_price_history(meta, later).lower())

    def test_the_first_point_is_never_labelled_opened(self):
        """'opened at' is the phrasing that turned a window edge into a false fact."""
        self.assertNotIn("opened", format_price_history(META, SERIES).lower())


if __name__ == "__main__":
    unittest.main()
