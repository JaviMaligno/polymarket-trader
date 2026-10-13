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

Usage:  python transcript_stats.py <transcript.jsonl> <final-log-out> <redacted-out>
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
SECRET_ENV = ("ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_FOUNDRY_RESOURCE", "ANTHROPIC_API_KEY",
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


@dataclass
class Stats:
    tool_counts: Counter = field(default_factory=Counter)
    queries: list[str] = field(default_factory=list)
    searches: int = 0
    fetches: int = 0
    num_turns: int | None = None
    duration_ms: int | None = None
    completed: bool = False
    is_error: bool = False
    final_text: str = ""
    mcp_servers: dict[str, str] = field(default_factory=dict)


def parse(raw: str) -> Stats:
    s = Stats()
    assistant_text: list[str] = []
    for line in raw.splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if not isinstance(ev, dict):
            continue
        if ev.get("type") == "system" and ev.get("subtype") == "init":
            for srv in ev.get("mcp_servers") or []:
                s.mcp_servers[srv.get("name", "?")] = srv.get("status", "?")
        elif ev.get("type") == "assistant":
            for block in (ev.get("message") or {}).get("content") or []:
                if block.get("type") == "text":
                    assistant_text.append(block.get("text", ""))
                elif block.get("type") == "tool_use":
                    name = block.get("name", "?")
                    s.tool_counts[name] += 1
                    if name in SEARCH_TOOLS:
                        s.searches += 1
                        q = (block.get("input") or {}).get("query")
                        if q and q not in s.queries:
                            s.queries.append(q)
                    elif name in FETCH_TOOLS:
                        s.fetches += 1
        elif ev.get("type") == "result":
            s.completed = True
            s.is_error = bool(ev.get("is_error"))
            s.final_text = ev.get("result") or ""
            s.num_turns = ev.get("num_turns")
            s.duration_ms = ev.get("duration_ms")
    if not s.completed:
        # Killed or timed out before the result event: keep what the agent did say.
        s.final_text = "\n".join(t for t in assistant_text if t)
    return s


def min_calls_from(env) -> int:
    try:
        return int(env.get("AGENT_MIN_RESEARCH_CALLS", DEFAULT_MIN_CALLS))
    except (TypeError, ValueError):
        return DEFAULT_MIN_CALLS


def report(s: Stats, min_calls: int = DEFAULT_MIN_CALLS) -> list[str]:
    secs = f"{s.duration_ms / 1000:.0f}s" if s.duration_ms is not None else "?"
    tools = ", ".join(f"{k}={v}" for k, v in sorted(s.tool_counts.items())) or "none"
    lines = [
        f"research: searches={s.searches} fetches={s.fetches} turns={s.num_turns} "
        f"duration={secs} completed={s.completed}",
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
    return lines


def redact(raw: str, env) -> str:
    for name in SECRET_ENV:
        value = env.get(name) or ""
        if len(value) >= MIN_SECRET_LEN:
            raw = raw.replace(value, "***")
    raw = TOKEN_PATTERNS[0].sub("***", raw)
    return TOKEN_PATTERNS[1].sub(r"\1***", raw)


def main(argv: list[str], env=os.environ) -> int:
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
