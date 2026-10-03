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
import json
import os
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
        self.assertIn("source scripts/agent-trader/search-flags.sh || exit 1", smoke)
        self.assertIn('"${SEARCH_FLAGS[@]}"', smoke)
        self.assertIn('--allowedTools "$SEARCH_TOOLS"', smoke)
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


class SearchModeTests(unittest.TestCase):
    """AGENT_WEB_SEARCH=mcp swaps the built-in WebSearch (unusable on Foundry with Sonnet
    5.5, 2026-10-03) for search_mcp.py, in the researcher AND the reviewer."""

    def setUp(self):
        self.wf = WORKFLOW.read_text(encoding="utf-8")
        self._old = os.environ.get("AGENT_WEB_SEARCH")

    def tearDown(self):
        if self._old is None:
            os.environ.pop("AGENT_WEB_SEARCH", None)
        else:
            os.environ["AGENT_WEB_SEARCH"] = self._old

    def _reviewer_args(self, mode):
        if mode is None:
            os.environ.pop("AGENT_WEB_SEARCH", None)
        else:
            os.environ["AGENT_WEB_SEARCH"] = mode
        return entry_gate.reviewer_tool_args()

    def test_builtin_reviewer_is_unchanged(self):
        for mode in (None, "builtin"):
            args = self._reviewer_args(mode)
            self.assertEqual(args[args.index("--tools") + 1], "WebSearch,WebFetch")
            self.assertEqual(json.loads(args[args.index("--mcp-config") + 1]),
                             {"mcpServers": {}})

    def test_mcp_reviewer_gets_the_search_server_and_no_builtin_websearch(self):
        args = self._reviewer_args("mcp")
        self.assertEqual(args[args.index("--tools") + 1], "WebFetch")
        allowed = args[args.index("--allowedTools") + 1].split(",")
        self.assertIn("mcp__search__web_search", allowed)
        self.assertIn("mcp__search__news_search", allowed)
        self.assertNotIn("WebSearch", allowed)
        self.assertIn("--strict-mcp-config", args)
        server = json.loads(args[args.index("--mcp-config") + 1])["mcpServers"]["search"]
        self.assertTrue(server["args"][-1].endswith("search_mcp.py"))
        self.assertTrue(Path(server["args"][-1]).is_file())

    def test_unknown_mode_fails_closed(self):
        with self.assertRaises(ValueError):
            self._reviewer_args("bing")

    def test_workflow_declares_the_mode_and_wires_the_researcher(self):
        self.assertRegex(self.wf, r"(?m)^\s+AGENT_WEB_SEARCH:\s*(builtin|mcp)\s*$")
        loop = self.wf[self.wf.index("agent-trader-prompt.md | claude"):]
        loop = loop[:loop.index("/tmp/agent-run.log")]
        self.assertIn('"${SEARCH_FLAGS[@]}"', loop)
        self.assertIn("$SEARCH_TOOLS", loop)
        self.assertNotIn("WebSearch", loop.split("--allowedTools", 1)[1].split("\n")[0])
        self.assertLess(self.wf.index("source search-flags.sh"),
                        self.wf.index("agent-trader-prompt.md | claude"))

    def _flags(self, mode):
        import subprocess
        script = ('source search-flags.sh || exit 3; printf "%s\\n" "${SEARCH_FLAGS[@]}"; '
                  'echo "TOOLS=$SEARCH_TOOLS"')
        bash = "bash"
        if os.name == "nt":  # bare `bash` is WSL's there, which drops the environment
            bash = r"C:\Program Files\Git\bin\bash.exe"
            if not Path(bash).is_file():
                self.skipTest("Git Bash not found")
        out = subprocess.run([bash, "-c", script], cwd=HERE, capture_output=True,
                             text=True, env=dict(os.environ, AGENT_WEB_SEARCH=mode))
        return out.returncode, out.stdout.splitlines()

    def test_flags_script_mcp(self):
        code, lines = self._flags("mcp")
        self.assertEqual(code, 0)
        cfg = json.loads(lines[lines.index("--mcp-config") + 1])
        self.assertTrue(cfg["mcpServers"]["search"]["args"][0].endswith("search_mcp.py"))
        self.assertEqual(lines[lines.index("--disallowedTools") + 1], "WebSearch")
        self.assertEqual(lines[-1], "TOOLS=mcp__search__web_search mcp__search__news_search")

    def test_flags_script_builtin_and_unknown(self):
        self.assertEqual(self._flags("builtin"), (0, ["", "TOOLS=WebSearch"]))
        self.assertNotEqual(self._flags("bing")[0], 0)


if __name__ == "__main__":
    unittest.main()
