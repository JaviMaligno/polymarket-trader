#!/usr/bin/env python3
"""The side split must not reach the agent through the prompt or the workflow.

test_side_bias.py pins the renderers. This pins the two surfaces outside Python: the
decision prompt the agent is handed, and the workflow step that runs before its turn
ends. Both are edited by hand, which is exactly where a blind leaks.

See HYPOTHESIS-side-bias.md for why the blind matters: the agent has bets.jsonl and
could derive the split itself, so this is blind by construction, not by secrecy — but
nothing may hand it over.
"""
from __future__ import annotations
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parents[1]
PROMPT = HERE / "agent-trader-prompt.md"
WORKFLOW = ROOT / ".github" / "workflows" / "agent-trader-weekly.yml"


class PromptBlindnessTests(unittest.TestCase):
    def setUp(self):
        self.prompt = PROMPT.read_text(encoding="utf-8").lower()

    def test_prompt_does_not_mention_the_side_split(self):
        for fragment in ("by side", "--operator", "yes bets lose", "side bias",
                         "side-bias"):
            with self.subTest(fragment=fragment):
                self.assertNotIn(fragment, self.prompt)

    def test_prompt_does_not_send_the_agent_to_the_pre_registration(self):
        self.assertNotIn("hypothesis-side-bias", self.prompt)


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.wf = WORKFLOW.read_text(encoding="utf-8")

    def test_operator_view_is_printed_only_after_the_agents_turn(self):
        """It may appear in the run log — the agent cannot read that — but only after."""
        self.assertIn("metrics.py --operator", self.wf)
        self.assertLess(self.wf.index("agent-trader-prompt.md | claude"),
                        self.wf.index("metrics.py --operator"))

    def test_lessons_are_snapshotted_before_the_agent_runs(self):
        self.assertIn("cp lessons.md /tmp/lessons-before.md", self.wf)
        self.assertLess(self.wf.index("cp lessons.md /tmp/lessons-before.md"),
                        self.wf.index("agent-trader-prompt.md | claude"))

    def test_the_guard_runs_before_the_entry_audit_and_the_commit(self):
        """A repaired lessons.md is what gets audited and committed, not the raw one."""
        self.assertIn("python lessons_guard.py /tmp/lessons-before.md lessons.md",
                      self.wf)
        self.assertLess(self.wf.index("python lessons_guard.py"),
                        self.wf.index("python entry_gate.py audit"))

    def test_a_guard_violation_is_surfaced_not_swallowed(self):
        after = self.wf[self.wf.index("python lessons_guard.py"):]
        self.assertIn("::warning::", after[:1200])


if __name__ == "__main__":
    unittest.main()
