import unittest
from pathlib import Path


PROMPT = Path(__file__).resolve().parents[1] / "agent-trader-prompt.md"


class PromptConcentrationGuardrailTests(unittest.TestCase):
    def test_resolved_correlated_bet_cannot_be_replaced_in_same_run(self):
        prompt = PROMPT.read_text(encoding="utf-8")

        self.assertIn(
            "A resolved correlated bet does not immediately free a concentration slot",
            prompt,
        )
        self.assertIn("Do not replace it during the same run", prompt)


if __name__ == "__main__":
    unittest.main()
