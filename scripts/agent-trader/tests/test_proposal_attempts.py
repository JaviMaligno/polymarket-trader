"""SPEC-3: rejected proposals still count before independent review starts."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import agent_trader as trader
import entry_gate as gate


class ProposalAttemptTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.state = self.root / 'run.json'
        self.bets = self.root / 'bets.jsonl'
        self.bets.write_text('', encoding='utf-8')
        self.addCleanup(patch.stopall)
        patch.object(trader, 'BETS', self.bets).start()
        gate.begin_run(self.state)

    def test_SPEC_3_pre_review_rejection_counts_as_attempt(self):
        with patch.object(gate, 'fetch_market', side_effect=ValueError('invalid market')):
            with self.assertRaisesRegex(ValueError, 'invalid market'):
                gate.record_proposal({'market_id': '123'}, self.state)
        state = gate.read_run(self.state)
        attempts = state.get('proposal_attempts', [])
        self.assertEqual(len(attempts), 1, 'A proposal rejected before review must be counted')
        self.assertEqual(attempts[0]['market_id'], '123')
        self.assertEqual(attempts[0]['status'], 'rejected')
        self.assertIn('invalid market', attempts[0]['error'])
        self.assertEqual(state['reviews'], [])
        self.assertEqual(state['receipts'], [])

    def test_SPEC_3_success_updates_attempt_without_erasing_receipts(self):
        def checked(proposal, path):
            state = gate.read_run(path)
            state['reviews'].append({'review': {'decision': 'approve'}})
            state['receipts'].append({'bet': {'market_id': '123'}})
            gate.save_run(path, state)
            return {'bet_id': 'new'}

        with patch.object(gate, '_record_proposal', side_effect=checked):
            result = gate.record_proposal({'market_id': '123'}, self.state)
        state = gate.read_run(self.state)
        self.assertEqual(result, {'bet_id': 'new'})
        self.assertEqual(len(state.get('proposal_attempts', [])), 1)
        self.assertEqual(state['proposal_attempts'][0]['status'], 'recorded')
        self.assertEqual(len(state['receipts']), 1)
        self.assertEqual(len(state['reviews']), 1)

    def test_SPEC_3_failed_retry_is_separate_attempt(self):
        with patch.object(gate, 'fetch_market', side_effect=ValueError('invalid market')):
            for _ in range(2):
                with self.assertRaises(ValueError):
                    gate.record_proposal({'market_id': '123'}, self.state)
        self.assertEqual(len(gate.read_run(self.state).get('proposal_attempts', [])), 2)

    def test_SPEC_3_unexpected_failure_is_recorded_and_propagates(self):
        with patch.object(gate, '_record_proposal', side_effect=RuntimeError('unexpected')):
            with self.assertRaisesRegex(RuntimeError, 'unexpected'):
                gate.record_proposal({'market_id': '123'}, self.state)
        attempt = gate.read_run(self.state).get('proposal_attempts', [])
        self.assertEqual(len(attempt), 1)
        self.assertEqual(attempt[0]['status'], 'rejected')


if __name__ == '__main__':
    unittest.main()
