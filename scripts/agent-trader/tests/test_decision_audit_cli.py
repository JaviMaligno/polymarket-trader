"""SPEC-2/3/4: exercise real CLI boundaries against an isolated Gamma fixture."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import uuid
from datetime import datetime, timezone

HERE = Path(__file__).resolve().parents[1]


class DecisionAuditCLITests(unittest.TestCase):
    def test_SPEC_2_3_4_decline_coverage_snapshot_report_roundtrip(self):
        with tempfile.TemporaryDirectory(prefix='QA-agent-trader-') as directory:
            root = Path(directory)
            state = root / 'run.json'
            state.write_text(json.dumps({
                'run_id': str(uuid.uuid4()), 'started_at': datetime.now(timezone.utc).isoformat(),
                'proposal_attempts': [], 'reviews': [], 'receipts': []}), encoding='utf-8')
            log = root / 'declines.jsonl'
            wrapper = root / 'fixture_cli.py'
            # Only the external quote transport and log destination are substituted.
            # The parser, state validation, math, JSONL persistence and report are real.
            wrapper.write_text(
                'import sys\nfrom pathlib import Path\n'
                f'sys.path.insert(0, {str(HERE)!r})\n'
                'import decision_audit as audit\n'
                'original = audit.record_decline\n'
                'def record(packet, state_path):\n'
                f'    return original(packet, state_path, log_path=Path({str(log)!r}), '
                'fetch_market=lambda _: {"id":"123","bestBid":0.51,"bestAsk":0.52,"feesEnabled":False})\n'
                'audit.record_decline = record\n'
                'sys.exit(audit.main())\n', encoding='utf-8')
            env = dict(os.environ, AGENT_TRADER_RUN_STATE=str(state))

            def command(*args, success=True):
                result = subprocess.run([sys.executable, '-X', 'utf8', str(wrapper), *map(str, args)],
                                        env=env, text=True, encoding='utf-8', capture_output=True)
                self.assertEqual(result.returncode == 0, success, result.stderr)
                return result

            packet = root / 'packet.json'
            data = dict(market_id='123', side='NO', p_hat_yes=.46, conservative_p_yes=.48,
                        reason_code='below_threshold', reason='Fixture: conservative edge 0.03.',
                        source_urls=['https://example.org/QA-agent-trader-source'], criterion_read=True)
            packet.write_text(json.dumps(data), encoding='utf-8')
            decline = json.loads(command('decline', packet).stdout)
            self.assertAlmostEqual(decline['entry'], .49)
            self.assertAlmostEqual(decline['conservative_edge'], .03)

            # The Run 27 inconsistency must fail at the CLI and leave the receipt alone.
            packet.write_text(json.dumps(dict(data, p_hat_yes=.40, conservative_p_yes=.45)), encoding='utf-8')
            command('decline', packet, success=False)
            self.assertEqual(len(log.read_text(encoding='utf-8').splitlines()), 1)

            packet.write_text(json.dumps({'candidates': [{k: data[k] for k in
                               ('market_id', 'criterion_read', 'source_urls')}]}), encoding='utf-8')
            command('coverage', packet)
            transcript = root / 'transcript.jsonl'
            transcript.write_text(json.dumps({'type': 'result', 'is_error': False, 'result': 'Fixture done.'}), encoding='utf-8')
            runs = root / 'research_runs.jsonl'
            for _ in range(2):
                response = command('snapshot', transcript, '--declines', log, '--runs', runs, '--event', 'local')
                row = json.loads(response.stdout)
                self.assertTrue(row['audit_complete'])
                self.assertEqual(row['candidates_reported'], 1)
                self.assertEqual(row['sources_reported'], 1)
                self.assertEqual(row['bets_placed'], 0)
            self.assertEqual(len(runs.read_text(encoding='utf-8').splitlines()), 1)
            report = command('report', '--runs', runs, '--start', '2000-01-01', '--end', '2100-01-01').stdout
            self.assertIn(row['run_id'], report)
            self.assertIn('self-reported', report)
            before = runs.read_bytes()
            command('snapshot', transcript, '--declines', log, '--runs', runs, '--rehearsal')
            self.assertEqual(runs.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
