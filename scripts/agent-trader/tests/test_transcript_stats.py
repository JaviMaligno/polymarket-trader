#!/usr/bin/env python3
"""Tests for the decision-loop transcript reader.

Until 2026-10-12 the workflow kept only the final message of `claude --print`. Run 21
spent 44 s of agent time (Run 20: ~6 min; Sonnet 4.6 runs: ~25 min), wrote a plausible
section and placed nothing — and there was no way to tell a researched decline from a
skimmed one, because nothing recorded how many searches or fetches it made. The run now
streams its transcript (`--output-format stream-json`) and this reader turns it into:

- the final message, as before, so the null-run grep keeps matching API errors;
- a research count (searches, fetches, tool calls by name, turns, duration);
- a redacted copy for the artifact — this repo is public and the agent has Bash.
"""
from __future__ import annotations
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import transcript_stats as ts  # noqa: E402


def _assistant(*blocks):
    return {"type": "assistant", "message": {"role": "assistant", "content": list(blocks)}}


def _tool(name, **inp):
    return {"type": "tool_use", "id": f"t{len(inp)}", "name": name, "input": inp}


def _text(t):
    return {"type": "text", "text": t}


def _result(text, is_error=False, turns=12, ms=44000):
    return {"type": "result", "subtype": "success", "is_error": is_error,
            "result": text, "num_turns": turns, "duration_ms": ms}


HEALTHY = [
    {"type": "system", "subtype": "init", "model": "claude-sonnet-5-5"},
    _assistant(_text("Starting."), _tool("Bash", command="python agent_trader.py summary")),
    {"type": "user", "message": {"content": [{"type": "tool_result", "content": "rate limit mentioned in a page"}]}},
    _assistant(_tool("mcp__search__news_search", query="Iran blockade")),
    _assistant(_tool("mcp__search__web_search", query="Serbia election poll"),
               _tool("mcp__search__web_search", query="Iran blockade")),
    _assistant(_tool("WebFetch", url="https://example.com/a", prompt="read")),
    _assistant(_tool("Write", file_path="lessons.md", content="x")),
    _result("No bets placed this run."),
]


def _lines(events):
    return "\n".join(json.dumps(e) for e in events) + "\n"


class StatsTests(unittest.TestCase):
    def test_counts_research_calls(self):
        s = ts.parse(_lines(HEALTHY))
        self.assertEqual(s.searches, 3)
        self.assertEqual(s.fetches, 1)
        self.assertEqual(s.queries, ["Iran blockade", "Serbia election poll"])
        self.assertEqual(s.tool_counts["Bash"], 1)
        self.assertEqual(s.tool_counts["Write"], 1)
        self.assertEqual(s.num_turns, 12)
        self.assertEqual(s.duration_ms, 44000)
        self.assertTrue(s.completed)

    def test_builtin_websearch_counts_as_search(self):
        s = ts.parse(_lines([_assistant(_tool("WebSearch", query="q")), _result("ok")]))
        self.assertEqual(s.searches, 1)

    def test_final_message_is_the_result_text(self):
        self.assertEqual(ts.parse(_lines(HEALTHY)).final_text, "No bets placed this run.")

    def test_api_error_reaches_the_final_text(self):
        """The workflow greps the final text for `API Error`; it must survive the switch."""
        events = [_result("API Error: 400 You have reached your specified API usage limits",
                          is_error=True, turns=1, ms=900)]
        s = ts.parse(_lines(events))
        self.assertIn("API Error", s.final_text)
        self.assertTrue(s.is_error)

    def test_tool_output_text_does_not_reach_the_final_text(self):
        """Web pages say "rate limit"; only the agent's own words go to the grepped log."""
        self.assertNotIn("rate limit", ts.parse(_lines(HEALTHY)).final_text)

    def test_killed_run_falls_back_to_assistant_text(self):
        s = ts.parse(_lines(HEALTHY[:3]))
        self.assertFalse(s.completed)
        self.assertIn("Starting.", s.final_text)

    def test_non_json_lines_are_skipped(self):
        s = ts.parse("not json\n" + _lines(HEALTHY) + "\n{broken")
        self.assertEqual(s.searches, 3)

    def test_zero_research_is_flagged(self):
        s = ts.parse(_lines([_assistant(_tool("Bash", command="ls")), _result("done")]))
        self.assertTrue(any("::warning::" in line for line in ts.report(s)))

    def test_research_below_the_minimum_is_flagged(self):
        """Run 21 searched a little; a zero-only check would not have caught it."""
        s = ts.parse(_lines(HEALTHY))  # 3 searches + 1 fetch = 4
        self.assertTrue(any("::warning::" in l and "4" in l for l in ts.report(s, min_calls=5)))

    def test_research_at_the_minimum_is_not_flagged(self):
        s = ts.parse(_lines(HEALTHY))
        self.assertFalse(any("::warning::" in l for l in ts.report(s, min_calls=4)))

    def test_default_minimum_is_five(self):
        """Provisional: the first measured 5.5 run (rehearsal 2026-10-12) made 7."""
        self.assertEqual(ts.DEFAULT_MIN_CALLS, 5)

    def test_api_error_run_is_not_flagged_for_research(self):
        """The null-run detector already owns that case; one warning, not two."""
        s = ts.parse(_lines([_result("API Error: 401", is_error=True)]))
        self.assertFalse(any("::warning::" in l for l in ts.report(s)))

    def test_pending_mcp_server_is_not_flagged(self):
        """init is emitted while the server is still starting; the 2026-10-12 rehearsal
        reported `pending` and then made six searches through it."""
        init = {"type": "system", "subtype": "init",
                "mcp_servers": [{"name": "search", "status": "pending"}]}
        s = ts.parse(_lines([init] + HEALTHY))
        self.assertFalse(any("::warning::" in l for l in ts.report(s, min_calls=1)))

    def test_mcp_server_that_failed_to_start_is_flagged(self):
        """With AGENT_WEB_SEARCH=mcp a dead search server leaves the agent with no search tool."""
        init = {"type": "system", "subtype": "init",
                "mcp_servers": [{"name": "search", "status": "failed"}]}
        s = ts.parse(_lines([init, _assistant(_tool("WebFetch", url="u")), _result("ok")]))
        self.assertEqual(s.mcp_servers, {"search": "failed"})
        self.assertTrue(any("::warning::" in l and "search" in l for l in ts.report(s)))

    def test_connected_mcp_server_is_not_flagged(self):
        init = {"type": "system", "subtype": "init",
                "mcp_servers": [{"name": "search", "status": "connected"}]}
        s = ts.parse(_lines([init] + HEALTHY))
        self.assertFalse(any("::warning::" in l for l in ts.report(s, min_calls=1)))

    def test_report_lists_the_queries(self):
        out = "\n".join(ts.report(ts.parse(_lines(HEALTHY))))
        self.assertIn("Serbia election poll", out)
        self.assertIn("searches=3", out)


class RedactionTests(unittest.TestCase):
    def test_secret_env_values_are_redacted(self):
        raw = '{"x": "key is fake-foundry-value and res my-resource"}'
        env = {"ANTHROPIC_FOUNDRY_API_KEY": "fake-foundry-value",
               "ANTHROPIC_FOUNDRY_RESOURCE": "my-resource"}
        out = ts.redact(raw, env)
        self.assertNotIn("fake-foundry-value", out)
        self.assertNotIn("my-resource", out)

    def test_github_tokens_are_redacted(self):
        # Built at runtime: a token-shaped literal in the source trips secret scanners.
        token = "gh" + "s_" + "x" * 36
        header = "Q" * 24
        raw = f"extraheader = AUTHORIZATION: basic {header} {token}"
        out = ts.redact(raw, {})
        self.assertNotIn(token, out)
        self.assertNotIn(header, out)

    def test_short_or_empty_env_values_are_not_redacted(self):
        """An empty secret would replace every position in the file."""
        self.assertEqual(ts.redact("abc", {"ANTHROPIC_FOUNDRY_API_KEY": ""}), "abc")


class CliTests(unittest.TestCase):
    def test_writes_log_redacted_copy_and_step_summary(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            (d / "t.jsonl").write_text(_lines(HEALTHY) + '{"leak": "fake-foundry-value"}\n',
                                       encoding="utf-8")
            summary = d / "summary.md"
            env = {"ANTHROPIC_FOUNDRY_API_KEY": "fake-foundry-value",
                   "GITHUB_STEP_SUMMARY": str(summary)}
            with contextlib.redirect_stdout(io.StringIO()):
                code = ts.main([str(d / "t.jsonl"), str(d / "log"), str(d / "red.jsonl")], env)
            self.assertEqual(code, 0)
            self.assertEqual((d / "log").read_text(encoding="utf-8").strip(),
                             "No bets placed this run.")
            self.assertNotIn("fake-foundry-value", (d / "red.jsonl").read_text(encoding="utf-8"))
            self.assertIn("searches=3", summary.read_text(encoding="utf-8"))

    def test_missing_transcript_still_writes_an_empty_log(self):
        """The null-run detector reads the log afterwards; it must exist."""
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            with contextlib.redirect_stdout(io.StringIO()):
                code = ts.main([str(d / "absent.jsonl"), str(d / "log"), str(d / "red.jsonl")], {})
            self.assertEqual(code, 0)
            self.assertTrue((d / "log").exists())

    def _run_with(self, env):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            (d / "t.jsonl").write_text(_lines(HEALTHY), encoding="utf-8")
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                ts.main([str(d / "t.jsonl"), str(d / "log"), str(d / "red.jsonl")], env)
            return out.getvalue()

    def test_minimum_comes_from_the_environment(self):
        self.assertNotIn("::warning::", self._run_with({"AGENT_MIN_RESEARCH_CALLS": "4"}))
        self.assertIn("::warning::", self._run_with({"AGENT_MIN_RESEARCH_CALLS": "5"}))

    def test_unparseable_minimum_falls_back_to_the_default(self):
        out = self._run_with({"AGENT_MIN_RESEARCH_CALLS": "lots"})
        self.assertIn("::warning::", out)  # 4 < default 5


def _fetch(tid, url):
    return {"type": "tool_use", "id": tid, "name": "WebFetch", "input": {"url": url}}


def _fetch_result(tid, text, is_error=False):
    return {"type": "user", "message": {"content": [
        {"type": "tool_result", "tool_use_id": tid, "content": text, "is_error": is_error}]}}


def _init(sid="s-1"):
    return {"type": "system", "subtype": "init", "session_id": sid,
            "mcp_servers": [{"name": "search", "status": "connected"}]}


def _res(text, is_error=False, sid="s-1", turns=10, ms=60000):
    return dict(_result(text, is_error, turns, ms), session_id=sid)


# Run 25's fetches, as WebFetch answered them (2026-11-05).
RUN25_FETCHES = [
    _init(),
    _assistant(_fetch("f1", "https://abc7.com/post/x/")),
    _fetch_result("f1", "I cannot provide a quote because the web page content provided is only "
                        "a \"Page Not Found\" error page from ABC7.com."),
    _assistant(_fetch("f2", "https://nypost.com/x")),
    _fetch_result("f2", "Claude Code is unable to fetch from nypost.com", is_error=True),
    _assistant(_fetch("f3", "https://www.nbcnews.com/x")),
    _fetch_result("f3", "The server returned HTTP 404 Not Found.  The response body was not retrieved."),
    _assistant(_fetch("f4", "https://justthenews.com/x")),
    _fetch_result("f4", [{"type": "text", "text": "# Trump's Statement on Hegseth\n\nTrump said ... "
                                                  "a 404 further down does not count"}]),
    _res("Run 25 placed no bets."),
]


class DepthTests(unittest.TestCase):
    def test_only_pages_with_content_count(self):
        s = ts.parse(_lines(RUN25_FETCHES))
        self.assertEqual((s.fetches, s.ok_fetches), (4, 1))

    def test_session_id_is_read(self):
        self.assertEqual(ts.parse(_lines(RUN25_FETCHES)).session_id, "s-1")

    def test_thin_finished_run_is_below_the_floor(self):
        self.assertTrue(ts.below_floor(ts.parse(_lines(RUN25_FETCHES)), 12))

    def test_enough_pages_is_not_below_the_floor(self):
        self.assertFalse(ts.below_floor(ts.parse(_lines(RUN25_FETCHES)), 1))

    def test_errored_run_is_not_resumed(self):
        events = RUN25_FETCHES[:-1] + [_res("API Error: 401", is_error=True)]
        self.assertFalse(ts.below_floor(ts.parse(_lines(events)), 12))

    def test_killed_run_is_not_resumed(self):
        self.assertFalse(ts.below_floor(ts.parse(_lines(RUN25_FETCHES[:-1])), 12))

    def test_default_floor_is_twelve(self):
        self.assertEqual(ts.min_ok_fetches_from({}), 12)
        self.assertEqual(ts.min_ok_fetches_from({"AGENT_MIN_OK_FETCHES": "3"}), 3)
        self.assertEqual(ts.min_ok_fetches_from({"AGENT_MIN_OK_FETCHES": "x"}), 12)

    def _depth(self, events, env=None):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            (d / "t.jsonl").write_text(_lines(events), encoding="utf-8")
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                ts.main(["depth", str(d / "t.jsonl"), str(d / "p.md")], env or {})
            prompt = (d / "p.md").read_text(encoding="utf-8") if (d / "p.md").exists() else None
        return dict(l.split("=", 1) for l in out.getvalue().split()), prompt

    def test_depth_prints_shell_assignments_and_writes_the_prompt(self):
        vals, prompt = self._depth(RUN25_FETCHES)
        self.assertEqual(vals, {"SESSION_ID": "s-1", "OK_FETCHES": "1",
                                "MIN_OK_FETCHES": "12", "SHORT": "1"})
        self.assertIn("1 pages opened with content", prompt)
        self.assertIn("Never build a URL by hand", prompt)
        self.assertIn("Do not start a new `## Run` section", prompt)

    def test_depth_writes_no_prompt_above_the_floor(self):
        vals, prompt = self._depth(RUN25_FETCHES, {"AGENT_MIN_OK_FETCHES": "1"})
        self.assertEqual(vals["SHORT"], "0")
        self.assertIsNone(prompt)

    def test_session_id_is_safe_to_eval(self):
        events = [dict(e, session_id="s-1; rm -rf /") if e.get("session_id") else e
                  for e in RUN25_FETCHES]
        vals, _ = self._depth(events)
        self.assertEqual(vals["SESSION_ID"], "s-1rm-rf")

    def test_continuation_prompt_carries_no_side_split(self):
        prompt = ts.continuation_prompt(ts.parse(_lines(RUN25_FETCHES)), 12)
        self.assertNotRegex(prompt, r"\b(YES|NO)\b")


def _news(tid, resolved):
    payload = json.dumps({"query": "q", "results": [], "resolved": resolved})
    return [_assistant({"type": "tool_use", "id": tid, "name": "mcp__search__news_search",
                        "input": {"query": f"q{tid}"}}),
            {"type": "user", "message": {"content": [
                {"type": "tool_result", "tool_use_id": tid,
                 "content": [{"type": "text", "text": payload}]}]}}]


class NewsDecodeTests(unittest.TestCase):
    """search_mcp.py decodes Google News links through an undocumented Google endpoint;
    if it breaks, the agent silently goes back to guessing URLs. The run log says so."""

    def _stats(self, *resolved):
        events = [_init()]
        for i, r in enumerate(resolved):
            events += _news(f"n{i}", r)
        return ts.parse(_lines(events + [_res("done")]))

    def test_decoded_links_add_up_across_searches(self):
        s = self._stats("8/8", "5/8")
        self.assertEqual((s.news_decoded, s.news_attempted), (13, 16))
        self.assertIn("news_urls=13/16", ts.report(s)[0])

    def test_a_broken_decoder_is_flagged(self):
        lines = ts.report(self._stats("0/8", "1/8"))
        self.assertTrue(any("news_search decoded only 1 of 16" in l for l in lines))

    def test_a_healthy_decoder_is_not_flagged(self):
        self.assertFalse(any("decoded only" in l for l in ts.report(self._stats("8/8", "4/8"))))

    def test_too_few_links_are_not_judged(self):
        self.assertFalse(any("decoded only" in l for l in ts.report(self._stats("0/3"))))


class ResumedPassTests(unittest.TestCase):
    def _two_passes(self, second_error=False):
        second = [_init(), _assistant(_fetch("g1", "https://example.com/b")),
                  _fetch_result("g1", "Article text"),
                  _res("API Error: 529 Overloaded" if second_error else "Continued: no bets.",
                       is_error=second_error, turns=5, ms=30000)]
        return ts.parse(_lines(RUN25_FETCHES + second))

    def test_passes_add_up(self):
        s = self._two_passes()
        self.assertEqual((s.passes, s.fetches, s.ok_fetches), (2, 5, 2))
        self.assertEqual((s.num_turns, s.duration_ms), (15, 90000))

    def test_final_text_keeps_every_pass(self):
        text = self._two_passes().final_text
        self.assertIn("Run 25 placed no bets.", text)
        self.assertIn("Continued: no bets.", text)

    def test_resumed_pass_error_is_a_warning_not_a_null_run(self):
        s = self._two_passes(second_error=True)
        self.assertNotIn("API Error", s.final_text)     # the null-run grep reads this
        self.assertFalse(s.is_error)
        self.assertTrue(any("Resumed research pass ended in error" in l for l in ts.report(s)))
        self.assertFalse(ts.below_floor(s, 12))        # an errored pass is not resumed again

    def test_report_shows_pages_with_content_and_passes(self):
        line = ts.report(self._two_passes())[0]
        self.assertIn("ok_fetches=2", line)
        self.assertIn("passes=2", line)


class WorkflowWiringTests(unittest.TestCase):
    def setUp(self):
        root = Path(__file__).resolve().parents[3]
        self.wf = (root / ".github" / "workflows" / "agent-trader-weekly.yml").read_text(encoding="utf-8")

    def test_claude_streams_its_transcript(self):
        call = self.wf[self.wf.index("agent-trader-prompt.md | claude"):]
        call = call[:call.index("|| AGENT_OK=0")]
        self.assertIn("--output-format stream-json", call)
        self.assertIn("--verbose", call)

    def test_reader_runs_before_the_null_run_grep(self):
        self.assertLess(self.wf.index("python transcript_stats.py"),
                        self.wf.index('grep -qiE "API Error'))

    def test_transcript_is_uploaded_on_every_run(self):
        self.assertIn("agent-transcript-${{ github.run_id }}", self.wf)

    def _resume_call(self):
        call = self.wf[self.wf.index("--resume"):]
        return call[:call.index("done")]

    def test_a_thin_run_resumes_the_same_session(self):
        loop = self.wf[self.wf.index("transcript_stats.py depth"):]
        self.assertIn('--resume "$SESSION_ID"', loop[:loop.index("done")])
        self.assertIn("/tmp/agent-continue.md | claude", self.wf)

    def test_the_resumed_pass_has_the_same_tools_and_stream(self):
        first = self.wf[self.wf.index("agent-trader-prompt.md | claude"):]
        first = first[:first.index("|| AGENT_OK=0")]
        resumed = self._resume_call()
        for flag in ('--allowedTools "Bash WebFetch Read Write Edit $SEARCH_TOOLS"',
                     '"${SEARCH_FLAGS[@]}"', "--output-format stream-json",
                     "--permission-mode acceptEdits", '--model "$AGENT_MODEL_ID"'):
            self.assertIn(flag, first)
            self.assertIn(flag, resumed)

    def test_the_resumed_pass_appends_and_keeps_stderr_out_of_the_null_run_grep(self):
        resumed = self._resume_call()
        self.assertIn(">> /tmp/agent-transcript.jsonl", resumed)
        self.assertNotIn("agent-run.err", resumed)

    def test_the_loop_is_bounded_and_runs_before_the_reader(self):
        self.assertIn('-lt "${AGENT_MAX_RESUMES:-2}"', self.wf)
        self.assertLess(self.wf.index("transcript_stats.py depth"),
                        self.wf.index("python transcript_stats.py /tmp/agent-transcript.jsonl"))


if __name__ == "__main__":
    unittest.main()
