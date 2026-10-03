#!/usr/bin/env python3
"""Keyless web/news search as an MCP stdio server — the agent's search tool when the
built-in WebSearch cannot be used.

Why: on Foundry, Claude Code's WebSearch forces `tool_choice`, and Sonnet 5.5 rejects
that with `400 tool_choice: type "tool" and "any" are not supported for this model`
(2026-10-03). The Claude Code docs: "The search backend is not configurable. To search
with a different provider, add an MCP server that exposes a search tool."

Pure stdlib, no API keys, so it runs in the same lightweight CI as the rest of the
harness. Two tools:

- web_search(query, max_results): DuckDuckGo HTML, falling back to Bing RSS. Returns the
  publisher URL itself (DDG's redirect is decoded) so a result can be cited and opened.
- news_search(query, max_results): Google News RSS. Returns title, outlet, outlet site
  and publication time — the dated feed the 2026-10-03 rehearsal improvised by hand.
  Its links are Google redirects; to cite a story, find its publisher URL with
  web_search (outlet + headline) and open that.

Protocol: newline-delimited JSON-RPC 2.0 over stdin/stdout (MCP stdio transport).
SEARCH_MCP_FIXTURES='{"ddg": path, "bing": path, "gnews": path}' serves saved
responses instead of the network (tests only).
"""
from __future__ import annotations
import email.utils
import html
import json
import os
import re
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

PROTOCOL_VERSION = "2025-06-18"
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/126.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9"}
DEFAULT_MAX = 10
HARD_MAX = 25


class SearchError(Exception):
    pass


def _fixture_fetch():
    spec = os.environ.get("SEARCH_MCP_FIXTURES")
    if not spec:
        return None
    paths = json.loads(spec)

    def fetch(url):
        key = ("ddg" if "duckduckgo" in url else "gnews" if "news.google" in url
               else "bing" if "bing.com" in url else None)
        if key not in paths:
            raise OSError(f"no fixture for {url}")
        with open(paths[key], encoding="utf-8") as fh:
            return fh.read()
    return fetch


def http_fetch(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.read().decode("utf-8", "replace")


def _text(fragment):
    """HTML fragment -> plain text."""
    return html.unescape(re.sub(r"<[^>]+>", "", fragment or "")).strip()


# ---------------------------------------------------------------- parsers

_DDG_RESULT = re.compile(
    r'class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>(.*?)(?=class="result__a"|\Z)', re.S)
_DDG_SNIPPET = re.compile(r'class="result__snippet"[^>]*>(.*?)</a>', re.S)


def _ddg_target(href):
    href = html.unescape(href)
    if href.startswith("//"):
        href = "https:" + href
    q = urllib.parse.urlparse(href)
    if q.netloc.endswith("duckduckgo.com") and q.path.startswith("/l/"):
        target = urllib.parse.parse_qs(q.query).get("uddg", [""])[0]
        return target or None
    return href


def parse_ddg(page):
    rows = []
    for href, title, rest in _DDG_RESULT.findall(page):
        url = _ddg_target(href)
        # Sponsored results go through duckduckgo.com/y.js; never cite an ad.
        if not url or "duckduckgo.com/y.js" in url:
            continue
        snip = _DDG_SNIPPET.search(rest)
        rows.append({"title": _text(title), "url": url,
                     "snippet": _text(snip.group(1)) if snip else ""})
    return rows


def _rss_date(value):
    try:
        return email.utils.parsedate_to_datetime(value).isoformat()
    except (TypeError, ValueError):
        return value or None


def parse_bing_rss(xml):
    rows = []
    for item in ET.fromstring(xml).iter("item"):
        rows.append({"title": (item.findtext("title") or "").strip(),
                     "url": (item.findtext("link") or "").strip(),
                     "snippet": _text(item.findtext("description")),
                     "published": _rss_date(item.findtext("pubDate"))})
    return [r for r in rows if r["url"]]


def parse_gnews(xml):
    rows = []
    for item in ET.fromstring(xml).iter("item"):
        src = item.find("source")
        outlet = (src.text or "").strip() if src is not None else ""
        title = (item.findtext("title") or "").strip()
        if outlet and title.endswith(" - " + outlet):
            title = title[: -len(" - " + outlet)]
        rows.append({"title": title, "source": outlet,
                     "source_site": src.get("url") if src is not None else None,
                     "published": _rss_date(item.findtext("pubDate")),
                     "google_news_link": (item.findtext("link") or "").strip()})
    return rows


# ---------------------------------------------------------------- tools

def _clamp(n):
    try:
        n = int(n)
    except (TypeError, ValueError):
        n = DEFAULT_MAX
    return max(1, min(HARD_MAX, n))


def _first_working(query, backends, max_results, fetch):
    errors = []
    for name, url, parse in backends:
        try:
            rows = parse(fetch(url))
        except Exception as exc:  # network, HTTP status, unparseable page
            errors.append(f"{name}: {type(exc).__name__}: {exc}")
            continue
        if rows:
            return {"query": query, "backend": name, "results": rows[:_clamp(max_results)]}
        errors.append(f"{name}: no results (blocked or captcha?)")
    raise SearchError("all search backends failed — " + "; ".join(errors))


def web_search(query, max_results=DEFAULT_MAX, fetch=None):
    fetch = fetch or _fixture_fetch() or http_fetch
    q = urllib.parse.quote_plus(query)
    return _first_working(query, [
        ("duckduckgo", f"https://html.duckduckgo.com/html/?q={q}", parse_ddg),
        ("bing", f"https://www.bing.com/search?q={q}&format=rss", parse_bing_rss),
    ], max_results, fetch)


def news_search(query, max_results=15, fetch=None):
    fetch = fetch or _fixture_fetch() or http_fetch
    q = urllib.parse.quote_plus(query)
    return _first_working(query, [
        ("google_news", f"https://news.google.com/rss/search?q={q}&hl=en-US&gl=US&ceid=US:en",
         parse_gnews),
    ], max_results, fetch)


TOOLS = {
    "web_search": (web_search, {
        "description": "Search the web (DuckDuckGo, Bing fallback). Returns title, the "
                       "publisher URL itself and a snippet. Open a result with WebFetch "
                       "before relying on it.",
        "inputSchema": {"type": "object", "properties": {
            "query": {"type": "string"},
            "max_results": {"type": "integer", "minimum": 1, "maximum": HARD_MAX}},
            "required": ["query"]}}),
    "news_search": (news_search, {
        "description": "Search recent news (Google News RSS). Returns headline, outlet, "
                       "outlet site and publication time, newest relevant first. Links are "
                       "Google redirects: to cite a story, find its publisher URL with "
                       "web_search (outlet + headline) and open that.",
        "inputSchema": {"type": "object", "properties": {
            "query": {"type": "string"},
            "max_results": {"type": "integer", "minimum": 1, "maximum": HARD_MAX}},
            "required": ["query"]}}),
}


# ---------------------------------------------------------------- JSON-RPC

def handle(msg):
    method, mid = msg.get("method"), msg.get("id")
    if mid is None:
        return None  # notification (e.g. notifications/initialized)
    if method == "initialize":
        asked = (msg.get("params") or {}).get("protocolVersion")
        result = {"protocolVersion": asked or PROTOCOL_VERSION,
                  "capabilities": {"tools": {}},
                  "serverInfo": {"name": "agent-trader-search", "version": "1.0"}}
    elif method == "ping":
        result = {}
    elif method == "tools/list":
        result = {"tools": [dict(name=n, **spec) for n, (_, spec) in TOOLS.items()]}
    elif method == "tools/call":
        params = msg.get("params") or {}
        name, args = params.get("name"), params.get("arguments") or {}
        if name not in TOOLS:
            return _reply(mid, _tool_error(f"unknown tool {name!r}"))
        try:
            out = TOOLS[name][0](args["query"], args.get("max_results", DEFAULT_MAX))
            result = {"content": [{"type": "text",
                                   "text": json.dumps(out, ensure_ascii=False)}]}
        except (KeyError, SearchError) as exc:
            result = _tool_error(str(exc))
    else:
        return {"jsonrpc": "2.0", "id": mid,
                "error": {"code": -32601, "message": f"method not found: {method}"}}
    return _reply(mid, result)


def _tool_error(text):
    return {"content": [{"type": "text", "text": text}], "isError": True}


def _reply(mid, result):
    return {"jsonrpc": "2.0", "id": mid, "result": result}


def main():
    out = sys.stdout
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            resp = {"jsonrpc": "2.0", "id": None,
                    "error": {"code": -32700, "message": "parse error"}}
        else:
            resp = handle(msg)
        if resp is not None:
            out.write(json.dumps(resp, ensure_ascii=False) + "\n")
            out.flush()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stdin.reconfigure(encoding="utf-8")
    main()
