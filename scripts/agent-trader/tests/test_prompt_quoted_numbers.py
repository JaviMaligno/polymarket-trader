import unittest
from pathlib import Path


PROMPT = Path(__file__).resolve().parents[1] / "agent-trader-prompt.md"


class PromptQuotedNumbersTests(unittest.TestCase):
    """Run 18's three wrong numbers were all recomputed in prose from inputs the
    harness already had: the payout (+$15 for a position paying +$5.12), the bankroll
    (~$942 vs $932.29) and the edge ("~85pp" from p_hat minus TODAY's mark rather than
    the entry). The prompt already forces entry/mark/delta to be quoted from
    `positions`; the same rule has to cover what the position pays and what the edge is.
    """

    def setUp(self):
        self.prompt = " ".join(PROMPT.read_text(encoding="utf-8").split())

    def test_projection_columns_must_be_quoted_not_recomputed(self):
        for fragment in ("if won", "bankroll if won", "never compute a payout"):
            with self.subTest(fragment=fragment):
                self.assertIn(fragment, self.prompt)

    def test_edge_may_not_be_re_derived_against_the_current_mark(self):
        self.assertIn("Never re-derive an edge against the current mark", self.prompt)


class PromptPriceHistoryTests(unittest.TestCase):
    """Run 18 answered the before-vs-after-entry checklist item for Bet 16 with another
    market's price path. The harness now resolves the series from the market id, so the
    prompt must send the agent there rather than to a hand-assembled CLOB URL."""

    def setUp(self):
        self.prompt = " ".join(PROMPT.read_text(encoding="utf-8").split())

    def test_prompt_names_the_history_command(self):
        self.assertIn("agent_trader.py history", self.prompt)

    def test_open_position_price_claims_must_quote_that_output(self):
        self.assertIn("history --open", self.prompt)

    def test_prompt_warns_that_the_window_is_not_the_markets_life(self):
        for fragment in ("TRUNCATED", "not the market's opening"):
            with self.subTest(fragment=fragment):
                self.assertIn(fragment, self.prompt)


if __name__ == "__main__":
    unittest.main()
