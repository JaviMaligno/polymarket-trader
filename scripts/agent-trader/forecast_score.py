"""Score every forecast the agent makes, not only the bets it places.

Operator-only. Each decline receipt in `declines.jsonl` carries the agent's `p_hat_yes`
and the executable YES quote at that moment. One forecast per market (the earliest
receipt with a probability) is scored against the market's resolution with the Brier
score, paired against the YES mid of the same quote. The pre-registered stop rule in
STOP-RULE.md reads the paired difference.

    python forecast_score.py update    # fetch resolutions, append final ones to forecast_outcomes.jsonl
    python forecast_score.py report    # text report + stop-rule status (local, offline)

`update` needs the network (Gamma, no key); `report` only reads committed files.
"""
import argparse
from datetime import date
import json
from pathlib import Path
import random
import sys

import requests

HERE = Path(__file__).resolve().parent
DECLINES = HERE / 'declines.jsonl'
OUTCOMES = HERE / 'forecast_outcomes.jsonl'
CLUSTERS = HERE / 'forecast_clusters.json'  # operator map: event_id or market_id -> story label
GAMMA = 'https://gamma-api.polymarket.com/markets'

FIRST_LOOK, SECOND_LOOK = 50, 100                  # resolved forecasts
FIRST_LOOK_CLUSTERS, SECOND_LOOK_CLUSTERS = 25, 50  # distinct stories behind them
CI_LEVEL = 0.975  # per look: two looks at 97.5% keep the overall false "beats" rate <= 5%
N_BOOT, SEED = 4000, 0


def read_jsonl(path):
    path = Path(path)
    if not path.exists():
        return []
    return [json.loads(l) for l in path.read_text(encoding='utf-8').splitlines() if l.strip()]


def forecasts(receipts):
    """One forecast per market: the earliest receipt that states a probability."""
    best = {}
    for r in receipts:
        if r.get('p_hat_yes') is None or r.get('best_bid') is None or r.get('best_ask') is None:
            continue
        mid = str(r['market_id'])
        if mid not in best or r['at'] < best[mid]['at']:
            best[mid] = {'market_id': mid, 'run_id': r.get('run_id'), 'at': r['at'],
                         'p_agent': float(r['p_hat_yes']),
                         'p_market': round((float(r['best_bid']) + float(r['best_ask'])) / 2, 6)}
    return sorted(best.values(), key=lambda f: (f['at'], f['market_id']))


def outcome_of(market):
    """'YES' / 'NO' for a decided binary market, 'VOID' for a split one, None if not final."""
    if not market or not market.get('closed'):
        return None
    try:
        prices = [float(p) for p in json.loads(market.get('outcomePrices') or '[]')]
    except (TypeError, ValueError):
        return None
    if len(prices) != 2:
        return None
    if prices[0] >= 0.99:
        return 'YES'
    if prices[0] <= 0.01:
        return 'NO'
    return 'VOID'


def _event_id(market):
    events = (market or {}).get('events') or []
    return str(events[0]['id']) if events and events[0].get('id') is not None else None


def _fetch_market(market_id):
    r = requests.get(f'{GAMMA}/{market_id}', timeout=30)
    return r.json() if r.status_code == 200 else None


def update(declines=DECLINES, outcomes=OUTCOMES, fetch=_fetch_market, today=None):
    """Append the final outcome of every forecast market not yet resolved. Returns new rows."""
    today = today or date.today().isoformat()
    known = {str(r['market_id']) for r in read_jsonl(outcomes)}
    added = []
    for f in forecasts(read_jsonl(declines)):
        if f['market_id'] in known:
            continue
        try:
            market = fetch(f['market_id'])
            o = outcome_of(market)
        except requests.RequestException as e:
            print(f"  warn: fetch failed for {f['market_id']}: {e}")
            continue
        if o is not None:
            added.append({'market_id': f['market_id'], 'outcome': o,
                          'event_id': _event_id(market), 'checked_on': today})
    if added:
        with Path(outcomes).open('a', encoding='utf-8') as fh:
            for row in added:
                fh.write(json.dumps(row) + '\n')
    return added


def join(fcs, outcome_rows):
    by_id = {str(r['market_id']): r for r in outcome_rows}
    return [dict(f, outcome=by_id[f['market_id']]['outcome'],
                 event_id=by_id[f['market_id']].get('event_id'))
            for f in fcs if f['market_id'] in by_id]


def load_clusters(path=CLUSTERS):
    path = Path(path)
    return json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}


def cluster_of(row, overrides):
    """Story a forecast belongs to: operator map (market, then event), else the Polymarket
    event, else the market itself. Correlated forecasts counted apart make the interval too narrow."""
    mid, ev = str(row['market_id']), row.get('event_id')
    if mid in overrides:
        return overrides[mid]
    if ev is not None and str(ev) in overrides:
        return overrides[str(ev)]
    return str(ev) if ev is not None else mid


def _ci(groups, level=CI_LEVEL):
    """Cluster bootstrap: resample whole stories, mean over the forecasts drawn."""
    rng = random.Random(SEED)
    k = len(groups)
    means = []
    for _ in range(N_BOOT):
        total = count = 0
        for _ in range(k):
            g = groups[rng.randrange(k)]
            total += sum(g)
            count += len(g)
        means.append(total / count)
    means.sort()
    tail = (1 - level) / 2
    return means[int(tail * N_BOOT)], means[min(N_BOOT - 1, int((1 - tail) * N_BOOT))]


def score(rows, overrides=None):
    overrides = overrides or {}
    rows = [r for r in rows if r['outcome'] in ('YES', 'NO')]
    if not rows:
        return {'n': 0, 'clusters': 0, 'brier_agent': None, 'brier_market': None,
                'mean_diff': None, 'ci_lo': None, 'ci_hi': None}
    y = [1.0 if r['outcome'] == 'YES' else 0.0 for r in rows]
    ba = [(r['p_agent'] - o) ** 2 for r, o in zip(rows, y)]
    bm = [(r['p_market'] - o) ** 2 for r, o in zip(rows, y)]
    d = [a - m for a, m in zip(ba, bm)]
    groups = {}
    for r, x in zip(rows, d):
        groups.setdefault(cluster_of(r, overrides), []).append(x)
    lo, hi = _ci(list(groups.values()))
    n = len(rows)
    return {'n': n, 'clusters': len(groups), 'brier_agent': round(sum(ba) / n, 6), 'brier_market': round(sum(bm) / n, 6),
            'mean_diff': round(sum(d) / n, 6), 'ci_lo': round(lo, 6), 'ci_hi': round(hi, 6)}


def stop_rule(s):
    """Pre-registered in STOP-RULE.md (2026-11-16). Negative diff = agent better."""
    n, k = s['n'], s['clusters']
    if n < FIRST_LOOK or k < FIRST_LOOK_CLUSTERS:
        return {'status': 'collecting', 'look': None,
                'detail': f'{n}/{FIRST_LOOK} resolved forecasts, {k}/{FIRST_LOOK_CLUSTERS} '
                          'distinct stories before the first look'}
    look = 2 if n >= SECOND_LOOK and k >= SECOND_LOOK_CLUSTERS else 1
    if s['ci_hi'] < 0:
        return {'status': 'agent_beats_market', 'look': look,
                'detail': 'the agent forecasts better than the market price: decide the next phase'}
    if look == 1 and s['mean_diff'] < 0:
        return {'status': 'continue', 'look': 1,
                'detail': f'better on average but unproven: wait for {SECOND_LOOK} resolved '
                          f'forecasts from {SECOND_LOOK_CLUSTERS} stories'}
    return {'status': 'stop', 'look': look,
            'detail': 'the agent does not forecast better than the market price: close the experiment'}


def render_text(fcs, joined, rule, overrides=None):
    s = score(joined, overrides)
    lines = [f"forecasts: {len(fcs)}  resolved: {s['n']}  stories: {s['clusters']}  "
             f"(void: {sum(1 for r in joined if r['outcome'] == 'VOID')})"]
    if s['n']:
        lines.append(f"Brier agent: {s['brier_agent']}  Brier market (mid): {s['brier_market']}  "
                     f"diff (agent - market): {s['mean_diff']}  "
                     f"{CI_LEVEL:.1%} CI [{s['ci_lo']}, {s['ci_hi']}]")
    lines.append(f"STOP RULE: {rule['status']} — {rule['detail']}")
    return '\n'.join(lines)


def report(declines=DECLINES, outcomes=OUTCOMES):
    fcs = forecasts(read_jsonl(declines))
    joined = join(fcs, read_jsonl(outcomes))
    overrides = load_clusters()
    rule = stop_rule(score(joined, overrides))
    return render_text(fcs, joined, rule, overrides), rule


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('command', choices=['update', 'report'])
    ap.add_argument('--status-file', help='report: write the stop-rule status word here')
    args = ap.parse_args(argv)
    if args.command == 'update':
        added = update()
        print(f'forecast outcomes added: {len(added)}')
        return 0
    text, rule = report()
    print(text)
    if args.status_file:
        Path(args.status_file).write_text(rule['status'], encoding='utf-8')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
