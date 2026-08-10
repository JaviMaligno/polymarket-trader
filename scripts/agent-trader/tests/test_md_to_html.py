"""Fidelity tests for the email's Markdown renderer.

The weekly email is the artefact a human actually reads, and its body is whatever the last
`## Run` / `### Review correction` section of lessons.md happens to contain. Nothing constrains
how that section is written: it is authored by an LLM one week and by the audit the next.

The 2026-08-10 integration check caught the failure mode this file exists to prevent — the audit
correction was hard-wrapped at ~100 columns, and the line-based renderer emitted 10 literal `**`,
24 literal `*`, 11 `&gt;` blockquote lines and 14 fragmented `<ul>` blocks. No exception, no lost
text: silent fidelity loss in the one output nobody re-reads. So the contract asserted here is
"an inline span survives a hard line wrap", not "these exact glyphs map to these exact tags".
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent_trader import _md_to_html  # noqa: E402


class TestInlineSpansSurviveWrapping(unittest.TestCase):
    def test_bold_spanning_a_hard_wrap_is_rendered(self):
        html = _md_to_html("**Rule 1 (operative): in any market whose payout\ndepends on a multi-party agreement, enumerate every condition.**")
        self.assertNotIn("**", html)
        self.assertIn("<strong>", html)
        self.assertIn("multi-party agreement", html)

    def test_wrapped_paragraph_becomes_one_paragraph(self):
        html = _md_to_html("first physical line\nsecond physical line\nthird physical line")
        self.assertEqual(html.count("<p"), 1)
        self.assertIn("first physical line second physical line third physical line", html)

    def test_blank_line_separates_paragraphs(self):
        html = _md_to_html("one\n\ntwo")
        self.assertEqual(html.count("<p"), 2)

    def test_code_span_across_a_wrap(self):
        html = _md_to_html("the field is `my_prob_yes`\nand it is read from bets.jsonl")
        self.assertIn("<code>my_prob_yes</code>", html)
        self.assertEqual(html.count("<p"), 1)


class TestListContinuations(unittest.TestCase):
    def test_wrapped_list_item_stays_inside_one_li(self):
        html = _md_to_html("- a bullet whose text is long enough\n  that it wraps onto a second line\n- a second bullet")
        self.assertEqual(html.count("<ul"), 1)
        self.assertEqual(html.count("</ul>"), 1)
        self.assertEqual(html.count("<li>"), 2)
        self.assertIn("long enough that it wraps onto a second line", html)

    def test_bold_spanning_a_wrap_inside_a_list_item(self):
        html = _md_to_html("- **a bolded bullet that\n  wraps mid-span**")
        self.assertNotIn("**", html)
        self.assertIn("<strong>", html)

    def test_numbered_items_do_not_fragment(self):
        html = _md_to_html("1. first item\n   continued here\n2. second item")
        self.assertEqual(html.count("<ul"), 1)
        self.assertEqual(html.count("<li>"), 2)


class TestBlockquotes(unittest.TestCase):
    def test_quoted_criterion_is_a_blockquote_not_an_escaped_gt(self):
        html = _md_to_html("> All listed countries must announce their acceptance\n> of the same qualifying diplomatic agreement.")
        self.assertIn("<blockquote", html)
        self.assertNotIn("&gt; All listed", html)
        self.assertIn("acceptance of the same qualifying", html)

    def test_blockquote_closes_before_a_following_paragraph(self):
        html = _md_to_html("> quoted line\n\nplain paragraph")
        self.assertIn("</blockquote>", html)
        self.assertLess(html.index("</blockquote>"), html.index("plain paragraph"))


class TestItalics(unittest.TestCase):
    def test_single_asterisk_italic_is_rendered(self):
        html = _md_to_html("the market prices a *prospective* agreement")
        self.assertIn("<em>prospective</em>", html)
        self.assertNotIn("*", html)

    def test_bold_is_not_eaten_by_the_italic_rule(self):
        html = _md_to_html("**bold** and *italic* together")
        self.assertIn("<strong>bold</strong>", html)
        self.assertIn("<em>italic</em>", html)

    def test_a_bare_asterisk_is_left_alone(self):
        html = _md_to_html("2 * 3 = 6")
        self.assertIn("2 * 3 = 6", html)


class TestUnchangedBehaviour(unittest.TestCase):
    """The regressions the renderer already handled must keep working."""

    def test_headers(self):
        html = _md_to_html("## Run 12 — 2026-08-10\n### Review correction")
        self.assertIn("<h3", html)
        self.assertIn("<h4", html)

    def test_html_is_escaped(self):
        html = _md_to_html("a <script>alert(1)</script> tag & an ampersand")
        self.assertNotIn("<script>", html)
        self.assertIn("&lt;script&gt;", html)
        self.assertIn("&amp;", html)

    def test_empty_input(self):
        self.assertEqual(_md_to_html(""), "")


class TestAgainstTheRealCorrection(unittest.TestCase):
    """End-to-end on the section the email will actually carry this week."""

    def test_latest_lessons_section_renders_without_literal_markup(self):
        from agent_trader import _latest_lessons_section
        md = _latest_lessons_section()
        if not md.strip():
            self.skipTest("lessons.md has no section to render")
        html = _md_to_html(md)
        self.assertNotIn("**", html)
        # A '&gt;' is only a defect when it opens a block — inside prose it is a real
        # greater-than ("n &gt;= 20", "&gt;$12M") and must survive escaped.
        for tag in ("<p style='margin:6px 0'>", "<li>"):
            self.assertNotIn(tag + "&gt;", html)
        # every opened list is closed
        self.assertEqual(html.count("<ul"), html.count("</ul>"))
        self.assertEqual(html.count("<blockquote"), html.count("</blockquote>"))


if __name__ == "__main__":
    unittest.main()
