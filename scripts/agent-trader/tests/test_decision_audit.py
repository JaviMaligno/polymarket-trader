import json
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import entry_gate
import decision_audit as audit


def state():
    return {'run_id': str(uuid.uuid4()), 'started_at': entry_gate.now().isoformat(),
            'reviews': [], 'receipts': [], 'proposal_attempts': []}


def packet():
    return {'market_id': '123', 'side': 'NO', 'p_hat_yes': .46,
            'conservative_p_yes': .48, 'reason_code': 'below_threshold',
            'reason': 'Conservative edge is below the entry bar.',
            'source_urls': ['https://example.org/source'], 'criterion_read': True}


MARKET = {'id': '123', 'bestBid': .51, 'bestAsk': .52, 'feesEnabled': False}
TRANSCRIPT = json.dumps({'type': 'result', 'duration_ms': 2000, 'is_error': False})


class DecisionAuditTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)
        self.state_path = self.path / 'state.json'
        self.s = state()
        self.state_path.write_text(json.dumps(self.s), encoding='utf-8')
        self.log = self.path / 'declines.jsonl'

    def record(self, p=None, market=None):
        return audit.record_decline(p or packet(), self.state_path, self.log,
                                    fetch_market=lambda _: market or MARKET)

    def test_executable_no_quote_and_provenance(self):
        with patch.dict('os.environ', {'GITHUB_RUN_ID': '77', 'GITHUB_RUN_ATTEMPT': '2'}):
            row = self.record()
        self.assertAlmostEqual(row['entry'], .49)
        self.assertAlmostEqual(row['raw_edge'], .05)
        self.assertAlmostEqual(row['conservative_edge'], .03)
        self.assertEqual(row['github_run_id'], '77')
        self.assertEqual(row['github_run_attempt'], '2')
        self.assertEqual(row['run_id'], self.s['run_id'])
        self.assertTrue(row['coverage_self_reported'])

    def test_run27_range_cannot_be_logged_below_threshold(self):
        for p_hat in (.40, .45):
            p = dict(packet(), p_hat_yes=p_hat, conservative_p_yes=.45)
            with self.assertRaisesRegex(ValueError, 'below'):
                self.record(p)
        self.assertFalse(self.log.exists())

    def test_fee_market_uses_shared_effective_entry(self):
        row = self.record(market=dict(MARKET, feesEnabled=True, feeType='sports_fees_v2'))
        self.assertEqual(row['fee_rate'], .05)
        self.assertEqual(row.get('fee_type'), 'sports_fees_v2')
        self.assertIs(row.get('fees_enabled'), True)
        self.assertAlmostEqual(row['effective_entry'], .49 + .05 * .49 * .51)

    def test_unknown_estimates_stay_null_for_evidence_veto(self):
        row = self.record(dict(packet(), p_hat_yes=None, conservative_p_yes=None,
                               reason_code='insufficient_evidence'))
        for key in ('p_hat_yes', 'conservative_p_yes', 'raw_edge', 'conservative_edge'):
            self.assertIsNone(row[key])

    def test_malformed_inputs_never_write(self):
        invalid = [{'p_hat_yes': True}, {'p_hat_yes': float('nan')},
                   {'p_hat_yes': 1.1}, {'conservative_p_yes': .40},
                   {'criterion_read': 1}, {'source_urls': ['file:///tmp/a']},
                   {'reason': ' '}, {'reason_code': 'other'},
                   {'conservative_p_yes': None}, {'side': 'maybe'}]
        for changes in invalid:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.record(dict(packet(), **changes))
        with self.assertRaises(ValueError):
            self.record(market=dict(MARKET, id='other'))
        with self.assertRaises(ValueError):
            self.record(market=dict(MARKET, bestBid=True))
        self.assertFalse(self.log.exists())

    def test_state_expiry_and_fetch_errors_fail_without_append(self):
        def fail(_):
            raise RuntimeError('quote unavailable')
        with self.assertRaisesRegex(RuntimeError, 'unavailable'):
            audit.record_decline(packet(), self.state_path, self.log, fetch_market=fail)
        self.s['started_at'] = '2000-01-01T00:00:00Z'
        self.state_path.write_text(json.dumps(self.s), encoding='utf-8')
        with self.assertRaises(ValueError):
            self.record()
        self.assertFalse(self.log.exists())

    def test_threshold_tolerance_and_yes_conservative_direction(self):
        p = dict(packet(), side='YES', p_hat_yes=.57, conservative_p_yes=.57)
        with self.assertRaises(ValueError):
            self.record(p)
        p['conservative_p_yes'] = .57 - 2e-9
        self.record(p)
        with self.assertRaises(ValueError):
            self.record(dict(p, conservative_p_yes=.58))

    def test_malformed_packet_and_coverage_leave_files_unchanged(self):
        for malformed in (None, [], {}, {'market_id': '123'}):
            with self.subTest(packet=malformed), self.assertRaises(ValueError):
                audit.record_decline(malformed, self.state_path, self.log,
                                     fetch_market=lambda _: MARKET)
        before = self.state_path.read_bytes()
        with self.assertRaises(ValueError):
            audit.record_coverage({'candidates': [
                {'market_id': '123', 'criterion_read': True, 'source_urls': []},
                {'market_id': '456', 'criterion_read': 'yes', 'source_urls': []}]}, self.state_path)
        self.assertEqual(self.state_path.read_bytes(), before)
        self.assertFalse(self.log.exists())

    def test_coverage_merge_deduplicates_and_preserves_read(self):
        first = {'candidates': [{'market_id': '123', 'criterion_read': True,
                                 'source_urls': ['https://example.org/a']}]}
        audit.record_coverage(first, self.state_path)
        first['candidates'][0].update(criterion_read=False,
                                    source_urls=['https://example.org/a', 'https://example.org/b'])
        audit.record_coverage(first, self.state_path)
        saved = json.loads(self.state_path.read_text())
        candidate = saved['research_coverage']['123']
        self.assertTrue(candidate['criterion_read'])
        self.assertEqual(len(candidate['source_urls']), 2)
        self.assertTrue(candidate['self_reported'])

    def test_snapshot_missing_coverage_counts_unknown_and_attempts_distinct(self):
        self.s['proposal_attempts'] = [{'market_id': 'a'}, {'market_id': 'b'}]
        self.s['reviews'] = [{'proposal': {'market_id': 'a'}}]
        row = audit.snapshot(self.s, TRANSCRIPT, [])
        self.assertIsNone(row['candidates_reported'])
        self.assertIsNone(row['sources_reported'])
        self.assertFalse(row['audit_complete'])
        self.assertEqual(row['proposal_attempts'], 2)
        self.assertEqual(row['independent_reviews'], 1)
        self.assertEqual(row['duration_ms'], 2000)
        self.s.pop('proposal_attempts')
        self.assertIsNone(audit.snapshot(self.s, '', [])['proposal_attempts'])

    def test_revisions_and_other_runs_do_not_double_count_decisions(self):
        self.s['research_coverage'] = {
            '123': {'source_urls': ['https://example.org/a'], 'criterion_read': True},
            '456': {'source_urls': ['https://example.org/a'], 'criterion_read': False}}
        d = {'run_id': self.s['run_id'], 'market_id': '123'}
        row = audit.snapshot(self.s, TRANSCRIPT, [d, d, dict(d, run_id='other')])
        self.assertEqual(row['candidates_with_decisions'], 1)
        self.assertEqual(row['unlogged_candidate_ids'], ['456'])
        self.assertEqual(row['sources_reported'], 1)
        self.assertFalse(row['audit_complete'])
        self.s['proposal_attempts'] = [{'market_id': '456', 'status': 'error'}]
        # A rejected proposal counts as an attempt, not as a deterministic decline.
        self.assertFalse(audit.snapshot(self.s, TRANSCRIPT, [d])['audit_complete'])
        self.assertTrue(audit.snapshot(self.s, TRANSCRIPT, [d, dict(d, market_id='456')])['audit_complete'])
        self.assertFalse(audit.snapshot(self.s, TRANSCRIPT, [d], entry_audit_ok=False)['audit_complete'])
        self.assertEqual(len(audit.latest_declines([d, d])), 1)

    def test_SPEC_3_failed_proposal_needs_a_decline_receipt(self):
        self.s['research_coverage'] = {'123': {'source_urls': [], 'criterion_read': False}}
        self.s['proposal_attempts'] = [{'market_id': '123', 'status': 'rejected', 'error': 'invalid market'}]
        row = audit.snapshot(self.s, TRANSCRIPT, [])
        self.assertEqual(row['proposal_attempts'], 1)
        self.assertEqual(row['candidates_with_decisions'], 0)
        self.assertFalse(row['audit_complete'])

    def test_SPEC_3_logged_candidate_cannot_be_omitted_from_coverage(self):
        self.s['research_coverage'] = {}
        row = audit.snapshot(self.s, TRANSCRIPT, [{'run_id': self.s['run_id'], 'market_id': '123'}])
        self.assertFalse(row['audit_complete'])
        self.assertEqual(row.get('uncovered_candidate_ids'), ['123'])

    def test_run_upsert_same_date_retains_distinct_runs(self):
        log = self.path / 'runs.jsonl'
        a = audit.snapshot(self.s, TRANSCRIPT, [])
        b = dict(a, run_id=str(uuid.uuid4()))
        audit.upsert_run(a, log)
        audit.upsert_run(b, log)
        audit.upsert_run(dict(a, searches=9), log)
        rows = audit.read_jsonl(log)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['searches'], 9)

    def test_rehearsal_cli_does_not_write_history(self):
        transcript = self.path / 'transcript.jsonl'
        transcript.write_text(TRANSCRIPT)
        runs = self.path / 'runs.jsonl'
        env = {'AGENT_TRADER_RUN_STATE': str(self.state_path)}
        with patch('builtins.print'):
            audit.main(['snapshot', str(transcript), '--rehearsal', '--runs', str(runs)], env)
        self.assertFalse(runs.exists())

    def test_report_window_is_inclusive_exclusive_and_collecting(self):
        rows = [{'date': date, 'run_id': date} for date in
                ('2026-11-01', '2026-11-02', '2026-11-29', '2026-11-30')]
        selected = audit.report_rows(rows)
        self.assertEqual([r['date'] for r in selected], ['2026-11-02', '2026-11-29'])
        text = audit.render_report(rows, as_of=__import__('datetime').date(2026, 11, 12))
        self.assertIn('still collecting', text)
        self.assertIn('unknown', text)

    def test_SPEC_3_window_end_requests_operator_review_without_changing_threshold(self):
        text = audit.render_report([], as_of=__import__('datetime').date(2026, 11, 30))
        self.assertIn('window complete', text)
        self.assertIn('operator review due', text)
        self.assertNotIn('still collecting', text)

    def test_snapshot_cli_stdout_is_json_and_failed_entry_audit_warns(self):
        transcript = self.path / 'transcript.jsonl'
        transcript.write_text(TRANSCRIPT)
        env = {'AGENT_TRADER_RUN_STATE': str(self.state_path)}
        with patch('sys.stdout', new_callable=__import__('io').StringIO) as stdout, \
                patch('sys.stderr', new_callable=__import__('io').StringIO) as stderr:
            result = audit.main(['snapshot', str(transcript), '--rehearsal',
                                 '--entry-audit-ok', '0'], env)
        row = json.loads(stdout.getvalue())
        self.assertFalse(row['entry_audit_ok'])
        self.assertFalse(row['audit_complete'])
        self.assertEqual(result, 0)
        self.assertIn('warning', stderr.getvalue())


if __name__ == '__main__':
    unittest.main()
