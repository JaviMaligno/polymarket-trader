#!/usr/bin/env python3
"""The search MCP server: the agent's web search when the built-in WebSearch is unusable.

2026-10-03: on Foundry, Claude Code's WebSearch forces `tool_choice`, which Sonnet 5.5
rejects with a 400 — researcher and reviewer both lost search and fell back to guessing
RSS URLs. search_mcp.py is a stdlib-only MCP stdio server over keyless backends. These
tests pin the parsers against real (trimmed) responses saved on 2026-10-03, the backend
fallback, and the JSON-RPC handshake as Claude Code speaks it.
"""
from __future__ import annotations
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
FIX = Path(__file__).resolve().parent / "fixtures"
sys.path.insert(0, str(HERE))

import search_mcp  # noqa: E402


def fixture(name):
    return (FIX / name).read_text(encoding="utf-8")


class ParserTests(unittest.TestCase):
    def test_ddg_results_carry_the_publisher_url_not_the_redirect(self):
        rows = search_mcp.parse_ddg(fixture("ddg.html"))
        self.assertGreaterEqual(len(rows), 2)
        self.assertEqual(rows[0]["url"], "https://en.wikipedia.org/wiki/Naval_blockade_of_iran")
        self.assertIn("blockade", rows[0]["title"].lower())
        self.assertIn("2026", rows[0]["snippet"])
        for r in rows:
            self.assertNotIn("duckduckgo.com/l/", r["url"])
            self.assertNotIn("<b>", r["snippet"])

    def test_bing_rss_results(self):
        rows = search_mcp.parse_bing_rss(fixture("bing.xml"))
        self.assertGreaterEqual(len(rows), 2)
        self.assertTrue(rows[0]["url"].startswith("https://"))
        self.assertTrue(rows[0]["title"])

    def test_news_items_carry_date_and_outlet(self):
        rows = search_mcp.parse_gnews(fixture("gnews.xml"))
        self.assertEqual(len(rows), 3)
        first = rows[0]
        self.assertEqual(first["source"], "CBS News")
        self.assertEqual(first["source_site"], "https://www.cbsnews.com")
        self.assertTrue(first["published"].startswith("2026-10-02"))
        # The outlet suffix Google appends to titles is redundant with `source`.
        self.assertFalse(first["title"].endswith("- CBS News"))


class FallbackTests(unittest.TestCase):
    def test_web_search_falls_back_when_the_first_backend_fails(self):
        def fetch(url):
            if "duckduckgo" in url:
                raise OSError("blocked")
            return fixture("bing.xml")
        out = search_mcp.web_search("iran blockade", fetch=fetch)
        self.assertEqual(out["backend"], "bing")
        self.assertTrue(out["results"])

    def test_empty_first_backend_is_a_failure_too(self):
        """A captcha page parses to zero results; that must not end the search."""
        def fetch(url):
            return "<html>captcha</html>" if "duckduckgo" in url else fixture("bing.xml")
        self.assertEqual(search_mcp.web_search("q", fetch=fetch)["backend"], "bing")

    def test_all_backends_failing_is_an_error_not_an_empty_answer(self):
        def fetch(url):
            raise OSError("down")
        with self.assertRaises(search_mcp.SearchError):
            search_mcp.web_search("q", fetch=fetch)

    def test_max_results_is_honoured(self):
        out = search_mcp.news_search("q", max_results=2, fetch=lambda u: fixture("gnews.xml"))
        self.assertEqual(len(out["results"]), 2)


class ProtocolTests(unittest.TestCase):
    """Spawn the server exactly as Claude Code does (stdio, newline-delimited JSON-RPC)."""

    def _session(self, *messages):
        env_fixture = json.dumps({"ddg": str(FIX / "ddg.html"), "gnews": str(FIX / "gnews.xml"),
                                  "bing": str(FIX / "bing.xml")})
        proc = subprocess.run(
            [sys.executable, str(HERE / "search_mcp.py")],
            input="".join(json.dumps(m) + "\n" for m in messages),
            capture_output=True, text=True, encoding="utf-8", timeout=30,
            env=dict(os.environ, SEARCH_MCP_FIXTURES=env_fixture))
        return [json.loads(l) for l in proc.stdout.splitlines() if l.strip()]

    def test_handshake_list_and_call(self):
        out = self._session(
            {"jsonrpc": "2.0", "id": 1, "method": "initialize",
             "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                        "clientInfo": {"name": "t", "version": "0"}}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/call",
             "params": {"name": "news_search", "arguments": {"query": "iran"}}},
            {"jsonrpc": "2.0", "id": 4, "method": "tools/call",
             "params": {"name": "nope", "arguments": {}}},
        )
        by_id = {m["id"]: m for m in out}
        self.assertEqual(sorted(by_id), [1, 2, 3, 4])   # the notification gets no reply
        self.assertEqual(by_id[1]["result"]["protocolVersion"], "2025-06-18")
        self.assertEqual({t["name"] for t in by_id[2]["result"]["tools"]},
                         {"web_search", "news_search"})
        payload = json.loads(by_id[3]["result"]["content"][0]["text"])
        self.assertEqual(payload["results"][0]["source"], "CBS News")
        self.assertTrue(by_id[4]["result"]["isError"])


if __name__ == "__main__":
    unittest.main()
