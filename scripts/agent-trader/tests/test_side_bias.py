#!/usr/bin/env python3
"""Tests for the side-bias instrumentation — the YES/NO split and its blindness rule.

Why this exists: at n=15 the record splits NO 5-1 (+$43.98) vs YES 3-6 (-$116.81), and
the YES subset is the first in this experiment whose bootstrap CI excludes zero. That is
a POST-HOC split on a small sample, so it is a hypothesis to test prospectively, not a
finding to act on. See HYPOTHESIS-side-bias.md for the pre-registration.

Testing it prospectively only works if the agent does not see it: an agent told "your YES
bets lose" stops taking YES bets, and then the future sample can no longer distinguish
"the hypothesis was false" from "the agent reacted to being told". So the split is
computed and persisted for the operator, and kept out of every surface the agent reads.

`render_text` is the agent-facing surface (it is what `metrics.py` prints and what the
prompt tells the agent to read). `render_operator_text` and the email HTML are the
operator's. The blindness tests below pin that separation; without them the split would
drift into the agent's view on the next edit to the renderer.
"""
from __future__ import annotations
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import metrics  # noqa: E402


def _bet(side, status, pnl, my_prob=0.5, stake=25.0, entry=0.5):
    return {
        "bet_id": f"b{side}{status}{pnl}", "side": side, "status": status,
        "pnl_net": pnl, "stake": stake, "entry_price": entry,
        "my_prob_yes": my_prob,
        "resolved_outcome": ("YES" if (side == "YES") == (status == "won") else "NO")
        if status in ("won", "lost") else None,
        "confidence": "medium", "mark_yes_price": None,
    }


FIXTURE = [
    _bet("NO", "won", 11.18), _bet("NO", "won", 4.07), _bet("NO", "won", 15.32),
    _bet("NO", "lost", -25.0),
    _bet("YES", "won", 14.68), _bet("YES", "lost", -25.73), _bet("YES", "lost", -25.0),
    {"bet_id": "bopen", "side": "YES", "status": "open", "pnl_net": None, "stake": 25.0,
     "entry_price": 0.5, "my_prob_yes": 0.6, "resolved_outcome": None,
     "confidence": "medium", "mark_yes_price": None},
]


class SideSplitTests(unittest.TestCase):
    def test_by_side_counts_only_resolved_bets(self):
        by_side = metrics.compute_metrics(FIXTURE)["by_side"]
        self.assertEqual(by_side["NO"]["n"], 4)
        self.assertEqual(by_side["YES"]["n"], 3)   # the open YES bet is excluded

    def test_by_side_pnl_and_record(self):
        by_side = metrics.compute_metrics(FIXTURE)["by_side"]
        self.assertEqual(by_side["NO"]["wins"], 3)
        self.assertAlmostEqual(by_side["NO"]["pnl"], 5.57, places=2)
        self.assertEqual(by_side["YES"]["wins"], 1)
        self.assertAlmostEqual(by_side["YES"]["pnl"], -36.05, places=2)

    def test_by_side_carries_a_bootstrap_ci(self):
        """The split is only worth reading with its uncertainty attached."""
        no = metrics.compute_metrics(FIXTURE)["by_side"]["NO"]
        self.assertIsNotNone(no["boot_lo"])
        self.assertIsNotNone(no["boot_hi"])
        self.assertLessEqual(no["boot_lo"], no["mean"])
        self.assertLessEqual(no["mean"], no["boot_hi"])

    def test_a_side_with_one_resolved_bet_reports_no_ci(self):
        """One point has no bootstrap; report the mean and leave the CI empty."""
        one = metrics.compute_metrics([_bet("NO", "won", 10.0)])["by_side"]["NO"]
        self.assertEqual(one["n"], 1)
        self.assertIsNone(one["boot_lo"])

    def test_side_is_case_normalised(self):
        """A hand-edited lowercase 'no' must not open a third bucket."""
        m = metrics.compute_metrics([_bet("no", "won", 4.0), _bet("NO", "lost", -25.0)])
        self.assertEqual(set(m["by_side"]), {"NO"})
        self.assertEqual(m["by_side"]["NO"]["n"], 2)


class BlindnessTests(unittest.TestCase):
    """The agent reads render_text; it must not carry the split."""

    def test_agent_facing_text_does_not_expose_the_split(self):
        out = metrics.render_text(metrics.compute_metrics(FIXTURE))
        self.assertNotIn("by side", out.lower())
        # Nor the numbers themselves under any other label.
        self.assertNotIn("-36.05", out)

    def test_operator_text_does_expose_the_split(self):
        out = metrics.render_operator_text(metrics.compute_metrics(FIXTURE))
        self.assertIn("by side", out.lower())
        self.assertIn("YES", out)
        self.assertIn("NO", out)

    def test_operator_text_is_a_superset_of_the_agent_text(self):
        """Same numbers, one extra block — never a second, divergent computation."""
        m = metrics.compute_metrics(FIXTURE)
        for line in metrics.render_text(m).splitlines():
            self.assertIn(line, metrics.render_operator_text(m))

    def test_email_html_exposes_the_split(self):
        html = metrics.render_html(metrics.compute_metrics(FIXTURE))
        self.assertIn("By side", html)


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._saved = metrics.METRICS_LOG
        metrics.METRICS_LOG = Path(self._tmp.name) / "metrics.jsonl"

    def tearDown(self):
        metrics.METRICS_LOG = self._saved
        self._tmp.cleanup()

    def _rows(self):
        return [json.loads(l) for l in metrics.METRICS_LOG.open(encoding="utf-8")
                if l.strip()]

    def test_snapshot_carries_the_side_split(self):
        metrics.append_snapshot(metrics.compute_metrics(FIXTURE), "2026-09-21")
        row = self._rows()[0]
        self.assertEqual(row["yes_n"], 3)
        self.assertEqual(row["no_n"], 4)
        self.assertAlmostEqual(row["yes_pnl"], -36.05, places=2)

    def test_rerunning_a_date_replaces_its_row_instead_of_appending(self):
        """Manual re-runs appended duplicates: 17 rows for 18 runs, 13 distinct dates.

        The trajectory is one row per date by definition; a re-run supersedes the
        earlier attempt at that date rather than sitting beside it.
        """
        m = metrics.compute_metrics(FIXTURE)
        metrics.append_snapshot(m, "2026-09-21")
        metrics.append_snapshot(m, "2026-09-21")
        metrics.append_snapshot(m, "2026-09-28")
        dates = [r["date"] for r in self._rows()]
        self.assertEqual(dates, ["2026-09-21", "2026-09-28"])

    def test_replacing_a_date_keeps_the_newer_numbers(self):
        metrics.append_snapshot(metrics.compute_metrics(FIXTURE), "2026-09-21")
        metrics.append_snapshot(metrics.compute_metrics(FIXTURE[:4]), "2026-09-21")
        rows = self._rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["n_resolved"], 4)

    def test_replacing_a_date_preserves_the_order_of_the_others(self):
        m = metrics.compute_metrics(FIXTURE)
        for d in ("2026-09-07", "2026-09-14", "2026-09-21"):
            metrics.append_snapshot(m, d)
        metrics.append_snapshot(m, "2026-09-14")
        self.assertEqual([r["date"] for r in self._rows()],
                         ["2026-09-07", "2026-09-14", "2026-09-21"])

    def test_a_non_date_is_never_a_snapshot_key(self):
        with self.assertRaises(ValueError):
            metrics.append_snapshot(metrics.compute_metrics(FIXTURE), "--operator")
        self.assertFalse(metrics.METRICS_LOG.exists())


class CliTests(unittest.TestCase):
    """`metrics.py --operator` (run by the workflow) printed the AGENT view and appended a
    row dated "--operator" to metrics.jsonl: any argv was taken as a snapshot date, and
    the flag itself was never parsed. Seen in the 2026-09-28 and 2026-10-02 commits."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._saved = metrics.METRICS_LOG
        metrics.METRICS_LOG = Path(self._tmp.name) / "metrics.jsonl"

    def tearDown(self):
        metrics.METRICS_LOG = self._saved
        self._tmp.cleanup()

    def test_operator_flag_prints_the_split_and_writes_nothing(self):
        out = metrics.main(["--operator"], FIXTURE)
        self.assertIn("by side", out.lower())
        self.assertFalse(metrics.METRICS_LOG.exists())

    def test_bare_call_is_the_agent_view(self):
        out = metrics.main([], FIXTURE)
        self.assertNotIn("by side", out.lower())
        self.assertFalse(metrics.METRICS_LOG.exists())

    def test_a_date_argument_snapshots(self):
        metrics.main(["2026-10-05"], FIXTURE)
        rows = [json.loads(l) for l in metrics.METRICS_LOG.read_text(
            encoding="utf-8").splitlines() if l.strip()]
        self.assertEqual([r["date"] for r in rows], ["2026-10-05"])

    def test_an_unknown_argument_is_rejected(self):
        with self.assertRaises(SystemExit):
            metrics.main(["--oprator"], FIXTURE)
        self.assertFalse(metrics.METRICS_LOG.exists())


if __name__ == "__main__":
    unittest.main()
