#!/usr/bin/env python3
"""Append-only guard for lessons.md.

lessons.md is not a log, it is STATE: the whole file goes into every weekly decision
prompt, so whatever it says is what the next run believes. The agent appends its section
with Write/Edit, and on 2026-09-21 that write also altered a line inside Run 17's section
("found it wanting" -> "found it wanted") while appending Run 18. That one was a typo,
and nothing downstream noticed: exit status fine, lessons touched, commit plausible.

The same mechanism can rewrite a past p_hat, a post-mortem, or a rule the agent has since
talked itself out of — and the corrupted version is what the next run learns from. So the
rule: the file as it stood before the run must survive byte-for-byte as a PREFIX of the
file after it. New sections go after.

On a violation the guard restores the prefix and keeps the run's new `## Run N` sections,
rather than failing the run: a week of research is worth keeping, an unreviewed edit to
history is not. When it cannot tell which part is new (no new section), it changes
nothing and says so — a wrong repair is worse than none, and that case wants a human.

Usage:  python lessons_guard.py <before-snapshot> <lessons.md>
Exit:   0 clean · 1 restored (caller should warn) · 2 needs a human
"""
from __future__ import annotations
from dataclasses import dataclass
from pathlib import Path
import re
import sys

RUN_HEADING = re.compile(r"^## Run (\d+)\b", re.MULTILINE)


@dataclass
class Result:
    status: str      # ok | restored | unresolvable | no_baseline
    detail: str = ""

    @property
    def exit_code(self) -> int:
        return {"ok": 0, "no_baseline": 0, "restored": 1, "unresolvable": 2}[self.status]


def _norm(text: str) -> str:
    """Line-ending-insensitive view. A CRLF rewrite of the same prose is not an edit."""
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _read(path: Path) -> str:
    """Exact bytes-as-text: newline="" so the platform cannot translate line endings.

    The guard compares the file to a snapshot of itself taken before a subprocess ran, so
    a translating read would report a mutation on a run that only rewrote CRLF, and a
    translating write would introduce one while "restoring".
    """
    with path.open(encoding="utf-8", newline="") as fh:
        return fh.read()


def _write(path: Path, text: str) -> None:
    with path.open("w", encoding="utf-8", newline="") as fh:
        fh.write(text)


def _first_new_section(after: str, highest_before: int) -> int | None:
    """Index in `after` where the run's own output starts, or None if it wrote none."""
    for m in RUN_HEADING.finditer(after):
        if int(m.group(1)) > highest_before:
            return m.start()
    return None


def _mutated_section(before: str, after: str) -> str:
    """Name the last surviving heading above the first divergence, for the report."""
    i = 0
    for i, (a, b) in enumerate(zip(before, after)):
        if a != b:
            break
    else:
        i = min(len(before), len(after))
    headings = [m.group(0) for m in RUN_HEADING.finditer(before[:i])]
    return headings[-1].removeprefix("## ") if headings else "the file header"


def guard(before_path, after_path) -> Result:
    before_path, after_path = Path(before_path), Path(after_path)
    if not before_path.exists():
        # No baseline means nothing is being asserted. Say that rather than report clean:
        # a guard that passes when it did not run is worse than no guard.
        return Result("no_baseline", "no pre-run snapshot of lessons.md to compare against")
    before = _read(before_path)
    after = _read(after_path) if after_path.exists() else ""

    if _norm(after).startswith(_norm(before)):
        return Result("ok")

    if not after.strip():
        # The run destroyed the file. There is no appendix to separate from the edit, so
        # putting it back whole is unambiguous — and losing the learning history outright
        # is the one outcome worse than losing a week's section.
        _write(after_path, before)
        return Result("restored", "lessons.md was empty or missing after the run; "
                                  "restored the pre-run file in full")

    where = _mutated_section(_norm(before), _norm(after))
    highest = max((int(m.group(1)) for m in RUN_HEADING.finditer(before)), default=0)
    start = _first_new_section(after, highest)
    if start is None:
        return Result(
            "unresolvable",
            f"history changed at {where} and the run appended no new '## Run' section, "
            f"so the new content cannot be separated from the edit — left as written")

    appendix = after[start:]
    sep = "" if before.endswith("\n\n") else ("\n" if before.endswith("\n") else "\n\n")
    _write(after_path, before + sep + appendix)
    kept = ", ".join(m.group(0).removeprefix("## ") for m in RUN_HEADING.finditer(appendix))
    return Result("restored",
                  f"history was edited at {where}; restored the pre-run file and kept "
                  f"the new section(s): {kept}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        raise SystemExit(2)
    r = guard(sys.argv[1], sys.argv[2])
    print(f"lessons-guard: {r.status}" + (f" — {r.detail}" if r.detail else ""))
    raise SystemExit(r.exit_code)
