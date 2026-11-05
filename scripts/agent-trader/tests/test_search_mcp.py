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


class PublisherUrlTests(unittest.TestCase):
    """Run 25 (2026-11-05) only had Google redirects, built publisher URLs by hand and
    four of its seven fetches failed. news_search now decodes each redirect."""

    def _fetch(self, url):
        return fixture("gnews_article.html") if "/articles/" in url else fixture("gnews.xml")

    def test_batch_answer_gives_the_publisher_url(self):
        self.assertEqual(search_mcp.parse_gnews_batch(fixture("gnews_batch.txt")),
                         "https://www.cnn.com/2026/11/04/politics/pete-hegseth-impeachment-trump")

    def test_redirect_is_decoded_with_the_page_signature(self):
        sent = {}

        def post(url, data):
            sent["url"], sent["data"] = url, data.decode()
            return fixture("gnews_batch.txt")
        link = "https://news.google.com/rss/articles/CBMiABC?oc=5"
        url = search_mcp.resolve_gnews(link, self._fetch, post)
        self.assertTrue(url.startswith("https://www.cnn.com/"))
        self.assertEqual(sent["url"], search_mcp.GNEWS_BATCH)
        self.assertIn("CBMiABC", sent["data"])                       # the article id
        self.assertIn("AdwtSYPD3NKqmwVZsA3KQqK_JXYS", sent["data"])  # the page signature
        self.assertIn("1793911499", sent["data"])                    # the page timestamp

    def test_every_news_result_gets_a_url(self):
        out = search_mcp.news_search("q", fetch=self._fetch,
                                     post=lambda u, d: fixture("gnews_batch.txt"))
        self.assertEqual(len(out["results"]), 3)
        for row in out["results"]:
            self.assertTrue(row["url"].startswith("https://www.cnn.com/"))
            self.assertIn("news.google.com", row["google_news_link"])

    def test_a_link_that_does_not_decode_is_null_not_an_error(self):
        def post(url, data):
            raise OSError("429")
        out = search_mcp.news_search("q", fetch=self._fetch, post=post)
        self.assertEqual([r["url"] for r in out["results"]], [None, None, None])

    def test_a_page_without_signature_is_null(self):
        out = search_mcp.news_search(
            "q", fetch=lambda u: "<html></html>" if "/articles/" in u else fixture("gnews.xml"),
            post=lambda u, d: self.fail("must not post without a signature"))
        self.assertTrue(all(r["url"] is None for r in out["results"]))

    def test_search_reports_how_many_links_it_decoded(self):
        out = search_mcp.news_search("q", fetch=self._fetch,
                                     post=lambda u, d: fixture("gnews_batch.txt"))
        self.assertEqual(out["resolved"], "3/3")

    def test_only_the_first_results_are_decoded(self):
        rows = [{"google_news_link": f"https://news.google.com/rss/articles/A{i}"}
                for i in range(12)]
        posts = []

        def post(url, data):
            posts.append(1)
            return fixture("gnews_batch.txt")
        decoded, attempted = search_mcp.add_publisher_urls(rows, self._fetch, post)
        self.assertEqual((decoded, attempted, len(posts)), (8, 8, 8))
        self.assertTrue(all(r["url"] for r in rows[:8]))
        self.assertTrue(all(r["url"] is None for r in rows[8:]))

    def test_an_http_error_from_google_stops_decoding_the_search(self):
        import urllib.error
        rows = [{"google_news_link": f"https://news.google.com/rss/articles/A{i}"}
                for i in range(8)]
        posts = []

        def post(url, data):
            posts.append(1)
            raise urllib.error.HTTPError(url, 429, "Too Many Requests", None, None)
        old = search_mcp.RESOLVE_WORKERS
        search_mcp.RESOLVE_WORKERS = 1   # sequential, so the count is exact
        try:
            decoded, attempted = search_mcp.add_publisher_urls(rows, self._fetch, post)
        finally:
            search_mcp.RESOLVE_WORKERS = old
        self.assertEqual((decoded, attempted), (0, 8))
        self.assertEqual(len(posts), 1)

    def test_tool_description_forbids_hand_built_urls(self):
        desc = search_mcp.TOOLS["news_search"][1]["description"]
        self.assertIn("`url`", desc)
        self.assertIn("Never build a URL by hand", desc)


class ProtocolTests(unittest.TestCase):
    """Spawn the server exactly as Claude Code does (stdio, newline-delimited JSON-RPC)."""

    def _session(self, *messages):
        env_fixture = json.dumps({"ddg": str(FIX / "ddg.html"), "gnews": str(FIX / "gnews.xml"),
                                  "bing": str(FIX / "bing.xml"),
                                  "gnews_article": str(FIX / "gnews_article.html"),
                                  "gnews_batch": str(FIX / "gnews_batch.txt")})
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
        self.assertTrue(payload["results"][0]["url"].startswith("https://www.cnn.com/"))
        self.assertTrue(by_id[4]["result"]["isError"])


if __name__ == "__main__":
    unittest.main()
