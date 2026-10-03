#!/usr/bin/env python3
"""Runtime contract between the workflow, the prompt and the entry gate.

2026-09-28 null run: the agent proposed a bet, `record` launched the independent
reviewer (a subprocess allowed up to 600 s), and Claude Code's Bash tool gave up at its
120 s default and moved the command to the background. The agent ended its turn with
"I'll wait for the background task completion notification" — in `--print` mode ending
the turn is exiting, so no lessons were written and the week was lost. Since the gate
landed on 2026-09-07 no `record` had completed in CI at all.

These tests pin the three pieces that keep `record` in the foreground long enough, and
the single source of truth for the model, which is recorded on every bet (a model change
is a regime change for the track record).
"""
from __future__ import annotations
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))

import entry_gate  # noqa: E402

PROMPT = HERE / "agent-trader-prompt.md"
WORKFLOW = ROOT / ".github" / "workflows" / "agent-trader-weekly.yml"


def _env_ms(wf: str, name: str) -> int:
    m = re.search(rf'{name}:\s*"?(\d+)"?', wf)
    if not m:
        raise AssertionError(f"{name} not set in the workflow")
    return int(m.group(1))


class BashTimeoutTests(unittest.TestCase):
    def setUp(self):
        self.wf = WORKFLOW.read_text(encoding="utf-8")

    def test_bash_timeouts_outlast_the_reviewer(self):
        for name in ("BASH_DEFAULT_TIMEOUT_MS", "BASH_MAX_TIMEOUT_MS"):
            with self.subTest(name=name):
                self.assertGreater(_env_ms(self.wf, name),
                                   entry_gate.REVIEW_TIMEOUT_S * 1000)

    def test_prompt_keeps_record_in_the_foreground(self):
        prompt = PROMPT.read_text(encoding="utf-8").lower()
        self.assertIn("foreground", prompt)
        self.assertIn("run_in_background", prompt)


class ModelTests(unittest.TestCase):
    def setUp(self):
        self.wf = WORKFLOW.read_text(encoding="utf-8")

    def test_one_model_name_in_the_workflow(self):
        """Researcher, reviewer and Sonnet alias all come from AGENT_MODEL."""
        m = re.search(r"^\s+AGENT_MODEL:\s*(\S+)\s*$", self.wf, re.M)
        self.assertIsNotNone(m)
        # Model names in comments (the 5.5 note) are history, not configuration.
        code = "\n".join(l for l in self.wf.splitlines() if not l.lstrip().startswith("#"))
        names = set(re.findall(r"claude-(?:sonnet|opus|fable)-[\w.-]+", code))
        self.assertEqual(names, {m.group(1)})
        self.assertIn('--model "$AGENT_MODEL"', self.wf)
        self.assertIn("AGENT_REVIEW_MODEL: ${{ env.AGENT_MODEL }}", self.wf)
        self.assertIn("ANTHROPIC_DEFAULT_SONNET_MODEL: ${{ env.AGENT_MODEL }}", self.wf)

    def test_gate_default_matches_the_workflow(self):
        m = re.search(r"^\s+AGENT_MODEL:\s*(\S+)\s*$", self.wf, re.M)
        self.assertEqual(entry_gate.DEFAULT_MODEL, m.group(1))

    def test_smoke_test_checks_web_search(self):
        """Sonnet 5.5 answered fine yet every WebSearch 400'd (2026-10-03)."""
        smoke = self.wf[self.wf.index("Smoke-test the model deployment"):]
        smoke = smoke[:smoke.index("- name:", 10)]
        self.assertIn('--allowedTools "WebSearch"', smoke)
        self.assertIn("grep -q SEARCH_OK", smoke)

    def test_models_are_recorded_on_the_bet(self):
        import os
        old = {k: os.environ.get(k) for k in ("AGENT_MODEL", "AGENT_REVIEW_MODEL")}
        try:
            os.environ["AGENT_MODEL"] = "m-research"
            os.environ.pop("AGENT_REVIEW_MODEL", None)
            self.assertEqual(entry_gate.run_models(),
                             {"model": "m-research", "review_model": entry_gate.DEFAULT_MODEL})
        finally:
            for k, v in old.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v


if __name__ == "__main__":
    unittest.main()
