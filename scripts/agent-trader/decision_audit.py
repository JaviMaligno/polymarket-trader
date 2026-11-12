"""Deterministic research accounting; source/criterion coverage is self-reported.

Declines use a newly fetched quote and the entry gate's executable/fee arithmetic.
snapshot(state, raw_transcript, declines) is pure; upsert_run(row, path) persists
one row per UUID. Rehearsal CLI snapshots only print and never persist history.
"""
import argparse
from datetime import date
import json
import os
from pathlib import Path
import sys
import uuid

import agent_trader
import entry_gate
import transcript_stats

HERE = Path(__file__).resolve().parent
DECLINES = HERE / 'declines.jsonl'
RUNS = HERE / 'research_runs.jsonl'
REASONS = {'below_threshold', 'insufficient_evidence', 'uncertainty', 'policy', 'concentration'}


def read_jsonl(path):
    path = Path(path)
    if not path.exists():
        return []
    rows = [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines() if line.strip()]
    if any(not isinstance(row, dict) for row in rows):
        raise ValueError('audit log rows must be objects')
    return rows


def _run(state):
    if not isinstance(state, dict):
        raise ValueError('run state must be an object')
    try:
        uuid.UUID(state['run_id'])
        entry_gate.timestamp(state['started_at'])
    except (KeyError, TypeError, AttributeError, ValueError) as exc:
        raise ValueError('run UUID and started_at required') from exc
    return state


def _read_run(path):
    return _run(entry_gate.read_run(path))


def _provenance(state):
    return {key: state.get(key) or os.environ.get(env) or None for key, env in (
        ('github_run_id', 'GITHUB_RUN_ID'), ('github_run_attempt', 'GITHUB_RUN_ATTEMPT'))}


def _coverage_fields(candidate):
    if not isinstance(candidate, dict):
        raise ValueError('candidate must be an object')
    market_id = entry_gate.text(candidate.get('market_id'))
    if type(candidate.get('criterion_read')) is not bool:
        raise ValueError('criterion_read must be boolean')
    sources = candidate.get('source_urls')
    if not isinstance(sources, list):
        raise ValueError('source_urls must be a list')
    for source in sources:
        entry_gate.url(source)
    return market_id, list(dict.fromkeys(sources)), candidate['criterion_read']


def record_decline(packet, state_path, log_path=DECLINES, fetch_market=None):
    """Validate completely before append. fetch_market is injectable for offline tests."""
    state = _read_run(state_path)
    market_id, sources, criterion = _coverage_fields(packet)
    side = packet.get('side')
    if side not in ('YES', 'NO'):
        raise ValueError('side must be YES or NO')
    reason_code = packet.get('reason_code')
    if not isinstance(reason_code, str) or reason_code not in REASONS:
        raise ValueError('invalid reason_code')
    reason = entry_gate.text(packet.get('reason'))
    estimates = []
    for key in ('p_hat_yes', 'conservative_p_yes'):
        if key not in packet:
            raise ValueError(f'{key} required (explicit null allowed for veto)')
        value = packet[key]
        estimates.append(None if value is None else entry_gate.number(value))
    p_hat, conservative = estimates
    if reason_code == 'below_threshold' and None in estimates:
        raise ValueError('below_threshold requires both estimates')
    if conservative is not None and p_hat is None:
        raise ValueError('conservative estimate requires p_hat_yes')
    if p_hat is not None and conservative is not None:
        if (side == 'YES' and conservative > p_hat) or (side == 'NO' and conservative < p_hat):
            raise ValueError('conservative estimate cannot improve proposed direction')
    market = (fetch_market or entry_gate.fetch_market)(market_id)
    if not isinstance(market, dict) or str(market.get('id')) != market_id:
        raise ValueError('market quote id mismatch')
    # Gamma quotes can be numeric strings; bools and non-finite values are invalid.
    quoted = dict(market)
    for key in ('bestBid', 'bestAsk'):
        value = market.get(key)
        if isinstance(value, bool) or not isinstance(value, (str, float, int)):
            raise ValueError('invalid quote')
        quoted[key] = entry_gate.number(float(value))
    entry = entry_gate.executable(quoted, side)
    rate = agent_trader.fee_rate(quoted)
    effective = entry_gate.effective_entry(entry, rate)
    def edge(probability):
        return None if probability is None else (probability if side == 'YES' else 1 - probability) - effective
    conservative_edge = edge(conservative)
    if reason_code == 'below_threshold' and conservative_edge >= .05 - 1e-9:
        raise ValueError('conservative edge is not below threshold')
    row = {'run_id': state['run_id'], **_provenance(state),
           'at': entry_gate.now().isoformat(), 'market_id': market_id, 'side': side,
           'best_bid': quoted['bestBid'], 'best_ask': quoted['bestAsk'],
           'fee_rate': rate, 'fee_type': quoted.get('feeType'),
           'fees_enabled': bool(quoted.get('feesEnabled')),
           'entry': entry, 'effective_entry': effective,
           'p_hat_yes': p_hat, 'conservative_p_yes': conservative,
           'raw_edge': edge(p_hat), 'conservative_edge': conservative_edge,
           'reason_code': reason_code, 'reason': reason, 'source_urls': sources,
           'criterion_read': criterion, 'coverage_self_reported': True}
    encoded = json.dumps(row, ensure_ascii=False, allow_nan=False)
    with Path(log_path).open('a', encoding='utf-8') as fh:
        fh.write(encoded + '\n')
    return row


def record_coverage(packet, state_path):
    state = _read_run(state_path)
    if not isinstance(packet, dict) or not isinstance(packet.get('candidates'), list):
        raise ValueError('coverage requires a candidates list')
    candidates = [_coverage_fields(candidate) for candidate in packet['candidates']]
    coverage = state.setdefault('research_coverage', {})
    for market_id, sources, criterion in candidates:
        old = coverage.get(market_id, {})
        coverage[market_id] = {'source_urls': list(dict.fromkeys(old.get('source_urls', []) + sources)),
                               'criterion_read': old.get('criterion_read', False) or criterion,
                               'self_reported': True}
    entry_gate.save_run(state_path, state)
    return coverage


def latest_declines(rows):
    """Append order defines revisions; one latest decision per run and market."""
    latest = {}
    for row in rows:
        latest[(row['run_id'], row['market_id'])] = row
    return list(latest.values())


def snapshot(state, raw_transcript, declines, agent_ok=True, event='schedule', entry_audit_ok=True):
    _run(state)
    if (type(agent_ok) is not bool or type(entry_audit_ok) is not bool
            or event not in ('schedule', 'workflow_dispatch', 'local')):
        raise ValueError('invalid snapshot status/event')
    stats = transcript_stats.parse(raw_transcript)
    coverage = state.get('research_coverage')
    present = isinstance(coverage, dict)
    candidates = set(coverage or {})
    decided = {row['market_id'] for row in latest_declines(declines)
               if row['run_id'] == state['run_id']}
    attempts = state.get('proposal_attempts')
    reviews = state.get('reviews', [])
    receipts = state.get('receipts', [])
    known = set(decided)
    for attempt in attempts or []:
        if attempt.get('market_id'):
            known.add(attempt['market_id'])
    for review in reviews:
        market_id = review.get('proposal', {}).get('market_id')
        if market_id:
            known.add(market_id)
    for receipt in receipts:
        market_id = receipt.get('bet', {}).get('market_id')
        if market_id:
            decided.add(market_id)
            known.add(market_id)
    # Submission/review failure is funnel activity, not a completed numerical
    # decline. Also check the reverse direction: logged candidates need coverage.
    known.update(candidates)
    unlogged = sorted(known - decided)
    uncovered = sorted(known - candidates)
    return {'run_id': state['run_id'], **_provenance(state),
            'date': entry_gate.timestamp(state['started_at']).date().isoformat(),
            'started_at': state['started_at'], 'snapshot_at': entry_gate.now().isoformat(), 'event': event,
            'searches': stats.searches, 'fetches': stats.fetches, 'ok_fetches': stats.ok_fetches,
            'passes': stats.passes, 'news_decoded': stats.news_decoded,
            'news_attempted': stats.news_attempted, 'duration_ms': stats.duration_ms,
            'completed': stats.completed, 'agent_ok': agent_ok, 'entry_audit_ok': entry_audit_ok,
            'coverage_present': present, 'coverage_self_reported': True,
            'candidates_reported': len(candidates) if present else None,
            'sources_reported': len({url for item in coverage.values() for url in item['source_urls']}) if present else None,
            'criterion_reads_reported': sum(item['criterion_read'] for item in coverage.values()) if present else None,
            'candidates_with_decisions': len(candidates & decided) if present else None,
            'unlogged_candidate_ids': unlogged if present else None,
            'uncovered_candidate_ids': uncovered if present else None,
            'proposal_attempts': len(attempts) if attempts is not None else None,
            'independent_reviews': len(reviews), 'bets_placed': len(receipts),
            'audit_complete': present and not unlogged and not uncovered and agent_ok and entry_audit_ok
                              and stats.completed and not stats.last_is_error}


def upsert_run(row, path=RUNS):
    if row.get('rehearsal'):
        raise ValueError('rehearsals cannot enter research history')
    rows = {item['run_id']: item for item in read_jsonl(path)}
    rows[row['run_id']] = row
    # Reuse the gate's atomic JSON writer pattern for this small JSONL file.
    import tempfile
    fd, temporary = tempfile.mkstemp(dir=Path(path).parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as fh:
            for item in rows.values():
                fh.write(json.dumps(item, ensure_ascii=False, allow_nan=False) + '\n')
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def report_rows(rows, start='2026-11-02', end='2026-11-30'):
    start_date, end_date = date.fromisoformat(start), date.fromisoformat(end)
    if start_date >= end_date:
        raise ValueError('start must precede exclusive end')
    latest = {row['run_id']: row for row in rows if not row.get('rehearsal')}
    return sorted((row for row in latest.values()
                   if start_date <= date.fromisoformat(row['date']) < end_date),
                  key=lambda row: (row['date'], row['run_id']))


def render_report(rows, start='2026-11-02', end='2026-11-30', as_of=None):
    fields = ('run_id', 'date', 'searches', 'ok_fetches', 'candidates_reported',
              'sources_reported', 'proposal_attempts', 'independent_reviews', 'bets_placed', 'audit_complete')
    collecting = (as_of or entry_gate.now().date()) < date.fromisoformat(end)
    status = 'still collecting' if collecting else 'window complete; operator review due'
    lines = [f'Research audit [{start}, {end}): {status}; no automatic threshold recommendation.',
             'Coverage and criterion reads are self-reported; missing historical counts are unknown.',
             '| Run UUID | Date | Searches | Fetched content | Candidates | Sources | Attempts | Reviews | Bets | Audit complete |',
             '|---|---|---|---|---|---|---|---|---|---|']
    for row in report_rows(rows, start, end):
        lines.append('| ' + ' | '.join('unknown' if row.get(key) is None else str(row[key]) for key in fields) + ' |')
    return '\n'.join(lines)


def main(argv=None, env=None):
    env = os.environ if env is None else env
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    for command in ('decline', 'coverage'):
        commands.add_parser(command).add_argument('packet')
    snap = commands.add_parser('snapshot')
    snap.add_argument('transcript')
    snap.add_argument('--agent-ok', choices=('0', '1'), default='1')
    snap.add_argument('--entry-audit-ok', choices=('0', '1'), default='1')
    snap.add_argument('--event', choices=('schedule', 'workflow_dispatch', 'local'), default='schedule')
    snap.add_argument('--rehearsal', action='store_true')
    snap.add_argument('--runs', default=str(RUNS))
    snap.add_argument('--declines', default=str(DECLINES))
    rep = commands.add_parser('report')
    rep.add_argument('--start', default='2026-11-02')
    rep.add_argument('--end', default='2026-11-30')
    rep.add_argument('--runs', default=str(RUNS))
    args = parser.parse_args(argv)
    if args.command == 'report':
        print(render_report(read_jsonl(args.runs), args.start, args.end))
        return 0
    state_path = env.get('AGENT_TRADER_RUN_STATE')
    if not state_path:
        raise ValueError('AGENT_TRADER_RUN_STATE must name a private run state file')
    if args.command in ('decline', 'coverage'):
        packet = json.loads(Path(args.packet).read_text(encoding='utf-8'))
        result = (record_decline(packet, state_path) if args.command == 'decline'
                  else record_coverage(packet, state_path))
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
        return 0
    row = snapshot(_read_run(state_path), Path(args.transcript).read_text(encoding='utf-8'),
                   read_jsonl(args.declines), args.agent_ok == '1', args.event,
                   entry_audit_ok=args.entry_audit_ok == '1')
    if args.rehearsal:
        row['rehearsal'] = True
    else:
        upsert_run(row, args.runs)
    print(json.dumps(row, ensure_ascii=False, allow_nan=False))
    if not row['audit_complete']:
        print('::warning::Decision audit incomplete: check coverage, unlogged candidates, and completion/status.',
              file=sys.stderr)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, OSError, KeyError) as exc:
        raise SystemExit(str(exc))
