#!/usr/bin/env python3
"""Tests for the append-only guard on lessons.md.

lessons.md is not a log, it is STATE: the whole file is injected into every weekly
decision prompt. The agent appends its `## Run N` section to it with Write/Edit, and on
2026-09-21 that write also silently altered a line inside Run 17's section
("found it wanting" -> "found it wanted"). That one was a typo. The same mechanism can
rewrite a past `p_hat`, a past post-mortem, or a rule the agent now disagrees with, and
nothing downstream would notice: the run looks healthy, the commit is a plausible diff,
and the corrupted history is what the NEXT run learns from.

So: everything that was in the file before the run must still be there, byte for byte,
as a prefix. The new section goes after it. When a run violates that, the guard puts the
old prefix back and keeps the new section, rather than failing the run — the week's
research is worth keeping, the mutation is not.
"""
from __future__ import annotations
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import lessons_guard  # noqa: E402

BEFORE = """# Lessons

## Run 16 — 2026-09-07
Bet 15 recorded. p_hat 0.11.

## Run 17 — 2026-09-14
A rapid spike-and-crash is price discovery at high speed.
"""

APPENDED = BEFORE + """
## Run 18 — 2026-09-21
Bet 15 lost. The sibling check is not optional.
"""


class GuardTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.before = Path(self._tmp.name) / "before.md"
        self.after = Path(self._tmp.name) / "lessons.md"
        self.before.write_text(BEFORE, encoding="utf-8")

    def tearDown(self):
        self._tmp.cleanup()

    def _run(self):
        return lessons_guard.guard(self.before, self.after)

    def test_a_clean_append_is_untouched(self):
        self.after.write_text(APPENDED, encoding="utf-8")
        r = self._run()
        self.assertEqual(r.status, "ok")
        self.assertEqual(self.after.read_text(encoding="utf-8"), APPENDED)

    def test_an_edit_to_a_past_section_is_reverted_and_the_new_one_kept(self):
        """The 2026-09-21 case: a typo introduced into Run 17 while appending Run 18."""
        self.after.write_text(
            APPENDED.replace("found it wanting", "found it wanted")
                    .replace("price discovery at high speed",
                             "price discovery at high SPEED"),
            encoding="utf-8")
        r = self._run()
        self.assertEqual(r.status, "restored")
        out = self.after.read_text(encoding="utf-8")
        self.assertTrue(out.startswith(BEFORE))           # history byte-for-byte back
        self.assertIn("The sibling check is not optional.", out)   # new work kept
        self.assertNotIn("high SPEED", out)

    def test_a_deleted_past_section_is_restored(self):
        truncated = BEFORE.split("## Run 17")[0] + """
## Run 18 — 2026-09-21
Bet 15 lost.
"""
        self.after.write_text(truncated, encoding="utf-8")
        r = self._run()
        self.assertEqual(r.status, "restored")
        out = self.after.read_text(encoding="utf-8")
        self.assertIn("## Run 17", out)
        self.assertIn("Bet 15 lost.", out)

    def test_a_run_that_wrote_nothing_new_is_reported_not_rewritten(self):
        """No new `## Run` section: there is no appendix to separate, so don't guess."""
        self.after.write_text(BEFORE.replace("p_hat 0.11", "p_hat 0.31"),
                              encoding="utf-8")
        r = self._run()
        self.assertEqual(r.status, "unresolvable")
        # The file is left exactly as the agent left it — a wrong repair is worse than
        # none, and this is the case a human has to look at.
        self.assertIn("p_hat 0.31", self.after.read_text(encoding="utf-8"))

    def test_an_unchanged_file_is_ok(self):
        self.after.write_text(BEFORE, encoding="utf-8")
        self.assertEqual(self._run().status, "ok")

    def test_a_missing_before_snapshot_cannot_silently_pass(self):
        """No baseline means no guarantee; say so rather than report a clean run."""
        self.before.unlink()
        self.after.write_text(APPENDED, encoding="utf-8")
        self.assertEqual(self._run().status, "no_baseline")

    def test_a_vanished_lessons_file_is_restored_whole(self):
        r = self._run()
        self.assertEqual(r.status, "restored")
        self.assertEqual(self.after.read_text(encoding="utf-8"), BEFORE)

    def test_multiple_new_sections_are_all_kept(self):
        two = APPENDED + """
## Run 19 — 2026-09-28
Another one.
"""
        self.after.write_text(two.replace("found it wanting", "found it wanted"),
                              encoding="utf-8")
        self._run()
        out = self.after.read_text(encoding="utf-8")
        self.assertIn("## Run 18", out)
        self.assertIn("## Run 19", out)
        self.assertTrue(out.startswith(BEFORE))

    def test_the_report_names_what_changed(self):
        self.after.write_text(APPENDED.replace("p_hat 0.11", "p_hat 0.31"),
                              encoding="utf-8")
        r = self._run()
        self.assertEqual(r.status, "restored")
        self.assertIn("Run 16", r.detail)     # the section that was mutated

    def test_crlf_in_the_agents_write_is_not_treated_as_a_mutation(self):
        """A Windows-style rewrite of the same text is not a history edit."""
        # write_bytes, not write_text: on Windows write_text translates the \n it is
        # handed into \r\n, so the CRLF text would land as \r\r\n and the test would be
        # exercising the platform rather than the guard.
        self.after.write_bytes(APPENDED.replace("\n", "\r\n").encode("utf-8"))
        self.assertEqual(self._run().status, "ok")


class WorkflowExitCodeTests(unittest.TestCase):
    """The guard's non-zero exits are reports, not failures.

    The decision step runs under `bash -e`. On 2026-10-12 a rehearsal's agent titled its
    section `## Run 21 Summary`; the guard exited 2 and `-e` killed the step on the spot —
    before the `case` that was meant to warn, before the entry audit and before the
    commit. Exit 1 ("restored", the case the guard exists for) did the same. A week of
    research would have died the first time the agent edited history.
    """

    def _guard_block(self) -> str:
        root = Path(__file__).resolve().parents[3]
        wf = (root / ".github" / "workflows" / "agent-trader-weekly.yml").read_text(encoding="utf-8")
        lines = wf.replace("\r\n", "\n").split("\n")
        start = next(i for i, l in enumerate(lines) if "python lessons_guard.py" in l)
        end = next(i for i in range(start, len(lines)) if lines[i].strip() == "esac")
        return "\n".join(l.strip() for l in lines[start:end + 1])

    @unittest.skipUnless(shutil.which("bash"), "needs bash")
    def test_step_survives_every_guard_exit_under_bash_e(self):
        for code, expect in ((0, None), (1, "::warning::"), (2, "::warning::")):
            with self.subTest(code=code):
                # A shell function stands in for the guard: it exits with `code`.
                script = (f"python() {{ return {code}; }}\n"
                          + self._guard_block() + "\necho STEP_CONTINUED\n")
                # Script on stdin, not argv: argv quoting differs between bash builds.
                out = subprocess.run(["bash", "-e", "-s"], input=script.encode("utf-8"),
                                     capture_output=True, timeout=30)
                out = subprocess.CompletedProcess(out.args, out.returncode,
                                                  out.stdout.decode("utf-8", "replace"),
                                                  out.stderr.decode("utf-8", "replace"))
                self.assertEqual(out.returncode, 0, out.stderr)
                self.assertIn("STEP_CONTINUED", out.stdout)
                if expect:
                    self.assertIn(expect, out.stdout)
                else:
                    self.assertNotIn("::warning::", out.stdout)


if __name__ == "__main__":
    unittest.main()
