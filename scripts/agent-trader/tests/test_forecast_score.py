"""Forecast scoring and the pre-registered stop rule (STOP-RULE.md)."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import forecast_score as fs

ROOT = Path(__file__).resolve().parents[3]
WORKFLOW = ROOT / '.github' / 'workflows' / 'agent-trader-weekly.yml'


def receipt(market_id, at, p_hat, bid=0.40, ask=0.42, run_id='r1'):
    return {'run_id': run_id, 'at': at, 'market_id': market_id, 'side': 'NO',
            'best_bid': bid, 'best_ask': ask, 'p_hat_yes': p_hat,
            'conservative_p_yes': None if p_hat is None else p_hat + 0.04}


def write_jsonl(path, rows):
    path.write_text(''.join(json.dumps(r) + '\n' for r in rows), encoding='utf-8')


class ForecastSelectionTests(unittest.TestCase):
    def test_one_forecast_per_market_the_earliest_with_a_probability(self):
        rows = [
            receipt('A', '2026-11-20T10:00:00+00:00', 0.30, run_id='r2'),
            receipt('A', '2026-11-16T10:00:00+00:00', None, run_id='r0'),
            receipt('A', '2026-11-16T12:00:00+00:00', 0.20, run_id='r1'),
            receipt('B', '2026-11-16T12:00:00+00:00', 0.70),
        ]
        got = {f['market_id']: f for f in fs.forecasts(rows)}
        self.assertEqual(set(got), {'A', 'B'})
        self.assertEqual(got['A']['p_agent'], 0.20)
        self.assertEqual(got['A']['run_id'], 'r1')

    def test_market_reference_is_the_yes_mid_at_receipt_time(self):
        [f] = fs.forecasts([receipt('A', '2026-11-16T12:00:00+00:00', 0.2, bid=0.191, ask=0.193)])
        self.assertAlmostEqual(f['p_market'], 0.192)

    def test_a_market_with_only_vetoes_is_not_a_forecast(self):
        self.assertEqual(fs.forecasts([receipt('A', '2026-11-16T12:00:00+00:00', None)]), [])


class ResolutionTests(unittest.TestCase):
    def test_closed_binary_markets_resolve(self):
        self.assertEqual(fs.outcome_of({'closed': True, 'outcomePrices': '["1", "0"]'}), 'YES')
        self.assertEqual(fs.outcome_of({'closed': True, 'outcomePrices': '["0", "1"]'}), 'NO')

    def test_open_or_unreadable_markets_are_not_resolved(self):
        self.assertIsNone(fs.outcome_of({'closed': False, 'outcomePrices': '["0.999", "0.001"]'}))
        self.assertIsNone(fs.outcome_of({'closed': True, 'outcomePrices': '[]'}))
        self.assertIsNone(fs.outcome_of(None))

    def test_a_split_resolution_is_void_not_a_coin_flip(self):
        self.assertEqual(fs.outcome_of({'closed': True, 'outcomePrices': '["0.5", "0.5"]'}), 'VOID')


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.declines = self.dir / 'declines.jsonl'
        self.outcomes = self.dir / 'forecast_outcomes.jsonl'
        write_jsonl(self.declines, [
            receipt('A', '2026-11-16T12:00:00+00:00', 0.2),
            receipt('B', '2026-11-16T12:00:00+00:00', 0.7),
            receipt('C', '2026-11-16T12:00:00+00:00', 0.5),
        ])

    def test_only_final_outcomes_are_appended_and_a_rerun_is_idempotent(self):
        markets = {'A': {'closed': True, 'outcomePrices': '["0", "1"]', 'events': [{'id': 'E1'}]},
                   'B': {'closed': False, 'outcomePrices': '["0.6", "0.4"]'}}
        calls = []

        def fetch(mid):
            calls.append(mid)
            if mid == 'C':
                raise fs.requests.RequestException('boom')
            return markets.get(mid)

        added = fs.update(self.declines, self.outcomes, fetch=fetch, today='2026-12-01')
        self.assertEqual([r['market_id'] for r in added], ['A'])
        rows = fs.read_jsonl(self.outcomes)
        self.assertEqual(rows, [{'market_id': 'A', 'outcome': 'NO', 'event_id': 'E1',
                                 'checked_on': '2026-12-01'}])
        calls.clear()
        self.assertEqual(fs.update(self.declines, self.outcomes, fetch=fetch, today='2026-12-02'), [])
        self.assertNotIn('A', calls)
        self.assertEqual(len(fs.read_jsonl(self.outcomes)), 1)


def scored(n, p_agent, p_market, outcome_yes):
    return [{'market_id': str(i), 'p_agent': p_agent, 'p_market': p_market,
             'outcome': 'YES' if outcome_yes(i) else 'NO'} for i in range(n)]


class ScoreTests(unittest.TestCase):
    def test_brier_scores_and_paired_difference(self):
        s = fs.score(scored(2, 0.8, 0.6, lambda i: i == 0))
        # agent: (0.2^2 + 0.8^2)/2 = 0.34 ; market: (0.4^2 + 0.6^2)/2 = 0.26
        self.assertEqual(s['n'], 2)
        self.assertAlmostEqual(s['brier_agent'], 0.34)
        self.assertAlmostEqual(s['brier_market'], 0.26)
        self.assertAlmostEqual(s['mean_diff'], 0.08)

    def test_void_outcomes_are_excluded(self):
        rows = scored(3, 0.8, 0.6, lambda i: True)
        rows[0]['outcome'] = 'VOID'
        self.assertEqual(fs.score(rows)['n'], 2)

    def test_join_uses_only_resolved_forecasts(self):
        fc = [{'market_id': 'A', 'p_agent': 0.2, 'p_market': 0.3},
              {'market_id': 'B', 'p_agent': 0.6, 'p_market': 0.5}]
        joined = fs.join(fc, [{'market_id': 'B', 'outcome': 'YES'}])
        self.assertEqual([r['market_id'] for r in joined], ['B'])


class StopRuleTests(unittest.TestCase):
    """STOP-RULE.md: looks at n>=50 and n>=100, 97.5% paired bootstrap CI per look."""

    def test_collecting_below_the_first_look(self):
        self.assertEqual(fs.stop_rule(fs.score(scored(49, 0.9, 0.5, lambda i: True)))['status'], 'collecting')

    def test_stop_at_the_first_look_when_the_agent_is_not_better(self):
        # agent and market identical -> mean diff 0 -> not better -> stop
        s = fs.score(scored(50, 0.5, 0.5, lambda i: i % 2 == 0))
        self.assertEqual(fs.stop_rule(s)['status'], 'stop')

    def test_agent_beats_market_when_the_whole_interval_is_below_zero(self):
        s = fs.score(scored(50, 0.9, 0.5, lambda i: i % 10 != 0))
        self.assertLess(s['ci_hi'], 0)
        self.assertEqual(fs.stop_rule(s)['status'], 'agent_beats_market')

    def test_better_but_unproven_continues_to_the_second_look(self):
        s = {'n': 60, 'clusters': 30, 'mean_diff': -0.01, 'ci_lo': -0.05, 'ci_hi': 0.02}
        self.assertEqual(fs.stop_rule(s)['status'], 'continue')

    def test_second_look_is_final(self):
        final = {'n': 100, 'clusters': 50, 'mean_diff': -0.01, 'ci_lo': -0.05, 'ci_hi': 0.02}
        self.assertEqual(fs.stop_rule(final)['status'], 'stop')
        self.assertEqual(fs.stop_rule(dict(final, mean_diff=-0.03, ci_hi=-0.01))['status'], 'agent_beats_market')

    def test_a_look_needs_enough_distinct_stories_not_only_forecasts(self):
        few = {'n': 80, 'clusters': 24, 'mean_diff': 0.02, 'ci_lo': 0.0, 'ci_hi': 0.04}
        self.assertEqual(fs.stop_rule(few)['status'], 'collecting')
        # 100+ forecasts but too few stories for the final look: still judged as look 1
        mid = {'n': 120, 'clusters': 40, 'mean_diff': -0.01, 'ci_lo': -0.05, 'ci_hi': 0.02}
        self.assertEqual(fs.stop_rule(mid)['status'], 'continue')


class ClusterTests(unittest.TestCase):
    """Forecasts on one real-world story resolve together; the CI must resample stories."""

    def test_cluster_defaults_to_the_polymarket_event_then_the_market(self):
        self.assertEqual(fs.cluster_of({'market_id': 'A', 'event_id': 'E1'}, {}), 'E1')
        self.assertEqual(fs.cluster_of({'market_id': 'A', 'event_id': None}, {}), 'A')

    def test_operator_map_merges_events_into_one_story(self):
        overrides = {'E1': 'iran', 'B': 'iran'}
        self.assertEqual(fs.cluster_of({'market_id': 'A', 'event_id': 'E1'}, overrides), 'iran')
        self.assertEqual(fs.cluster_of({'market_id': 'B', 'event_id': 'E9'}, overrides), 'iran')

    def test_correlated_forecasts_widen_the_interval(self):
        rows = scored(60, 0.7, 0.5, lambda i: (i // 10) % 2 == 0)
        independent = fs.score(rows)
        for r in rows:
            r['event_id'] = f"story{int(r['market_id']) // 10}"
        clustered = fs.score(rows)
        self.assertEqual(independent['clusters'], 60)
        self.assertEqual(clustered['clusters'], 6)
        self.assertAlmostEqual(independent['mean_diff'], clustered['mean_diff'])
        self.assertGreater(clustered['ci_hi'] - clustered['ci_lo'],
                           1.5 * (independent['ci_hi'] - independent['ci_lo']))

    def test_join_carries_the_event(self):
        joined = fs.join([{'market_id': 'B', 'p_agent': 0.6, 'p_market': 0.5}],
                         [{'market_id': 'B', 'outcome': 'YES', 'event_id': 'E2'}])
        self.assertEqual(joined[0]['event_id'], 'E2')

    def test_the_interval_is_deterministic(self):
        rows = scored(50, 0.7, 0.5, lambda i: i % 3 != 0)
        self.assertEqual(fs.score(rows), fs.score(rows))


class SurfaceTests(unittest.TestCase):
    def test_report_names_the_status_and_counts(self):
        text = fs.render_text(fs.forecasts([receipt('A', '2026-11-16T12:00:00+00:00', 0.2)]),
                              [], fs.stop_rule(fs.score([])))
        self.assertIn('forecasts: 1', text)
        self.assertIn('resolved: 0', text)
        self.assertIn('collecting', text)

    def test_workflow_updates_after_the_agents_turn_and_commits_the_outcomes(self):
        wf = WORKFLOW.read_text(encoding='utf-8')
        self.assertLess(wf.index('python agent_trader.py evaluate'), wf.index('python forecast_score.py update'))
        self.assertLess(wf.index('lessons_guard.py /tmp/lessons-before.md'), wf.index('python forecast_score.py update'))
        self.assertIn('forecast_outcomes.jsonl', wf.split('- name: Commit track record')[1])

    def test_prompt_does_not_send_the_agent_to_the_stop_rule(self):
        prompt = (ROOT / 'scripts' / 'agent-trader' / 'agent-trader-prompt.md').read_text(encoding='utf-8')
        for word in ('forecast_score', 'STOP-RULE', 'forecast_outcomes'):
            self.assertNotIn(word, prompt)


if __name__ == '__main__':
    unittest.main()
