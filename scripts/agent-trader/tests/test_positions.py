#!/usr/bin/env python3
"""Tests for the open-positions view (frames made explicit).

Regression target: bet 7 is a NO position, and `lessons.md` quotes it in the YES frame in
two different runs — Run 11 "current YES=0.595" and Run 12 "mark YES=0.325". Read as that
position's entry and mark, they imply a 0.27 move; the position's real move is +0.055
(entry(held) 0.620 -> mark(held) 0.675). The old email table invited exactly that: an
unlabelled "Entry" column (held frame, 0.62 on a NO) sat next to "Mark (YES)". These
tests pin the frames, in the ASCII table and in the email.

0.595 is not in BET 7's record — it was an observed YES price written into lessons.md
prose, never stored on the bet. (0.595 does appear elsewhere in bets.jsonl, as bet 12's
`market_yes_price`, which is why the regression case renders bet 7 alone.)

No network, no reads of the real bets.jsonl — fixtures are inline on purpose: the point
of the regression case is that 0.595 was underivable from bet 7's row, so that row must
be what the test builds, not whatever the live file happens to hold.
"""
from __future__ import annotations
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent_trader import open_positions, format_positions, email_html  # noqa: E402


def _bet(**kw):
    base = {
        "bet_id": "bX", "question": "Q?", "end_date": "2026-09-01T12:00:00Z",
        "side": "YES", "stake": 25.0, "market_yes_price": 0.5, "entry_price": 0.51,
        "mark_yes_price": 0.5, "marked_at": "2026-08-10", "status": "open",
        "confidence": "medium", "edge_per_contract": 0.0,
    }
    base.update(kw)
    return base


class TestOpenPositions(unittest.TestCase):

    def test_yes_side_mark_is_yes_price(self):
        rows = open_positions([_bet(side="YES", market_yes_price=0.40,
                                    entry_price=0.42, mark_yes_price=0.55)])
        self.assertEqual(len(rows), 1)
        r = rows[0]
        self.assertEqual(r["entry_held"], 0.42)
        self.assertEqual(r["mark_held"], 0.55)          # YES held => mark is the YES price
        self.assertAlmostEqual(r["delta_held"], 0.13, places=6)
        self.assertEqual(r["entry_yes"], 0.40)
        self.assertEqual(r["mark_yes"], 0.55)
        self.assertEqual(r["edge_at_entry"], 0.0)   # carried through, not recomputed

    def test_no_side_mark_is_complement(self):
        rows = open_positions([_bet(side="NO", market_yes_price=0.70,
                                    entry_price=0.32, mark_yes_price=0.60)])
        r = rows[0]
        self.assertEqual(r["entry_held"], 0.32)
        self.assertEqual(r["mark_held"], 0.40)          # NO held => 1 - YES
        self.assertAlmostEqual(r["delta_held"], 0.08, places=6)
        self.assertEqual(r["entry_yes"], 0.70)
        self.assertEqual(r["mark_yes"], 0.60)

    def test_missing_edge_is_not_printed_as_a_measured_zero(self):
        b = _bet(side="YES", entry_price=0.42, mark_yes_price=0.55)
        b.pop("edge_per_contract")
        r = open_positions([b])[0]
        self.assertIsNone(r["edge_at_entry"])            # absent stays absent
        self.assertNotIn("+0.000", format_positions([r]))
        # A genuinely-zero edge still prints as zero — the two must stay distinguishable.
        zero = open_positions([_bet(edge_per_contract=0.0)])[0]
        self.assertEqual(zero["edge_at_entry"], 0.0)
        self.assertIn("+0.000", format_positions([zero]))

    def test_lowercase_side_is_not_a_frame_inversion(self):
        """A hand-edited 'yes' must not be read as NO and have its mark complemented."""
        r = open_positions([_bet(side="yes", market_yes_price=0.50,
                                 entry_price=0.53, mark_yes_price=0.60)])[0]
        self.assertEqual(r["mark_held"], 0.60)           # not 0.40
        self.assertAlmostEqual(r["delta_held"], 0.07, places=6)
        # Same inversion in metrics is worse than cosmetic: it books a pending LOSS as a
        # pending WIN, i.e. it flatters the mark-to-market record.
        import metrics
        near_zero = _bet(side="yes", market_yes_price=0.30, entry_price=0.35,
                         mark_yes_price=0.005)
        self.assertEqual(metrics.mark_outcome(near_zero), "pending_loss")
        self.assertEqual(open_positions([near_zero])[0]["decided"], "pending_loss")

    def test_bet7_regression_0595_is_underivable(self):
        """Bet 7 (b1783958439_2663611), exactly as logged in bets.jsonl."""
        b = _bet(bet_id="b1783958439_2663611", side="NO",
                 question="US-Iran 60 day negotiation period extended?",
                 market_yes_price=0.39, entry_price=0.62, mark_yes_price=0.325)
        rows = open_positions([b])
        r = rows[0]
        self.assertEqual(r["entry_held"], 0.62)
        self.assertEqual(r["mark_held"], 0.675)
        self.assertAlmostEqual(r["delta_held"], 0.055, places=6)
        self.assertEqual(r["entry_yes"], 0.39)
        self.assertEqual(r["mark_yes"], 0.325)
        # 0.595 was last week's adverse mark, never an entry. It must not be derivable
        # from — nor appear anywhere in — the row or its rendering.
        for v in r.values():
            if isinstance(v, float):
                self.assertNotAlmostEqual(v, 0.595, places=3)
        self.assertNotIn("0.595", format_positions(rows))
        self.assertNotIn("0.595", repr(r))

    def test_missing_mark_does_not_blow_up(self):
        for bad in (None, {}):
            kw = {"mark_yes_price": None} if bad is None else {}
            b = _bet(side="NO", market_yes_price=0.6, entry_price=0.41, **kw)
            if bad == {}:
                b.pop("mark_yes_price")
                b.pop("marked_at")
            rows = open_positions([b])
            r = rows[0]
            self.assertIsNone(r["mark_held"])
            self.assertIsNone(r["delta_held"])
            self.assertIsNone(r["mark_yes"])
            self.assertEqual(r["entry_held"], 0.41)
            out = format_positions(rows)          # must render, not raise
            self.assertIn("—", out)

    def test_resolved_bets_are_excluded(self):
        bets = [
            _bet(bet_id="open1", status="open"),
            _bet(bet_id="won1", status="won", pnl_net=19.0, resolved_outcome="YES"),
            _bet(bet_id="lost1", status="lost", pnl_net=-25.0, resolved_outcome="NO"),
        ]
        rows = open_positions(bets)
        self.assertEqual([r["bet_id"] for r in rows], ["open1"])

    def test_decided_flag_matches_metrics_mark_outcome(self):
        import metrics
        pending_win = _bet(side="NO", market_yes_price=0.3, entry_price=0.35,
                           mark_yes_price=0.005)
        pending_loss = _bet(side="YES", market_yes_price=0.3, entry_price=0.35,
                            mark_yes_price=0.005)
        undecided = _bet(side="YES", market_yes_price=0.3, entry_price=0.35,
                         mark_yes_price=0.40)
        rows = open_positions([pending_win, pending_loss, undecided])
        self.assertEqual([r["decided"] for r in rows],
                         [metrics.mark_outcome(pending_win),
                          metrics.mark_outcome(pending_loss),
                          metrics.mark_outcome(undecided)])
        self.assertEqual([r["decided"] for r in rows],
                         ["pending_win", "pending_loss", None])

    def test_empty_input(self):
        self.assertEqual(open_positions([]), [])
        self.assertIn("no open positions", format_positions([]).lower())


class TestFormatPositions(unittest.TestCase):

    def test_headers_name_the_frame_and_footnote_discloses_spread(self):
        out = format_positions(open_positions([
            _bet(side="NO", market_yes_price=0.39, entry_price=0.62,
                 mark_yes_price=0.325)]))
        # Every price column says which frame it is in — no bare "Entry"/"Mark".
        self.assertIn("entry(held)", out)
        self.assertIn("mark(held)", out)
        self.assertIn("entry(YES)", out)
        self.assertIn("mark(YES)", out)
        # The delta is approximate: entry crossed the spread, the mark did not — and the
        # YES pair is mid-to-mid, so it implies a bigger move than delta(held). Both have
        # to be said, or a reader doing the YES-frame arithmetic gets a different answer
        # from the column next to it and has nothing to reconcile them with.
        self.assertIn("spread", out.lower())
        self.assertIn("half-spread", out.lower())
        # And the actual numbers, in the held frame.
        self.assertIn("0.620", out)
        self.assertIn("0.675", out)
        self.assertIn("+0.055", out)


class TestEmailOpenBetsTable(unittest.TestCase):
    """The email is the artefact the human reads — the frames must hold there too.

    The ASCII table being right is not enough: the misreading this whole change exists to
    prevent happened off an email table, so an edit that put entry(held) back beside
    mark(YES) in the HTML has to turn something red.
    """

    def _html(self):
        bet7 = _bet(bet_id="b1783958439_2663611", side="NO",
                    question="US-Iran 60 day negotiation period extended?",
                    market_yes_price=0.39, entry_price=0.62, mark_yes_price=0.325,
                    edge_per_contract=0.12)
        return email_html([bet7])

    def test_held_frame_numbers_are_the_ones_rendered(self):
        html = self._html()
        self.assertIn("0.620", html)          # entry, held frame
        self.assertIn("0.675", html)          # mark, held frame (1 - 0.325)
        self.assertIn("+0.055", html)         # the position's move
        self.assertNotIn("0.595", html)

    def test_held_columns_precede_the_yes_reference_and_spread_is_disclosed(self):
        html = self._html()
        # Header order: the position's own frame first, the market's quote last.
        i_entry_held = html.index("Entry<br>(held)")
        i_mark_held = html.index("Mark<br>(held)")
        i_delta = html.index("Δ<br>(held)")
        i_yes_ref = html.index("(YES frame)")
        self.assertLess(i_entry_held, i_mark_held)
        self.assertLess(i_mark_held, i_delta)
        self.assertLess(i_delta, i_yes_ref)
        # The YES pair must not read as this position's prices, and the delta must be
        # disclosed as spread-crossed (hence not comparable to the mid-to-mid pair).
        self.assertIn("held-token frame", html)
        self.assertIn("spread", html.lower())
        self.assertIn("half-spread", html)

    def test_missing_edge_does_not_raise_in_the_email(self):
        b = _bet(side="NO", market_yes_price=0.39, entry_price=0.62,
                 mark_yes_price=0.325)
        b.pop("edge_per_contract")
        html = email_html([b])                # must render, not TypeError
        self.assertIn("—", html)


if __name__ == "__main__":
    unittest.main()
