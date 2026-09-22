#!/usr/bin/env python3
"""Tests for the resolution projection carried on each open position.

Run 18 closed with: "Bet 16 high-confidence win (YES=0.095); NO edge ~85pp. Expected P&L
after resolution: ~-$58, bankroll ~$942." Three numbers, all wrong:

  * the edge at entry is p_hat_NO - entry(held) = 0.96 - 0.83 = 13pp. The 85pp came from
    0.96 - 0.11, i.e. measuring the edge against TODAY's mark instead of the entry — the
    same "large declared edge" shape that produced the 58% claim on Bet 15;
  * the payout is stake/entry - stake = 25/0.83 - 25 = +$5.12, not the ~+$15 implied;
  * so the bankroll on a win is $932.29, not ~$942.

None of it is a thesis error; it is arithmetic done in prose. The harness has every
input, so it should hand the agent the numbers and have the prompt require it to quote
them, exactly as it already does for entry/mark/delta.
"""
from __future__ import annotations
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent_trader import open_positions, format_positions  # noqa: E402


def _open(**kw):
    b = {"bet_id": "bopen", "status": "open", "side": "NO", "question": "q",
         "end_date": "2026-10-01T03:59:00Z", "stake": 25.0, "entry_price": 0.83,
         "market_yes_price": 0.175, "mark_yes_price": 0.095, "confidence": "medium",
         "edge_per_contract": 0.11, "fee_rate": 0.0, "fee_paid": 0.0,
         "my_prob_yes": 0.06, "resolved_outcome": None, "pnl_net": None}
    b.update(kw)
    return b


def _closed(pnl, **kw):
    b = {"bet_id": f"bc{pnl}", "status": "won" if pnl > 0 else "lost", "side": "NO",
         "question": "q", "stake": 25.0, "entry_price": 0.5, "pnl_net": pnl,
         "resolved_outcome": "NO", "my_prob_yes": 0.4, "mark_yes_price": None}
    b.update(kw)
    return b


class ProjectionTests(unittest.TestCase):
    def test_payout_if_won_is_the_contract_payout_not_the_stake(self):
        r = open_positions([_open()])[0]
        self.assertAlmostEqual(r["payout_if_won"], 5.12, places=2)

    def test_loss_if_lost_is_the_stake_plus_the_entry_fee(self):
        r = open_positions([_open(fee_rate=0.04, fee_paid=0.17)])[0]
        self.assertAlmostEqual(r["loss_if_lost"], -25.17, places=2)

    def test_payout_if_won_is_net_of_the_entry_fee(self):
        r = open_positions([_open(fee_rate=0.04, fee_paid=0.17)])[0]
        self.assertAlmostEqual(r["payout_if_won"], 4.95, places=2)

    def test_bet16_projection_is_the_one_run18_got_wrong(self):
        """The regression case, with the real resolved P&L of -$72.83 behind it."""
        bets = [_closed(-72.83), _open()]
        r = open_positions(bets)[0]
        self.assertAlmostEqual(r["bankroll_if_won"], 932.29, places=2)
        self.assertAlmostEqual(r["bankroll_if_lost"], 902.17, places=2)
        # ...and specifically not the numbers the prose claimed.
        self.assertNotAlmostEqual(r["bankroll_if_won"], 942.0, places=0)

    def test_bankroll_projection_ignores_other_open_positions(self):
        """One position at a time: the other open bets are still open in both branches."""
        bets = [_closed(-72.83), _open(), _open(bet_id="other", stake=50.0)]
        r = open_positions(bets)[0]
        self.assertAlmostEqual(r["bankroll_if_won"], 932.29, places=2)

    def test_edge_at_entry_is_never_recomputed_against_the_mark(self):
        """edge_at_entry is the logged entry-time number, whatever the mark did."""
        r = open_positions([_open(edge_per_contract=0.11, mark_yes_price=0.01)])[0]
        self.assertAlmostEqual(r["edge_at_entry"], 0.11, places=6)

    def test_a_position_without_an_entry_price_projects_nothing(self):
        r = open_positions([_open(entry_price=None)])[0]
        self.assertIsNone(r["payout_if_won"])
        self.assertIsNone(r["bankroll_if_won"])

    def test_the_table_prints_the_projection(self):
        out = format_positions(open_positions([_closed(-72.83), _open()]))
        self.assertIn("+5.12", out)
        self.assertIn("932.29", out)
        self.assertIn("902.17", out)

    def test_the_table_explains_that_the_projection_is_per_position(self):
        out = format_positions(open_positions([_closed(-72.83), _open()]))
        self.assertIn("bankroll", out.lower())


if __name__ == "__main__":
    unittest.main()
