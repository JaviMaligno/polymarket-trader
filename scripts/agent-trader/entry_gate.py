"""Fail-closed paper entry gates. Run state is private to one sequential runner."""
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import tempfile
import uuid
from urllib.parse import urlparse

import requests
import agent_trader as trader

HERE = Path(__file__).resolve().parent
CHECKS = ('sources', 'conditions', 'probability', 'counterargument',
          'price_history', 'risk_group', 'siblings', 'seat_math')


def now():
    return datetime.now(timezone.utc)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     allow_nan=False).encode('utf-8')).hexdigest()


def timestamp(value):
    try:
        result = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if result.tzinfo is None:
            raise ValueError('timezone required')
        return result
    except (AttributeError, TypeError, ValueError) as exc:
        raise ValueError('invalid timestamp') from exc


def number(value, low=0, high=1):
    if isinstance(value, bool) or not isinstance(value, (float, int)):
        raise ValueError('numeric value required')
    if not math.isfinite(value) or not low <= value <= high:
        raise ValueError('number out of range')
    return value


def text(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError('nonempty text required')
    return value.strip()


def url(value):
    parsed = urlparse(text(value))
    if parsed.scheme not in ('http', 'https') or not parsed.hostname:
        raise ValueError('source URL required')


def group_for(row):
    # Broad, conservative families override agent labels, including legacy rows.
    question = row.get('question', '') + ' ' + row.get('slug', '')
    patterns = (
        (r'iran|hormuz|hezbollah|israel', 'iran-regional-conflict'),
        (r'united russia|russian.*(?:election|duma)|\bldpr\b', 'russia-duma-2026'),
        (r'apple.*largest|nvidia.*largest', 'largest-company-market-cap'),
        (r'bolojan|romania', 'romania-government'),
        (r'sulyok', 'hungary-presidency'),
        (r'sinner|alcaraz|us.open', 'mens-us-open-2026'),
        (r'haley.stevens|michigan.*primary', 'michigan-senate-primary-2026'),
        (r'thanedar|mi-13', 'michigan-13-primary-2026'),
        (r'nordone|darline|south.carolina.*senate', 'sc-senate-primary-2026'),
    )
    for pattern, group in patterns:
        if re.search(pattern, question, re.I):
            return group
    group = row.get('risk_group')
    if not isinstance(group, str) or not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', group):
        raise ValueError('unclassified exposure: explicit canonical risk group required')
    return group


def begin_run(path):
    bets = trader.load_bets()
    exposure = [dict(b, risk_group=group_for(b)) for b in bets if b['status'] == 'open']
    state = {'run_id': str(uuid.uuid4()), 'started_at': now().isoformat(),
             'initial_bets': bets, 'exposure': exposure, 'receipts': [], 'reviews': []}
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with Path(path).open('x', encoding='utf-8') as fh:
        json.dump(state, fh, ensure_ascii=False, allow_nan=False)
    return state


def read_run(path):
    state = json.loads(Path(path).read_text(encoding='utf-8'))
    age = (now() - timestamp(state['started_at'])).total_seconds()
    if age < 0 or age > 12 * 3600:
        raise ValueError('run expired: initialize a new scheduled/manual run')
    return state


def save_run(path, state):
    fd, tmp = tempfile.mkstemp(dir=Path(path).parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as fh:
            json.dump(state, fh, ensure_ascii=False, allow_nan=False)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    finally:
        Path(tmp).unlink(missing_ok=True)


def event_ids(market):
    return [str(e['id']) for e in market.get('events', []) if e.get('id') is not None]


def check_concentration(state, proposal, market):
    group = group_for(dict(market, risk_group=proposal.get('risk_group')))
    events = set(event_ids(market))
    # Frozen start exposure + all entries this run + current open positions.
    occupied = state['exposure'] + [r['bet'] for r in state['receipts']]
    occupied += [b for b in trader.load_bets() if b['status'] == 'open']
    for b in occupied:
        if (group_for(b) == group or events.intersection(b.get('event_ids', []))
                or str(b.get('market_id')) == str(market.get('id'))):
            raise ValueError(f'concentration veto: {group} occupied in this run')
    return group


def validate_evidence(p, market):
    try:
        if str(market['id']) != text(p['market_id']):
            raise ValueError('market mismatch')
        if (market.get('closed') or not market.get('acceptingOrders', False)
                or timestamp(market['endDate']) <= now()
                or json.loads(market['outcomes']) != ['Yes', 'No']):
            raise ValueError('market is not active binary YES/NO')
        if p['side'] not in ('YES', 'NO') or number(p['stake'], 25, 25) != 25:
            raise ValueError('paper entries require YES/NO and flat 25 stake')
        phat = number(p['p_hat_yes'])
        for key in ('confidence', 'risk_group', 'rationale', 'counterargument',
                    'falsifier', 'price_history_analysis'):
            text(p[key])
        description = text(market['description'])
        if p['description'].strip() != description:
            raise ValueError('full current description required')
        paragraphs = len(re.split(r'\n\s*\n', description))
        if type(p['paragraphs_read']) is not int or p['paragraphs_read'] != paragraphs:
            raise ValueError('paragraph count does not match full description')
        if timestamp(p['news_at']) > now():
            raise ValueError('news is in the future')
        if not isinstance(p['sources'], list) or not p['sources']:
            raise ValueError('sources required')
        ids = set()
        for source in p['sources']:
            sid = text(source['id'])
            if sid in ids:
                raise ValueError('duplicate source id')
            ids.add(sid)
            url(source['url'])
            text(source['finding'])
            age = (now() - timestamp(source['accessed_at'])).total_seconds()
            if not 0 <= age <= 48 * 3600:
                raise ValueError('sources must be checked within 48 hours')
        def citations(row):
            refs = row['source_ids']
            if not isinstance(refs, list) or not refs or not set(refs) <= ids:
                raise ValueError('missing or unknown source references')
        if not isinstance(p['conditions'], list) or not p['conditions']:
            raise ValueError('payout conditions required')
        for condition in p['conditions']:
            text(condition['condition'])
            citations(condition)
        if not isinstance(p['scenarios'], list) or len(p['scenarios']) < 2:
            raise ValueError('at least two probability scenarios required')
        weight = weighted = 0
        for scenario in p['scenarios']:
            text(scenario['name'])
            text(scenario['reason'])
            citations(scenario)
            weight += number(scenario['weight'])
            weighted += scenario['weight'] * number(scenario['p_yes'])
        if abs(weight - 1) > .0001 or abs(weighted - phat) > .005:
            raise ValueError('probability must match weighted scenarios summing to 1')
        if abs(phat - float(json.loads(market['outcomePrices'])[0])) > .25:
            if not isinstance(p.get('sibling_markets'), list) or not p['sibling_markets']:
                raise ValueError('large edge requires sibling_markets evidence')
            for sibling in p['sibling_markets']:
                text(sibling['market_id'])
                url(sibling['url'])
                text(sibling['criterion'])
                text(sibling['comparison'])
                number(sibling['yes_price'])
                number(sibling['liquidity'], 0, float('inf'))
                citations(sibling)
        if re.search(r'\bseats?\b', market['question'], re.I) or p.get('seat_model') is not None:
            model = p.get('seat_model')
            if not isinstance(model, dict) or not model.get('parties'):
                raise ValueError('seat_model required for electoral seat projections')
            chamber = number(model['chamber_size'], 1, 10000)
            text(model['method'])
            projected = 0
            for party in model['parties']:
                text(party['party'])
                number(party['baseline'], 0, chamber)
                projected += number(party['list_seats'], 0, chamber)
                projected += number(party['constituency_seats'], 0, chamber)
                citations(party)
            if abs(projected - chamber) > .01:
                raise ValueError('seat projections must sum to chamber size across all parties')
        return p
    except (KeyError, TypeError, AttributeError) as exc:
        raise ValueError(f'incomplete evidence: {exc}') from exc


def fetch_market(market_id):
    response = requests.get(f'{trader.GAMMA}/{market_id}', timeout=30)
    response.raise_for_status()
    return response.json()


def fetch_history(market, news_at):
    token = json.loads(market['clobTokenIds'])[0]
    response = requests.get('https://clob.polymarket.com/prices-history', params={
        'market': token, 'interval': 'max', 'fidelity': 60}, timeout=30)
    response.raise_for_status()
    history = response.json()['history']
    # A price path must straddle the motivating news; no inferred stale-price claims.
    news = timestamp(news_at).timestamp()
    if len(history) < 2 or not any(h['t'] < news for h in history) or not any(h['t'] >= news for h in history):
        raise ValueError('price history does not cover motivating news')
    return history


def critical_review(packet):
    instructions = (HERE / 'critical-review-prompt.md').read_text(encoding='utf-8')
    command = ['claude', '--print', '--model', os.environ.get('AGENT_REVIEW_MODEL', 'claude-sonnet-4-6'),
               '--output-format', 'json', '--tools', 'WebSearch,WebFetch',
               '--allowedTools', 'WebSearch,WebFetch', '--strict-mcp-config',
               '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence',
               '--disable-slash-commands', '--setting-sources', '',
               '--system-prompt', instructions]
    env = dict(os.environ)
    env.pop('CLAUDECODE', None)  # intentionally launch a fresh reviewer from researcher CLI
    try:
        result = subprocess.run(command, input=json.dumps(packet, ensure_ascii=False),
                                text=True, encoding='utf-8', capture_output=True,
                                timeout=600, env=env, cwd=HERE)
        if result.returncode:
            raise ValueError('critical review process failed')
        envelope = json.loads(result.stdout)
        if not isinstance(envelope, dict):
            raise ValueError('critical review envelope must be an object')
        if envelope.get('is_error'):
            raise ValueError('critical review provider error')
        decision = json.loads(envelope['result'])
        if not isinstance(decision, dict):
            raise ValueError('critical review must return an object')
        return decision
    except (OSError, subprocess.TimeoutExpired, KeyError, TypeError, json.JSONDecodeError) as exc:
        raise ValueError('critical review unavailable or malformed; entry rejected') from exc


def executable(market, side):
    bid, ask = float(market['bestBid']), float(market['bestAsk'])
    if not 0 < bid <= ask < 1 or ask - bid > .030001:
        raise ValueError('invalid quote or spread exceeds 3%')
    return ask if side == 'YES' else 1 - bid


def check_review(review, p, market):
    try:
        if review['decision'] != 'approve':
            raise ValueError('critical review veto: ' + str(review.get('reason', 'rejected')))
        if any(review['checks'].get(k) != 'pass' for k in CHECKS):
            raise ValueError('critical review checks incomplete or failed')
        text(review['reason'])
        if not isinstance(review['source_urls'], list) or not review['source_urls']:
            raise ValueError('review requires independently checked sources')
        for source in review['source_urls']:
            url(source)
        reviewer_p = number(review['p_hat_yes'])
        entry = executable(market, p['side'])
        fair = min(p['p_hat_yes'], reviewer_p) if p['side'] == 'YES' else 1 - max(p['p_hat_yes'], reviewer_p)
        if fair - entry < .05 - 1e-9:
            raise ValueError('conservative reviewed edge below 5% at executable quote')
        return fair - entry
    except (KeyError, TypeError, AttributeError) as exc:
        raise ValueError('critical review malformed') from exc


def record_proposal(p, state_path):
    if not isinstance(p, dict):
        raise ValueError('proposal must be a JSON object')
    lock = Path(str(state_path) + '.lock')
    try:
        handle = lock.open('x')
    except FileExistsError as exc:
        raise ValueError('another entry is in progress for this run') from exc
    try:
        with handle:
            return _record_proposal(p, state_path)
    finally:
        lock.unlink(missing_ok=True)


def _record_proposal(p, state_path):
    state = read_run(state_path)
    audit_run(state_path)
    market = fetch_market(text(p.get('market_id')))
    validate_evidence(p, market)
    group = check_concentration(state, p, market)
    history = fetch_history(market, p['news_at'])
    # Keep prior research/history out of the review context; only exposure facts
    # are relevant, and recursively including prior evidence bloats every run.
    exposure_keys = ('bet_id', 'market_id', 'question', 'side', 'status',
                     'risk_group', 'event_ids', 'end_date', 'stake')
    brief = lambda rows: [{k: b[k] for k in exposure_keys if k in b} for b in rows]
    packet = {'proposal': p, 'market': market, 'history': history,
              'exposure': brief(state['exposure']), 'current_bets': brief(trader.load_bets()),
              'canonical_risk_group': group}
    try:
        review = critical_review(packet)
    except ValueError as exc:
        state['reviews'].append({'proposal': p, 'error': str(exc), 'at': now().isoformat()})
        save_run(state_path, state)
        raise
    state['reviews'].append({'proposal': p, 'review': review, 'at': now().isoformat()})
    save_run(state_path, state)
    check_review(review, p, market)
    # Review can take minutes: re-fetch rules, status, spread and executable quote.
    fresh = fetch_market(p['market_id'])
    validate_evidence(p, fresh)
    if any(fresh.get(k) != market.get(k) for k in ('id', 'description', 'endDate', 'outcomes', 'clobTokenIds')) or event_ids(fresh) != event_ids(market):
        raise ValueError('market terms changed during review; new review required')
    state = read_run(state_path)
    group = check_concentration(state, p, fresh)
    edge = check_review(review, p, fresh)
    prices = json.loads(fresh['outcomePrices'])
    mkt = {'market_id': p['market_id'], 'slug': fresh['slug'], 'question': fresh['question'],
           'end_date': fresh['endDate'], 'yes_price': float(prices[0]),
           'best_bid': float(fresh['bestBid']), 'best_ask': float(fresh['bestAsk']),
           'spread': float(fresh['bestAsk']) - float(fresh['bestBid'])}
    bet = trader._build_bet(mkt, p['side'], p['p_hat_yes'], p['rationale'], p['stake'], p['confidence'])
    bet.update(risk_group=group, event_ids=event_ids(fresh), run_id=state['run_id'],
               evidence=p, review=review, reviewed_edge=round(edge, 6),
               review_packet_hash=digest(packet), reviewed_at=now().isoformat(),
               reviewed_market=market, price_history=history)
    # Receipt before append: an interrupted append cannot become an unaudited trade.
    state['receipts'].append({'bet': bet, 'hash': digest(bet)})
    save_run(state_path, state)
    with trader.BETS.open('a', encoding='utf-8') as fh:
        fh.write(json.dumps(bet, ensure_ascii=False, allow_nan=False) + '\n')
    return bet


def audit_run(path):
    state = read_run(path)
    current = trader.load_bets()
    initial = state['initial_bets']
    mutable = {'status', 'resolved_outcome', 'pnl_net', 'mark_yes_price', 'marked_at'}
    immutable = lambda b: {k: v for k, v in b.items() if k not in mutable}
    if len(current) < len(initial):
        raise ValueError('audit: historical bets removed')
    for before, after in zip(initial, current):
        if immutable(before) != immutable(after):
            raise ValueError('audit: historical entry changed')
    receipts = {r['bet']['bet_id']: r for r in state['receipts']}
    new = current[len(initial):]
    if len({b['bet_id'] for b in new}) != len(new):
        raise ValueError('audit: duplicate entry')
    for bet in new:
        receipt = receipts.get(bet['bet_id'])
        if not receipt or digest(immutable(bet)) != digest(immutable(receipt['bet'])):
            raise ValueError('audit: unreviewed or modified entry')
        if digest(receipt['bet']) != receipt['hash']:
            raise ValueError('audit: corrupted review receipt')
    return len(new)


if __name__ == '__main__':
    import sys
    try:
        command = sys.argv[1]
        path = os.environ.get('AGENT_TRADER_RUN_STATE')
        if not path:
            raise ValueError('AGENT_TRADER_RUN_STATE must name a private run state file')
        if command == 'begin':
            print('run initialized:', begin_run(path)['run_id'])
        elif command == 'audit':
            print('audited entries:', audit_run(path))
        else:
            raise ValueError('use begin or audit')
    except (ValueError, OSError, KeyError, IndexError) as exc:
        raise SystemExit(str(exc))
