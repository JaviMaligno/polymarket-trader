#!/usr/bin/env python3
"""Smoke-test the live reviewer's risk grouping (workflow `validation_only`).

The reviewer assigns the risk group that the concentration veto enforces. A reviewer
that drops the field rejects every entry; one that groups by shared words rebuilds the
keyword regex this replaced. Two fixed cases against one open exposure row:

- a US-Iran ceasefire market shares the blockade bet's driver -> its exact slug;
- an Israeli election market shares a word, not a driver -> any other slug.

The verdict itself (approve/reject) is irrelevant here: the proposals are thin on
purpose and a rejection still has to carry the group. Exit 1 on any miss.
"""
from __future__ import annotations

import re
import sys

import entry_gate

EXPOSURE = [{
    'bet_id': 'b-smoke', 'market_id': '900001', 'side': 'NO', 'status': 'open',
    'question': 'US announces end of Iranian blockade by October 31, 2026?',
    'risk_group': 'iran-regional-conflict', 'event_ids': ['900001'],
    'end_date': '2026-10-31T23:59:00Z', 'stake': 25,
}]

CASES = [
    ('ceasefire', True, 'Will the US-Iran ceasefire hold through October 31, 2026?',
     'Resolves YES if no US or Iranian military strike on the other\'s territory or forces '
     'is reported by major outlets between the listing date and October 31, 2026.'),
    ('israel-election', False, 'Will Netanyahu be the next Prime Minister of Israel?',
     'Resolves YES if Benjamin Netanyahu is sworn in as Prime Minister following the next '
     'Knesset election.'),
]


def packet(question, description):
    market = {'id': '900002', 'question': question, 'description': description,
              'endDate': '2026-10-31T23:59:00Z', 'events': [{'id': '900002'}]}
    proposal = {'market_id': '900002', 'side': 'YES', 'p_hat_yes': .5, 'stake': 25,
                'risk_group': 'smoke-proposed', 'description': description,
                'rationale': 'Grouping smoke test: no research supplied.'}
    return {'proposal': proposal, 'market': market, 'history': [],
            'exposure': EXPOSURE, 'current_bets': EXPOSURE,
            'proposed_risk_group': 'smoke-proposed'}


def main():
    failures = 0
    for name, same, question, description in CASES:
        group = entry_gate.critical_review(packet(question, description)).get('risk_group')
        valid = isinstance(group, str) and re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', group)
        ok = bool(valid) and (group == 'iran-regional-conflict') == same
        print(f'{name}: risk_group={group!r} expected {"same" if same else "different"} -> '
              f'{"OK" if ok else "FAIL"}')
        failures += not ok
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
