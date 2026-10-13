import unittest
from pathlib import Path


PROMPT = Path(__file__).resolve().parents[1] / "agent-trader-prompt.md"


class PromptResearchDepthTests(unittest.TestCase):
    """Sonnet 5.5 under the same harness researched ~5-7x less than 4.6 (rehearsals of
    2026-10-12: 6-8 searches and 1-3 opened pages in 86-104 s, against 28 and 37 in
    824 s). One of its runs treated an existing same-day section as a reason to do less,
    and declined a market over a price move it never looked up. The prompt has to ask
    for the depth explicitly; it was implicit in what 4.6 did unprompted.
    """

    def setUp(self):
        self.prompt = " ".join(PROMPT.read_text(encoding="utf-8").split())

    def test_every_run_is_a_full_pass(self):
        self.assertIn("Every run is a full research pass", self.prompt)

    def test_candidates_are_researched_one_by_one_from_a_real_shortlist(self):
        self.assertIn("Shortlist at least six candidates", self.prompt)

    def test_snippets_are_leads_not_sources(self):
        self.assertIn("a search snippet or a headline is a lead, not a source", self.prompt)

    def test_a_decline_names_its_finding(self):
        self.assertIn("A decline must name the finding that decided it", self.prompt)

    def test_an_unexplained_move_is_researched(self):
        self.assertIn("A price move you cannot explain is a question to research",
                      self.prompt)


if __name__ == "__main__":
    unittest.main()
