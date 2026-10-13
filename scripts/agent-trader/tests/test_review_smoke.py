import contextlib
import io
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import review_smoke  # noqa: E402

WORKFLOW = Path(__file__).resolve().parents[3] / '.github' / 'workflows' / 'agent-trader-weekly.yml'


def reviewer(groups):
    """Stand-in for the live reviewer: returns the given group per call, in order."""
    return patch.object(review_smoke.entry_gate, 'critical_review',
                        side_effect=[{'decision': 'reject', 'risk_group': g} for g in groups])


class ReviewSmokeTests(unittest.TestCase):
    def run_main(self):
        with contextlib.redirect_stdout(io.StringIO()):
            return review_smoke.main()

    def test_driver_grouping_passes(self):
        with reviewer(['iran-regional-conflict', 'israel-election-2026']):
            self.assertEqual(self.run_main(), 0)

    def test_keyword_grouping_fails(self):
        with reviewer(['iran-regional-conflict', 'iran-regional-conflict']):
            self.assertEqual(self.run_main(), 1)

    def test_a_missed_correlation_fails(self):
        with reviewer(['us-iran-ceasefire', 'israel-election-2026']):
            self.assertEqual(self.run_main(), 1)

    def test_a_missing_or_malformed_group_fails(self):
        for bad in (None, 'Israel Election'):
            with self.subTest(bad=bad), reviewer(['iran-regional-conflict', bad]):
                self.assertEqual(self.run_main(), 1)

    def test_validation_mode_runs_it(self):
        self.assertIn('python review_smoke.py', WORKFLOW.read_text(encoding='utf-8'))


if __name__ == '__main__':
    unittest.main()
