import unittest
from pathlib import Path


PROMPT = Path(__file__).resolve().parents[1] / "agent-trader-prompt.md"


class PromptSiblingMarketGuardrailTests(unittest.TestCase):
    """Run 15 placed a 'high conviction' bet on a 58% declared edge whose thesis was
    that the crowd misread the resolution criterion. The sibling seat-count market
    priced the same underlying quantity at the same number under the literal reading,
    so no anomaly existed. A large declared edge must trigger that cross-check."""

    def setUp(self):
        # normalised: the prompt hard-wraps, so required phrases span lines
        self.prompt = " ".join(PROMPT.read_text(encoding="utf-8").split())

    def test_large_declared_edge_presumes_own_misreading(self):
        self.assertIn(
            "the default hypothesis is that YOU are misreading the criterion",
            self.prompt,
        )

    def test_large_declared_edge_requires_sibling_market_check(self):
        for fragment in (
            "sibling market",
            "prices the underlying quantity your thesis turns on",
            "If the sibling implies roughly the price you are calling wrong",
        ):
            with self.subTest(fragment=fragment):
                self.assertIn(fragment, self.prompt)

    def test_seat_projections_must_be_decomposed_by_electoral_tier(self):
        for fragment in (
            "mixed electoral system",
            "list seats vs constituency seats",
        ):
            with self.subTest(fragment=fragment):
                self.assertIn(fragment, self.prompt)


if __name__ == "__main__":
    unittest.main()
