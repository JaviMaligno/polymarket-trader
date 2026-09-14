import importlib.util
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import agent_trader as trader

PROMPT = Path(__file__).resolve().parents[1] / "agent-trader-prompt.md"


class FeeRateTests(unittest.TestCase):
    """Run 17 rejected a bet using a self-invented flat 0.04 fee that exists
    nowhere in the harness, while the recorded P&L charged no fee at all.
    Polymarket's real fee is per-market: Gamma exposes `feesEnabled` and
    `feeType`, and 6 of the first 14 resolved bets were on fee-free markets."""

    def test_fee_free_market_costs_nothing(self):
        self.assertEqual(trader.fee_rate({'feesEnabled': False, 'feeType': None}), 0.0)

    def test_fee_type_absent_costs_nothing(self):
        self.assertEqual(trader.fee_rate({'feesEnabled': True, 'feeType': None}), 0.0)

    def test_known_fee_types_map_to_documented_rates(self):
        for fee_type, rate in (('politics_fees', 0.04),
                               ('finance_prices_fees', 0.04),
                               ('sports_fees_v2', 0.05)):
            with self.subTest(fee_type=fee_type):
                self.assertEqual(
                    trader.fee_rate({'feesEnabled': True, 'feeType': fee_type}), rate)

    def test_unknown_fee_type_fails_expensive(self):
        # Never under-charge an unrecognised category: assume the dearest rate.
        self.assertEqual(
            trader.fee_rate({'feesEnabled': True, 'feeType': 'mystery_fees'}), 0.07)


class FeeAmountTests(unittest.TestCase):
    """fee = shares x rate x p x (1-p) with shares = stake/entry and p = entry,
    which collapses to stake x rate x (1 - entry). Taker-side only, charged at
    entry; hold-to-resolution means there is no second leg."""

    def test_fee_amount_matches_the_documented_formula(self):
        # 80.645 shares x 0.04 x 0.31 x 0.69 = 0.69
        self.assertAlmostEqual(trader.fee_amount(25, 0.31, 0.04), 0.69, places=2)

    def test_fee_amount_is_zero_at_zero_rate(self):
        self.assertEqual(trader.fee_amount(25, 0.31, 0.0), 0.0)

    def test_fee_is_symmetric_in_entry_price(self):
        # p(1-p) is symmetric, so the side taken cannot change the per-share fee.
        a = trader.fee_amount(25, 0.31, 0.04) / (25 / 0.31)
        b = trader.fee_amount(25, 0.69, 0.04) / (25 / 0.69)
        self.assertAlmostEqual(a, b, places=6)


class PnlNetOfFeesTests(unittest.TestCase):
    def test_winner_pnl_is_net_of_the_entry_fee(self):
        self.assertAlmostEqual(
            trader.resolve_pnl(stake=25, entry=0.60, won=True, fee=0.40),
            round(25 / 0.60 - 25, 2) - 0.40, places=2)

    def test_loser_loses_stake_plus_the_entry_fee(self):
        self.assertAlmostEqual(
            trader.resolve_pnl(stake=25, entry=0.60, won=False, fee=0.40),
            -25.40, places=2)


class GateEdgeBarTests(unittest.TestCase):
    """The 5pp bar must price the entry the way the exchange does. Before this,
    the gate compared p_hat to the raw executable quote and the agent patched a
    hand-invented fee on top of it in prose — two cost models, neither recorded."""

    def setUp(self):
        spec = importlib.util.find_spec('entry_gate')
        self.assertIsNotNone(spec, 'entry gate is not implemented')
        import entry_gate
        self.gate = entry_gate

    def test_effective_entry_adds_the_per_share_fee(self):
        # rate 0.04 at p=0.60: 0.04 x 0.60 x 0.40 = 0.0096 per share.
        self.assertAlmostEqual(
            self.gate.effective_entry(0.60, 0.04), 0.6096, places=4)

    def test_effective_entry_is_the_quote_when_the_market_is_fee_free(self):
        self.assertAlmostEqual(self.gate.effective_entry(0.60, 0.0), 0.60, places=6)


class PromptFeeTests(unittest.TestCase):
    def setUp(self):
        self.prompt = " ".join(PROMPT.read_text(encoding="utf-8").split())

    def test_prompt_forbids_inventing_a_fee_rate(self):
        self.assertIn("Never assume a flat fee rate", self.prompt)

    def test_prompt_points_at_the_harness_fee_helper(self):
        self.assertIn("python agent_trader.py fee", self.prompt)


if __name__ == "__main__":
    unittest.main()
