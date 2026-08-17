import unittest
from pathlib import Path


PROMPT = Path(__file__).resolve().parents[1] / "agent-trader-prompt.md"


class PromptGuardrailTests(unittest.TestCase):
    def test_open_position_updates_require_market_challenge_checklist(self):
        prompt = PROMPT.read_text(encoding="utf-8")

        required_checks = (
            "What does the marginal buyer know that I may be missing?",
            "Was the motivating news already reflected in the price before entry?",
            "What probability remains that the criterion is met before the deadline?",
            "Do not call a thesis confirmed or vindicated before resolution.",
        )

        self.assertIn("For every open position", prompt)
        for check in required_checks:
            with self.subTest(check=check):
                self.assertIn(check, prompt)


if __name__ == "__main__":
    unittest.main()
