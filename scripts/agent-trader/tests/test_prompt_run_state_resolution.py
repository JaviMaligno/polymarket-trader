import unittest
from pathlib import Path


PROMPT = Path(__file__).resolve().parents[1] / "agent-trader-prompt.md"
WORKFLOW = (Path(__file__).resolve().parents[3]
            / ".github" / "workflows" / "agent-trader-weekly.yml")


class PromptRunStateResolutionTests(unittest.TestCase):
    """Run 17 (2026-09-14) was a silent null run: the prompt named
    AGENT_TRADER_RUN_STATE as if it were a filename, so the agent globbed for a
    file literally called `AGENT_TRADER_RUN_STATE*`, found none, and stopped as
    the prompt told it to. The run state must be introduced as an environment
    variable, with the command that resolves it."""

    def setUp(self):
        # normalised: the prompt hard-wraps, so required phrases span lines
        self.prompt = " ".join(PROMPT.read_text(encoding="utf-8").split())

    def test_run_state_is_introduced_as_an_environment_variable(self):
        self.assertIn("environment variable `AGENT_TRADER_RUN_STATE`", self.prompt)

    def test_prompt_gives_the_command_that_resolves_the_path(self):
        self.assertIn('cat "$AGENT_TRADER_RUN_STATE"', self.prompt)

    def test_absence_is_only_declared_after_resolving_the_variable(self):
        self.assertIn(
            "Never conclude it is absent from a filename search: it is not named "
            "`AGENT_TRADER_RUN_STATE` on disk",
            self.prompt,
        )


class WorkflowRunStateLocationTests(unittest.TestCase):
    """The agent's Read/Write tools are scoped to the working directory, so a run
    state under `runner.temp` is unreadable to it even once resolved, and the
    proposal it must write beside that file is unwritable."""

    def setUp(self):
        self.workflow = WORKFLOW.read_text(encoding="utf-8")

    def test_run_state_lives_inside_the_agent_working_directory(self):
        self.assertIn(
            "AGENT_TRADER_RUN_STATE: ${{ github.workspace }}"
            "/scripts/agent-trader/.run-state/agent-trader-run.json",
            self.workflow,
        )

    def test_run_state_directory_is_ignored_by_git(self):
        ignore = (Path(__file__).resolve().parents[1] / ".gitignore")
        self.assertTrue(ignore.exists(), ".run-state must be gitignored")
        self.assertIn(".run-state/", ignore.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
