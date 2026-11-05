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
- news_search(query, max_results): Google News RSS. Returns title, outlet, outlet site,
  publication time and `url`, the publisher's own article URL. The RSS links are Google
  redirects that WebFetch cannot follow, so each one is decoded here (resolve_gnews).
  Run 25 (2026-11-05) had only the redirects, built publisher URLs by hand, and four of
  its seven fetches failed (404 or blocked).

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
import threading
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor

PROTOCOL_VERSION = "2025-06-18"
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/126.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9"}
DEFAULT_MAX = 10
HARD_MAX = 25
GNEWS_BATCH = "https://news.google.com/_/DotsSplashUi/data/batchexecute"
RESOLVE_WORKERS = 5
RESOLVE_TIMEOUT = 8
# batchexecute is Google's internal, undocumented endpoint, at two requests per link.
# Decode only the first results of each search, and stop decoding that search at the
# first HTTP error from Google, so the decoder can never get the news search itself
# blocked. The tool reports how many links it decoded (`resolved`) and transcript_stats
# warns when the rate drops: if Google changes the endpoint, the weekly review sees it.
RESOLVE_MAX = 8


class SearchError(Exception):
    pass


def _fixture_fetch():
    spec = os.environ.get("SEARCH_MCP_FIXTURES")
    if not spec:
        return None
    paths = json.loads(spec)

    def fetch(url):
        key = ("ddg" if "duckduckgo" in url
               else "gnews_article" if "news.google" in url and "/articles/" in url
               else "gnews" if "news.google" in url
               else "bing" if "bing.com" in url else None)
        if key not in paths:
            raise OSError(f"no fixture for {url}")
        with open(paths[key], encoding="utf-8") as fh:
            return fh.read()
    return fetch


def _fixture_post():
    spec = os.environ.get("SEARCH_MCP_FIXTURES")
    if not spec:
        return None
    paths = json.loads(spec)

    def post(url, data):
        if "gnews_batch" not in paths:
            raise OSError(f"no fixture for POST {url}")
        with open(paths["gnews_batch"], encoding="utf-8") as fh:
            return fh.read()
    return post


def http_fetch(url, timeout=20):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", "replace")


def http_post(url, data, timeout=RESOLVE_TIMEOUT):
    req = urllib.request.Request(url, data=data, headers={
        **UA, "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
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


# ---------------------------------------------------------------- Google News links

_GN_SIG = re.compile(r'data-n-a-sg="([^"]+)"')
_GN_TS = re.compile(r'data-n-a-ts="([^"]+)"')


def gnews_batch_body(article_id, ts, sig):
    """The form body Google News' own page posts to turn an article id into its URL."""
    inner = ["garturlreq",
             [["X", "X", ["X", "X"], None, None, 1, 1, "US:en", None, 1, None, None, None,
               None, None, 0, 1], "X", "X", 1, [1, 1, 1], 1, 1, None, 0, 0, None, 0],
             article_id, int(ts), sig]
    req = [[["Fbv4je", json.dumps(inner), None, "generic"]]]
    return urllib.parse.urlencode({"f.req": json.dumps(req)}).encode()


def parse_gnews_batch(text):
    """batchexecute answer -> publisher URL. The body is `)]}'`, a blank line, then JSON."""
    rows = json.loads(text.split("\n\n", 1)[1])
    for row in rows:
        if isinstance(row, list) and len(row) > 2 and row[0] == "wrb.fr" and row[2]:
            url = json.loads(row[2])[1]
            if isinstance(url, str) and url.startswith("http"):
                return url
    return None


def resolve_gnews(link, fetch, post, stop=None):
    """Google News redirect -> publisher URL, or None when it cannot be decoded.

    The article id is no longer a base64 of the URL and the redirect is done in
    JavaScript, so neither decoding nor following it works (checked 2026-11-05). The
    article page carries a signature and a timestamp; posting them with the id to
    batchexecute returns the URL. Any failure gives None: one link that does not decode
    must not fail the search. An HTTP error from Google sets `stop`, and no further link
    of the search is tried.
    """
    if stop is not None and stop.is_set():
        return None
    try:
        article_id = urllib.parse.urlparse(link).path.rstrip("/").split("/")[-1]
        page = fetch(link)
        sig, ts = _GN_SIG.search(page), _GN_TS.search(page)
        if not (article_id and sig and ts):
            return None
        return parse_gnews_batch(post(GNEWS_BATCH,
                                      gnews_batch_body(article_id, ts.group(1), sig.group(1))))
    except urllib.error.HTTPError:  # 403/429/5xx: Google is pushing back
        if stop is not None:
            stop.set()
        return None
    except Exception:  # network, layout change
        return None


def add_publisher_urls(rows, fetch, post, limit=RESOLVE_MAX):
    """Set `url` on every row (None past `limit`); return (decoded, attempted)."""
    stop = threading.Event()
    links = [r.get("google_news_link") or "" for r in rows[:limit]]
    with ThreadPoolExecutor(max_workers=RESOLVE_WORKERS) as pool:
        urls = list(pool.map(lambda l: resolve_gnews(l, fetch, post, stop) if l else None,
                             links))
    urls += [None] * (len(rows) - len(urls))
    for row, url in zip(rows, urls):
        row["url"] = url
    return sum(1 for u in urls if u), len(links)


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


def news_search(query, max_results=15, fetch=None, post=None):
    fetch = fetch or _fixture_fetch() or http_fetch
    post = post or _fixture_post() or http_post
    resolve_fetch = ((lambda u: http_fetch(u, timeout=RESOLVE_TIMEOUT))
                     if fetch is http_fetch else fetch)
    q = urllib.parse.quote_plus(query)
    out = _first_working(query, [
        ("google_news", f"https://news.google.com/rss/search?q={q}&hl=en-US&gl=US&ceid=US:en",
         parse_gnews),
    ], max_results, fetch)
    decoded, attempted = add_publisher_urls(out["results"], resolve_fetch, post)
    out["resolved"] = f"{decoded}/{attempted}"
    return out


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
                       "outlet site, publication time and `url`, the publisher's own "
                       "article URL: open it with WebFetch. `url` is decoded for the first "
                       "8 results only and is null when it could not be decoded; then find "
                       "the article with web_search (outlet + headline). Never build a URL "
                       "by hand.",
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
