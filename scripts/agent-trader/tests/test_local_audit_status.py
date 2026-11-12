"""SPEC-3: a local in-band provider failure must reach the audit status."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class LocalAuditStatusTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which('bash'), 'needs bash')
    def test_SPEC_3_in_band_provider_error_sets_failed_agent_status(self):
        script = (Path(__file__).resolve().parents[1] / 'run-local.sh').read_text(encoding='utf-8')
        start = script.index('  if [ "$AGENT_OK" = "0" ] || grep')
        end = script.index('\n  fi', start) + len('\n  fi')
        block = script[start:end]
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / 'agent.log'
            log.write_text('API Error: usage limit\n', encoding='utf-8')
            env = dict(os.environ, AGENT_LOG=log.as_posix())
            # Use a script file: Windows native argv quoting of `bash -c` can expand
            # dollar variables in a different shell before Bash sees the program.
            fixture = Path(directory) / 'status.sh'
            fixture.write_text('AGENT_OK=1\nRC=0\n' + block +
                               '\nprintf "AGENT_STATUS=%s" "$AGENT_OK"', encoding='utf-8')
            result = subprocess.run([shutil.which('bash'), str(fixture)],
                                    env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('AGENT_STATUS=0', result.stdout)
