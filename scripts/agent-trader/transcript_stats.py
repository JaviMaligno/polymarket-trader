#!/usr/bin/env python3
"""Read the decision loop's stream-json transcript: final message, research count, redacted copy.

Until 2026-10-12 the workflow kept only the final message of `claude --print`. Run 21
spent 44 s of agent time (Run 20: ~6 min; the Sonnet 4.6 runs: ~25 min), wrote a
plausible section and placed nothing, and nothing recorded how many searches or fetches
it made — a researched decline and a skimmed one looked the same. The run now streams
its whole transcript and this script turns it into three things:

- the final message, written where the old plain output went, so the null-run grep
  (`API Error|usage limit|...`) keeps matching. Only the agent's own words go there:
  tool results carry web pages, and a page that says "rate limit" is not an API error;
- a research count printed to the run log and the step summary, with a warning when a
  finished run made fewer searches+fetches than AGENT_MIN_RESEARCH_CALLS, or an MCP server failed;
- a copy with secrets redacted, for the artifact. This repo is public and the agent has
  Bash in a checkout whose git config holds a token.

Depth floor (2026-11-05). Two prompt instructions (#347, #352) did not stop research
from shrinking: Runs 22-25 opened 31, 8, 3 and 7 pages, and Run 25 got content from
only 3 of its 7. The `depth` mode counts the pages that came back with content; below
AGENT_MIN_OK_FETCHES it writes a continuation prompt, and the workflow resumes the same
session with it (`claude --resume`). A resumed pass is appended to the same transcript
and starts with its own `init` event, so the transcript is read as a list of passes.

Usage:  python transcript_stats.py <transcript.jsonl> <final-log-out> <redacted-out>
        python transcript_stats.py depth <transcript.jsonl> <continuation-prompt-out>
Exit:   0 always once the arguments are right — this reports, it does not gate.
"""
from __future__ import annotations
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
import json
import os
import re
import sys

SEARCH_TOOLS = {"WebSearch", "mcp__search__web_search", "mcp__search__news_search"}
FETCH_TOOLS = {"WebFetch"}
# Env vars whose VALUES must never reach the artifact. A closed list, not a shape heuristic.
SECRET_ENV = ("ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_FOUNDRY_RESOURCE",
              "ANTHROPIC_API_KEY",
              "GITHUB_TOKEN", "GH_TOKEN")
# GitHub tokens and the basic-auth header actions/checkout writes into .git/config.
TOKEN_PATTERNS = (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}"),
                  re.compile(r"(?i)(authorization:\s*(?:basic|bearer)\s+)\S+"))
MIN_SECRET_LEN = 4
# Searches + fetches below which a finished run is flagged as thin. Provisional: the first
# measured Sonnet 5.5 run (rehearsal, 2026-10-12) made 7 (6 searches, 1 fetch). Revisit once
# a few Monday runs have been counted; override with AGENT_MIN_RESEARCH_CALLS.
DEFAULT_MIN_CALLS = 5
# `init` is emitted while servers are still starting: the 2026-10-12 rehearsal reported the
# search server as `pending` and then made six searches through it.
MCP_OK_STATUSES = {"connected", "pending"}
# Pages opened with content (not 4xx/5xx, not blocked) below which the workflow resumes
# the session. The prompt asks for six candidates, each with its primary sources opened:
# twelve is two pages per candidate. Measured with this counter: Run 22, the last full
# pass, got content from 16 of its 31 fetches; Runs 23, 24 and 25 from 4, 2 and 2.
DEFAULT_MIN_OK_FETCHES = 12
# What WebFetch returns when it got no page. Checked against the start of the result only:
# a real article can mention "404" further down.
FAILED_FETCH = re.compile(r"(?i)HTTP [45]\d\d|unable to fetch|page not found|"
                          r"access denied|403 forbidden|404 not found")
FAILED_FETCH_SPAN = 300
NEWS_TOOL = "mcp__search__news_search"
# search_mcp.py decodes Google News links through an undocumented Google endpoint. Below
# this share of decoded links (once there are enough to judge) the decoder is probably
# broken and the agent is back to hunting publisher URLs with web_search.
MIN_NEWS_DECODE_RATE = 0.5
MIN_NEWS_LINKS_TO_JUDGE = 8


@dataclass
class Stats:
    tool_counts: Counter = field(default_factory=Counter)
    queries: list[str] = field(default_factory=list)
    searches: int = 0
    fetches: int = 0
    ok_fetches: int = 0
    news_decoded: int = 0
    news_attempted: int = 0
    num_turns: int | None = None
    duration_ms: int | None = None
    completed: bool = False      # the LAST pass reached its result event
    is_error: bool = False       # the FIRST pass errored: a null run
    last_is_error: bool = False  # the last pass errored
    final_text: str = ""
    session_id: str | None = None
    passes: int = 0
    resume_errors: list[str] = field(default_factory=list)
    mcp_servers: dict[str, str] = field(default_factory=dict)


def _result_text(content) -> str:
    if isinstance(content, list):
        return " ".join(c.get("text", "") for c in content if isinstance(c, dict))
    return str(content or "")


def parse(raw: str) -> Stats:
    s = Stats()
    assistant_text: list[str] = []   # current pass only
    finals: list[str] = []
    fetch_ids: set[str] = set()
    news_ids: set[str] = set()
    for line in raw.splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if not isinstance(ev, dict):
            continue
        if ev.get("session_id"):
            s.session_id = ev["session_id"]
        if ev.get("type") == "system" and ev.get("subtype") == "init":
            s.passes += 1
            s.completed = False
            assistant_text = []
            for srv in ev.get("mcp_servers") or []:
                s.mcp_servers[srv.get("name", "?")] = srv.get("status", "?")
        elif ev.get("type") == "assistant":
            for block in (ev.get("message") or {}).get("content") or []:
                if block.get("type") == "text":
                    assistant_text.append(block.get("text", ""))
                elif block.get("type") == "tool_use":
                    name = block.get("name", "?")
                    s.tool_counts[name] += 1
                    if name == NEWS_TOOL:
                        news_ids.add(block.get("id"))
                    if name in SEARCH_TOOLS:
                        s.searches += 1
                        q = (block.get("input") or {}).get("query")
                        if q and q not in s.queries:
                            s.queries.append(q)
                    elif name in FETCH_TOOLS:
                        s.fetches += 1
                        fetch_ids.add(block.get("id"))
        elif ev.get("type") == "user":
            content = (ev.get("message") or {}).get("content")
            for block in content if isinstance(content, list) else []:
                if (isinstance(block, dict) and block.get("type") == "tool_result"
                        and block.get("tool_use_id") in news_ids):
                    m = re.search(r'"resolved":\s*"(\d+)/(\d+)"',
                                  _result_text(block.get("content")))
                    if m:
                        s.news_decoded += int(m.group(1))
                        s.news_attempted += int(m.group(2))
                if (isinstance(block, dict) and block.get("type") == "tool_result"
                        and block.get("tool_use_id") in fetch_ids):
                    text = _result_text(block.get("content"))
                    if not block.get("is_error") and text.strip() \
                            and not FAILED_FETCH.search(text[:FAILED_FETCH_SPAN]):
                        s.ok_fetches += 1
        elif ev.get("type") == "result":
            s.passes = max(s.passes, 1)
            first = not finals and not s.resume_errors
            err = bool(ev.get("is_error"))
            text = ev.get("result") or ""
            s.completed, s.last_is_error = True, err
            if first:
                s.is_error = err
                finals.append(text)
            elif err:
                # An error in a resumed pass is reported, not passed to the null-run grep:
                # the first pass already did a run's work.
                s.resume_errors.append(text[:300])
            else:
                finals.append(text)
            s.num_turns = (s.num_turns or 0) + (ev.get("num_turns") or 0)
            s.duration_ms = (s.duration_ms or 0) + (ev.get("duration_ms") or 0)
            assistant_text = []
    if not s.completed and assistant_text:
        # Killed or timed out before the result event: keep what the agent did say.
        finals.append("\n".join(t for t in assistant_text if t))
    s.final_text = "\n\n".join(f for f in finals if f)
    return s


def min_calls_from(env) -> int:
    try:
        return int(env.get("AGENT_MIN_RESEARCH_CALLS", DEFAULT_MIN_CALLS))
    except (TypeError, ValueError):
        return DEFAULT_MIN_CALLS


def min_ok_fetches_from(env) -> int:
    try:
        return int(env.get("AGENT_MIN_OK_FETCHES", DEFAULT_MIN_OK_FETCHES))
    except (TypeError, ValueError):
        return DEFAULT_MIN_OK_FETCHES


def below_floor(s: Stats, min_ok: int) -> bool:
    """Resume only a pass that finished cleanly: an errored or killed one is the null-run
    detector's case, and without a session id there is nothing to resume."""
    return bool(s.session_id) and s.completed and not s.last_is_error and s.ok_fetches < min_ok


CONTINUATION = """\
The harness counted your research so far in this run: {ok} pages opened with content \
({fetches} WebFetch calls) and {searches} searches. The floor for a run is {min_ok} pages \
opened with content, so this run is not finished.

Go back to the filtered candidate set from step 2 and research the candidates you have \
not researched yet, one by one, to the depth step 3 asks for: read the resolution \
criterion, then open the primary sources with WebFetch. Open only URLs a tool returned \
(`news_search` gives each headline's `url`; when it is null, find the article with \
`web_search`). Never build a URL by hand. A candidate you covered at headline level \
earlier counts as not researched.

Every rule from the original instructions still applies. If a candidate clears the bar, \
place it with `record` exactly as before. Then append what you found to this run's \
section at the end of `lessons.md`, under a `### Continued research` heading, with a \
line per candidate and the source that decided it, and end with an updated \
`**Running record:**` line. Do not start a new `## Run` section and do not edit anything \
above the end of the file.
Record each researched decline with `decision_audit.py decline` and merge the additional \
candidate/source coverage with `decision_audit.py coverage`, as the original instructions \
require. Do not count blocked pages or headlines as opened sources.
"""


def continuation_prompt(s: Stats, min_ok: int) -> str:
    return CONTINUATION.format(ok=s.ok_fetches, fetches=s.fetches, searches=s.searches,
                               min_ok=min_ok)


def depth(argv: list[str], env=os.environ) -> int:
    """Print shell assignments for the workflow; write the continuation prompt if short."""
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    transcript, prompt_out = (Path(a) for a in argv)
    raw = transcript.read_text(encoding="utf-8", errors="replace") if transcript.exists() else ""
    s = parse(raw)
    min_ok = min_ok_fetches_from(env)
    short = below_floor(s, min_ok)
    if short:
        prompt_out.write_text(continuation_prompt(s, min_ok), encoding="utf-8")
    sid = s.session_id or ""
    # The session id goes into `eval`: keep only the characters a UUID can hold.
    sid = re.sub(r"[^A-Za-z0-9-]", "", sid)
    print(f"SESSION_ID={sid}\nOK_FETCHES={s.ok_fetches}\nMIN_OK_FETCHES={min_ok}\n"
          f"SHORT={1 if short else 0}")
    return 0


def report(s: Stats, min_calls: int = DEFAULT_MIN_CALLS) -> list[str]:
    secs = f"{s.duration_ms / 1000:.0f}s" if s.duration_ms is not None else "?"
    tools = ", ".join(f"{k}={v}" for k, v in sorted(s.tool_counts.items())) or "none"
    lines = [
        f"research: searches={s.searches} fetches={s.fetches} ok_fetches={s.ok_fetches} "
        f"turns={s.num_turns} duration={secs} passes={s.passes} completed={s.completed} "
        f"news_urls={s.news_decoded}/{s.news_attempted}",
        f"tool calls: {tools}",
        f"distinct queries ({len(s.queries)}):",
        *(f"  - {q}" for q in s.queries),
    ]
    if s.mcp_servers:
        lines.insert(2, "mcp servers: " + ", ".join(f"{k}={v}" for k, v in sorted(s.mcp_servers.items())))
    for name, status in sorted(s.mcp_servers.items()):
        if status not in MCP_OK_STATUSES:
            lines.append(f"::warning::MCP server '{name}' did not connect ({status}) — "
                         "the agent ran without its tools.")
    calls = s.searches + s.fetches
    # An errored run is the null-run detector's case; one warning, not two.
    if s.completed and not s.is_error and calls < min_calls:
        lines.append(f"::warning::Thin research: {calls} searches+fetches, below the minimum "
                     f"of {min_calls} (AGENT_MIN_RESEARCH_CALLS). Read the transcript artifact "
                     "before trusting this week's declines.")
    if (s.news_attempted >= MIN_NEWS_LINKS_TO_JUDGE
            and s.news_decoded < MIN_NEWS_DECODE_RATE * s.news_attempted):
        lines.append(f"::warning::news_search decoded only {s.news_decoded} of "
                     f"{s.news_attempted} Google News links. The decoder in search_mcp.py "
                     "relies on an undocumented Google endpoint and may be broken or "
                     "blocked; the agent is back to finding publisher URLs by hand.")
    for i, err in enumerate(s.resume_errors, 1):
        lines.append(f"::warning::Resumed research pass ended in error ({i}): {err}")
    return lines


def redact(raw: str, env) -> str:
    for name in SECRET_ENV:
        value = env.get(name) or ""
        if len(value) >= MIN_SECRET_LEN:
            raw = raw.replace(value, "***")
    raw = TOKEN_PATTERNS[0].sub("***", raw)
    return TOKEN_PATTERNS[1].sub(r"\1***", raw)


def main(argv: list[str], env=os.environ) -> int:
    if argv and argv[0] == "depth":
        return depth(argv[1:], env)
    if len(argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    transcript, log_out, redacted_out = (Path(a) for a in argv)
    raw = transcript.read_text(encoding="utf-8", errors="replace") if transcript.exists() else ""
    s = parse(raw)
    Path(log_out).write_text(s.final_text + "\n", encoding="utf-8")
    Path(redacted_out).write_text(redact(raw, env), encoding="utf-8")
    lines = report(s, min_calls_from(env))
    print("\n".join(lines))
    summary = env.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as fh:
            fh.write("### Agent research\n\n```\n")
            fh.write("\n".join(l for l in lines if not l.startswith("::")) + "\n```\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
