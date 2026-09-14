import copy
import importlib.util
import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import agent_trader as trader

NOW = datetime(2026, 9, 7, 19, tzinfo=timezone.utc)
MARKET = {
    'id': '123', 'slug': 'example', 'question': 'Will a treaty be signed?',
    'description': 'A signed treaty.\n\nBefore September 30.',
    'endDate': '2026-09-30T23:59:00Z', 'outcomes': '["Yes", "No"]',
    'outcomePrices': '["0.4", "0.6"]', 'bestBid': .39, 'bestAsk': .41,
    'spread': .02, 'closed': False, 'acceptingOrders': True,
    'events': [{'id': 'event1'}], 'clobTokenIds': '["token1", "token2"]',
}


def proposal():
    return {
        'market_id': '123', 'side': 'YES', 'p_hat_yes': .6, 'stake': 25,
        'confidence': 'medium', 'risk_group': 'treaty-example',
        'rationale': 'A documented signing window supports the estimate.',
        'description': MARKET['description'], 'paragraphs_read': 2,
        'conditions': [{'condition': 'Signed treaty by deadline', 'source_ids': ['s1']}],
        'sources': [{'id': 's1', 'url': 'https://example.org/announcement',
                     'accessed_at': NOW.isoformat(), 'finding': 'Signing window announced.'}],
        'scenarios': [{'name': 'Signing proceeds', 'weight': .6, 'p_yes': 1,
                       'reason': 'Official timetable', 'source_ids': ['s1']},
                      {'name': 'Signing fails', 'weight': .4, 'p_yes': 0,
                       'reason': 'Ratification risk', 'source_ids': ['s1']}],
        'counterargument': 'A timetable can slip.', 'falsifier': 'Party withdraws consent.',
        'news_at': '2026-09-06T12:00:00Z',
        'price_history_analysis': 'Price moved on the announcement; residual edge is timing.',
    }


def verdict():
    return {'decision': 'approve', 'p_hat_yes': .57,
            'checks': {k: 'pass' for k in ('sources', 'conditions', 'probability',
                       'counterargument', 'price_history', 'risk_group', 'siblings', 'seat_math')},
            'reason': 'Independent source checks support conservative probability.',
            'source_urls': ['https://example.org/announcement']}


class EntryGateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.find_spec('entry_gate')
        if spec:
            import entry_gate
            cls.gate = entry_gate

    def setUp(self):
        self.assertTrue(hasattr(self, 'gate'), 'entry gate is not implemented')
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)
        self.bets = self.path / 'bets.jsonl'
        self.bets.write_text('', encoding='utf-8')
        self.state = self.path / 'run.json'
        self.addCleanup(patch.stopall)
        patch.object(trader, 'BETS', self.bets).start()
        patch.object(self.gate, 'now', return_value=NOW).start()
        self.gate.begin_run(self.state)

    def write_bets(self, rows):
        self.bets.write_text(''.join(json.dumps(b) + '\n' for b in rows), encoding='utf-8')

    def restart(self, rows):
        self.write_bets(rows)
        self.state.unlink()
        self.gate.begin_run(self.state)

    def test_same_run_resolution_does_not_release_iran_group(self):
        b = {'bet_id': 'old', 'market_id': '3348048', 'status': 'open',
             'question': 'Iran-Oman Hormuz Agreement by August 31?'}
        self.restart([b])
        b['status'] = 'lost'
        self.write_bets([b])
        with self.assertRaisesRegex(ValueError, 'concentration'):
            self.gate.check_concentration(self.gate.read_run(self.state),
                {'risk_group': 'different-label'}, dict(MARKET, question='US ends Iranian blockade?'))

    def test_next_run_releases_resolved_group(self):
        self.restart([{'bet_id': 'old', 'status': 'lost', 'question': 'Iran deal?'}])
        self.gate.check_concentration(self.gate.read_run(self.state),
            {'risk_group': 'iran'}, dict(MARKET, question='Iran deal?'))

    def test_same_event_different_group_is_blocked(self):
        self.restart([{'bet_id': 'old', 'status': 'open', 'risk_group': 'other',
                       'event_ids': ['event1']}])
        with self.assertRaisesRegex(ValueError, 'concentration'):
            self.gate.check_concentration(self.gate.read_run(self.state), proposal(), MARKET)

    def test_unknown_legacy_exposure_fails_closed(self):
        self.state.unlink()
        self.write_bets([{'bet_id': 'old', 'status': 'open', 'question': 'Unknown outcome'}])
        with self.assertRaisesRegex(ValueError, 'risk group'):
            self.gate.begin_run(self.state)

    def test_begin_run_creates_the_state_directory(self):
        # The run state lives in a gitignored dir inside the agent's working
        # directory (so its Read/Write tools can reach it); that dir does not
        # exist on a fresh checkout.
        nested = self.path / '.run-state' / 'run.json'
        self.gate.begin_run(nested)
        self.assertTrue(nested.is_file())

    def test_run_cannot_be_reset(self):
        with self.assertRaises(FileExistsError):
            self.gate.begin_run(self.state)

    def test_old_run_is_rejected(self):
        with patch.object(self.gate, 'now', return_value=datetime(2026, 9, 9, tzinfo=timezone.utc)):
            with self.assertRaisesRegex(ValueError, 'expired'):
                self.gate.read_run(self.state)

    def test_evidence_missing_fields_rejected(self):
        for field in ('sources', 'conditions', 'counterargument', 'scenarios', 'falsifier',
                      'price_history_analysis', 'news_at', 'risk_group'):
            p = proposal()
            del p[field]
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.gate.validate_evidence(p, MARKET)

    def test_full_description_and_paragraph_count_required(self):
        for field, value in [('description', 'A signed treaty.'), ('paragraphs_read', 1)]:
            p = proposal()
            p[field] = value
            with self.assertRaises(ValueError):
                self.gate.validate_evidence(p, MARKET)

    def test_probability_must_match_weighted_scenarios(self):
        p = proposal()
        p['p_hat_yes'] = .9
        with self.assertRaisesRegex(ValueError, 'scenarios'):
            self.gate.validate_evidence(p, MARKET)

    def test_invalid_numbers_and_citations_rejected(self):
        for field, value in [('p_hat_yes', float('nan')), ('stake', -25), ('side', 'MAYBE')]:
            p = proposal()
            p[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.gate.validate_evidence(p, MARKET)
        p = proposal()
        p['conditions'][0]['source_ids'] = ['unknown']
        with self.assertRaises(ValueError):
            self.gate.validate_evidence(p, MARKET)

    def test_closed_market_rejected(self):
        with self.assertRaises(ValueError):
            self.gate.validate_evidence(proposal(), dict(MARKET, closed=True))

    def run_record(self, p=None, decision=None, second_market=None):
        patch.object(self.gate, 'fetch_market', side_effect=[MARKET, second_market or MARKET]).start()
        patch.object(self.gate, 'fetch_history', return_value=[{'t': 1788600000, 'p': .3},
                     {'t': 1788700000, 'p': .4}]).start()
        patch.object(self.gate, 'critical_review', return_value=decision or verdict()).start()
        return self.gate.record_proposal(p or proposal(), self.state)

    def test_approved_bet_has_evidence_review_and_audit(self):
        bet = self.run_record()
        self.assertEqual(bet['evidence'], proposal())
        self.assertEqual(bet['review']['decision'], 'approve')
        self.assertEqual(bet['risk_group'], 'treaty-example')
        self.gate.audit_run(self.state)

    def test_reviewer_veto_does_not_append(self):
        v = verdict()
        v['decision'] = 'reject'
        with self.assertRaisesRegex(ValueError, 'review'):
            self.run_record(decision=v)
        self.assertEqual(self.bets.read_text(), '')

    def test_review_missing_checks_or_edge_rejects(self):
        for field, value in [('checks', {}), ('p_hat_yes', .42), ('source_urls', [])]:
            v = verdict()
            v[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.run_record(decision=v)

    def test_quote_move_after_review_rejects(self):
        with self.assertRaisesRegex(ValueError, 'edge'):
            self.run_record(second_market=dict(MARKET, bestBid=.57, bestAsk=.59))
        self.assertEqual(self.bets.read_text(), '')

    def test_second_same_group_entry_is_blocked(self):
        self.run_record()
        with self.assertRaisesRegex(ValueError, 'concentration'):
            self.run_record()

    def test_legacy_record_bet_cannot_bypass_review(self):
        with self.assertRaisesRegex(ValueError, 'proposal'):
            trader.record_bet({'best_bid': .39, 'best_ask': .41, 'yes_price': .4,
                              'market_id': '123', 'slug': 'test', 'question': 'Test',
                              'end_date': MARKET['endDate'], 'spread': .02},
                             'YES', .6, 'Prose-only rationale')
        self.assertEqual(self.bets.read_text(), '')

    def test_audit_rejects_direct_unreviewed_append(self):
        self.write_bets([{'bet_id': 'bypass', 'status': 'open'}])
        with self.assertRaisesRegex(ValueError, 'audit'):
            self.gate.audit_run(self.state)

    def test_reviewer_subprocess_has_no_write_tools_and_no_session_reuse(self):
        response = type('Response', (), {'returncode': 0,
            'stdout': json.dumps({'result': json.dumps(verdict())})})()
        with patch.object(self.gate.subprocess, 'run', return_value=response) as proc:
            result = self.gate.critical_review({'proposal': proposal()})
        args = proc.call_args.args[0]
        self.assertEqual(args[args.index('--tools') + 1], 'WebSearch,WebFetch')
        self.assertNotIn('--continue', args)
        self.assertNotIn('--resume', args)
        self.assertEqual(result, verdict())

    def test_reviewer_error_or_invalid_json_rejects(self):
        for output in ('usage limit exceeded', '{"is_error":true}', '{"result":"not json"}', '[]'):
            response = type('Response', (), {'returncode': 0, 'stdout': output})()
            with patch.object(self.gate.subprocess, 'run', return_value=response):
                with self.assertRaises(ValueError):
                    self.gate.critical_review({})

    def test_history_must_straddle_news(self):
        response = type('Response', (), {'raise_for_status': lambda self: None,
            'json': lambda self: {'history': [{'t': 1788700000, 'p': .4}]}})()
        with patch.object(self.gate.requests, 'get', return_value=response):
            with self.assertRaisesRegex(ValueError, 'history'):
                self.gate.fetch_history(MARKET, proposal()['news_at'])

    def test_provider_timeout_never_approves(self):
        with patch.object(self.gate.subprocess, 'run', side_effect=self.gate.subprocess.TimeoutExpired('claude', 600)):
            with self.assertRaisesRegex(ValueError, 'unavailable'):
                self.gate.critical_review({})

    def test_changed_description_after_review_rejects(self):
        with self.assertRaisesRegex(ValueError, 'description'):
            self.run_record(second_market=dict(MARKET, description='Changed rules.'))
        self.assertEqual(self.bets.read_text(), '')

    def test_audit_preserves_original_entry_probability(self):
        self.restart([{'bet_id': 'old', 'status': 'lost', 'my_prob_yes': .78}])
        self.write_bets([{'bet_id': 'old', 'status': 'lost', 'my_prob_yes': .01}])
        with self.assertRaisesRegex(ValueError, 'historical'):
            self.gate.audit_run(self.state)

    def test_audit_rejects_modified_approved_probability(self):
        bet = self.run_record()
        bet['my_prob_yes'] = .99
        self.write_bets([bet])
        with self.assertRaisesRegex(ValueError, 'audit'):
            self.gate.audit_run(self.state)

    def test_loaded_bets_closes_file(self):
        import warnings
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter('always', ResourceWarning)
            trader.load_bets()
        self.assertFalse([w for w in caught if w.category is ResourceWarning])

    def test_runners_snapshot_before_evaluate_and_audit_before_reporting(self):
        root = Path(__file__).resolve().parents[3]
        for file, marker in [(root / 'scripts/agent-trader/run-local.sh', 'agent_trader.py metrics'),
                             (root / '.github/workflows/agent-trader-weekly.yml', 'agent_trader.py metrics')]:
            content = file.read_text(encoding='utf-8')
            with self.subTest(file=file):
                self.assertIn('entry_gate.py begin', content)
                self.assertLess(content.index('entry_gate.py begin'), content.index('agent_trader.py evaluate'))
                self.assertIn('entry_gate.py audit', content)
                self.assertLess(content.index('entry_gate.py audit'), content.index(marker))

    def test_concurrent_record_is_rejected_before_fetch(self):
        Path(str(self.state) + '.lock').write_text('busy')
        with patch.object(self.gate, 'fetch_market') as fetch:
            with self.assertRaisesRegex(ValueError, 'in progress'):
                self.gate.record_proposal(proposal(), self.state)
        fetch.assert_not_called()

    def test_deadline_change_after_review_requires_new_review(self):
        with self.assertRaisesRegex(ValueError, 'changed'):
            self.run_record(second_market=dict(MARKET, endDate='2026-10-01T23:59:00Z'))
        self.assertEqual(self.bets.read_text(), '')

    def test_large_edge_requires_sibling_evidence(self):
        p = proposal()
        p['p_hat_yes'] = .8
        p['scenarios'][0]['weight'] = .8
        p['scenarios'][1]['weight'] = .2
        with self.assertRaisesRegex(ValueError, 'sibling'):
            self.gate.validate_evidence(p, MARKET)

    def test_seat_projection_requires_both_tiers_and_feasible_chamber_total(self):
        market = dict(MARKET, question='Which party gains most seats in the election?')
        with self.assertRaisesRegex(ValueError, 'seat_model'):
            self.gate.validate_evidence(proposal(), market)
        p = proposal()
        p['seat_model'] = {'chamber_size': 450, 'method': 'Mixed electoral system',
            'parties': [{'party': 'A', 'baseline': 324, 'list_seats': 200,
                         'constituency_seats': 300, 'source_ids': ['s1']}]}
        with self.assertRaisesRegex(ValueError, 'chamber'):
            self.gate.validate_evidence(p, market)

    def test_no_entry_uses_more_pessimistic_reviewer_estimate(self):
        p = proposal()
        p.update(side='NO', p_hat_yes=.3)
        p['scenarios'][0]['weight'] = .3
        p['scenarios'][1]['weight'] = .7
        v = verdict()
        v['p_hat_yes'] = .35  # NO fair .65 versus NO entry .61: below required edge
        with self.assertRaisesRegex(ValueError, 'edge'):
            self.run_record(p=p, decision=v)

    def test_rejected_review_is_retained_for_audit(self):
        v = verdict()
        v['decision'] = 'reject'
        with self.assertRaises(ValueError):
            self.run_record(decision=v)
        attempts = self.gate.read_run(self.state)['reviews']
        self.assertEqual(attempts[0]['review'], v)
        self.assertEqual(attempts[0]['proposal'], proposal())

    def test_proposal_must_be_json_object(self):
        with self.assertRaisesRegex(ValueError, 'object'):
            self.gate.record_proposal([], self.state)

    def test_valid_sibling_and_seat_models_are_accepted(self):
        p = proposal()
        p['p_hat_yes'] = .8
        p['scenarios'][0]['weight'] = .8
        p['scenarios'][1]['weight'] = .2
        p['sibling_markets'] = [{'market_id': '456', 'url': 'https://example.org/sibling',
                                'criterion': 'Same deadline', 'comparison': 'Supports estimate',
                                'yes_price': .7, 'liquidity': 20000, 'source_ids': ['s1']}]
        p['seat_model'] = {'chamber_size': 450, 'method': 'Tier models and thresholds',
            'parties': [{'party': 'A', 'baseline': 324, 'list_seats': 126,
                         'constituency_seats': 198, 'source_ids': ['s1']},
                        {'party': 'Others', 'baseline': 126, 'list_seats': 99,
                         'constituency_seats': 27, 'source_ids': ['s1']}]}
        self.gate.validate_evidence(p, MARKET)

    def test_runner_context_is_not_used_in_job_environment(self):
        workflow = Path(__file__).resolve().parents[3] / '.github/workflows/agent-trader-weekly.yml'
        content = workflow.read_text(encoding='utf-8')
        self.assertNotIn('${{ runner.', content.split('    steps:')[0])

    def test_real_reviewer_process_roundtrip(self):
        # Exercise stdin, CLI flags, JSON envelope and gate together. Only the
        # external executable and market transport are substituted, not review logic.
        provider = self.path / 'provider.py'
        provider.write_text('''import json, sys
packet = json.load(sys.stdin)
assert packet['proposal']['market_id'] == '123'
assert len(packet['history']) == 2
assert sys.argv[sys.argv.index('--tools') + 1] == 'WebSearch,WebFetch'
assert '--strict-mcp-config' in sys.argv
assert '--resume' not in sys.argv
print(json.dumps({'result': json.dumps(REVIEW)}))
'''.replace('REVIEW', repr(verdict())), encoding='utf-8')
        original_run = self.gate.subprocess.run
        def launch(command, **kwargs):
            return original_run([sys.executable, str(provider)] + command[1:], **kwargs)
        with patch.object(self.gate.subprocess, 'run', side_effect=launch), \
             patch.object(self.gate, 'fetch_market', return_value=MARKET), \
             patch.object(self.gate, 'fetch_history', return_value=[{'t': 1, 'p': .3}, {'t': 2, 'p': .4}]):
            bet = self.gate.record_proposal(proposal(), self.state)
        self.assertEqual(bet['review'], verdict())
        self.assertEqual(self.gate.audit_run(self.state), 1)

    def test_real_provider_crash_leaves_no_entry(self):
        provider = self.path / 'provider.py'
        provider.write_text('import sys; sys.exit(7)', encoding='utf-8')
        original_run = self.gate.subprocess.run
        def launch(command, **kwargs):
            return original_run([sys.executable, str(provider)], **kwargs)
        with patch.object(self.gate.subprocess, 'run', side_effect=launch), \
             patch.object(self.gate, 'fetch_market', return_value=MARKET), \
             patch.object(self.gate, 'fetch_history', return_value=[{'t': 1, 'p': .3}, {'t': 2, 'p': .4}]):
            with self.assertRaisesRegex(ValueError, 'process failed'):
                self.gate.record_proposal(proposal(), self.state)
        self.assertEqual(self.bets.read_text(), '')
        self.assertEqual(self.gate.audit_run(self.state), 0)


if __name__ == '__main__':
    unittest.main()
