import { describe, it, expect, beforeEach } from 'vitest';
import { buildFetchSQL, selectByTypeBudget, type SelectableMarket } from './PolymarketService.js';

const m = (id: string, marketType: string, volume = 100, marketScore = 0.5): SelectableMarket => ({
  id, marketType, volume, marketScore,
  // Other fields irrelevant for the budget selector.
} as SelectableMarket);

describe('selectByTypeBudget', () => {
  beforeEach(() => {
    delete process.env.ALLOWED_MARKET_TYPES;
  });

  it('returns empty when budgets is empty', () => {
    const ms = [m('a', 'event_long')];
    expect(selectByTypeBudget(ms, new Map(), 10, new Set())).toEqual([]);
  });

  it('honours per-type budgets when supply is sufficient', () => {
    const ms = [
      m('l1', 'event_long', 100), m('l2', 'event_long', 90), m('l3', 'event_long', 80),
      m('s1', 'event_short', 50), m('s2', 'event_short', 40),
    ];
    const budgets = new Map([['event_long', 2], ['event_short', 2]]);
    const picked = selectByTypeBudget(ms, budgets, 10, new Set()).map((x) => x.id).sort();
    expect(picked).toEqual(['l1', 'l2', 's1', 's2']);
  });

  it('redistributes underfill to ALLOWED types first', () => {
    process.env.ALLOWED_MARKET_TYPES = 'event_short,crypto_daily';
    const ms = [
      m('s1', 'event_short'), m('s2', 'event_short'), m('s3', 'event_short'),
      m('c1', 'crypto_daily'), m('c2', 'crypto_daily'),
      m('l1', 'event_long'), m('l2', 'event_long'), m('l3', 'event_long'),
    ];
    // Budgets: event_long=4 (only 3 supply → 1 leftover), event_short=2, crypto_daily=2.
    const budgets = new Map([['event_long', 4], ['event_short', 2], ['crypto_daily', 2]]);
    const picked = selectByTypeBudget(ms, budgets, 8, new Set()).map((x) => x.id).sort();
    // event_long picks all 3 (limited supply). 1 leftover slot → event_short or
    // crypto_daily (both allowed). Either is acceptable; assert count + supply
    // sources rather than exact ID.
    expect(picked.length).toBe(8);
    const counts = countByPrefix(picked);
    expect(counts.l).toBe(3);
    // 3 + 2 + 2 = 7; the 8th came from an allowed type.
    expect(counts.s + counts.c).toBe(5);
  });

  it('redistributes leftover to non-allowed types if no allowed surplus exists', () => {
    process.env.ALLOWED_MARKET_TYPES = 'event_short';
    const ms = [
      m('s1', 'event_short'),                                 // 1 supply
      m('l1', 'event_long'), m('l2', 'event_long'),
      m('l3', 'event_long'), m('l4', 'event_long'),           // 4 supply
    ];
    const budgets = new Map([['event_short', 3], ['event_long', 1]]);
    const picked = selectByTypeBudget(ms, budgets, 5, new Set()).map((x) => x.id).sort();
    // event_short can only fill 1 (supply limit); 2 budget unused. No allowed
    // surplus. Leftover goes to event_long.
    expect(picked).toContain('s1');
    expect(picked.filter((id) => id.startsWith('l')).length).toBeGreaterThanOrEqual(2);
    expect(picked.length).toBeLessThanOrEqual(5);
  });

  it('never exceeds maxTotal even if budgets sum higher', () => {
    const ms = [
      m('l1', 'event_long'), m('l2', 'event_long'), m('l3', 'event_long'),
      m('s1', 'event_short'), m('s2', 'event_short'),
    ];
    const budgets = new Map([['event_long', 5], ['event_short', 5]]);
    const picked = selectByTypeBudget(ms, budgets, 3, new Set());
    expect(picked.length).toBe(3);
  });

  it('excludes force-included markets from the per-type budget', () => {
    const ms = [
      m('forced1', 'event_long'), m('l1', 'event_long'), m('l2', 'event_long'),
    ];
    const budgets = new Map([['event_long', 2]]);
    const picked = selectByTypeBudget(ms, budgets, 10, new Set(['forced1']));
    // 'forced1' is excluded from per-type picks (caller adds it back separately).
    // event_long budget=2 → l1, l2.
    expect(picked.map((x) => x.id).sort()).toEqual(['l1', 'l2']);
  });

  it('uses within-bucket volume order (highest first)', () => {
    const ms = [
      m('low', 'event_short', 10), m('high', 'event_short', 100), m('mid', 'event_short', 50),
    ];
    const budgets = new Map([['event_short', 2]]);
    const picked = selectByTypeBudget(ms, budgets, 10, new Set());
    expect(picked.map((x) => x.id)).toEqual(['high', 'mid']);
  });
});

function countByPrefix(ids: string[]): Record<string, number> {
  const counts: Record<string, number> = { l: 0, s: 0, c: 0 };
  for (const id of ids) {
    const prefix = id[0];
    counts[prefix] = (counts[prefix] || 0) + 1;
  }
  return counts;
}

describe('buildFetchSQL', () => {
  it('returns the legacy single-query SQL when budgets is empty', () => {
    const { sql, perTypeMode } = buildFetchSQL(new Map());
    expect(perTypeMode).toBe(false);
    expect(sql).toContain('ORDER BY m.volume_24h DESC NULLS LAST');
    expect(sql).toContain('LIMIT $4');
    expect(sql).toContain('m.id = ANY($5::varchar[])');
    expect(sql).not.toContain('UNION ALL');
    // Legacy path KEEPS the volume filter (preserves prior behaviour).
    expect(sql).toContain('m.volume_24h >= $3');
  });

  it('builds one sub-query per type plus a force-include branch', () => {
    const budgets = new Map([['crypto_daily', 8], ['event_short', 12]]);
    const { sql, perTypeMode } = buildFetchSQL(budgets);
    expect(perTypeMode).toBe(true);
    expect(sql).toContain("m.market_type = 'crypto_daily'");
    expect(sql).toContain("m.market_type = 'event_short'");
    expect(sql).toContain('LIMIT 8');
    expect(sql).toContain('LIMIT 12');
    expect(sql).toContain('m.id = ANY($4::varchar[])');
    // 3 branches (2 types + 1 force-include) → 2 UNION ALL joins.
    expect(sql.split('UNION ALL').length).toBe(3);
    // Per-type path DROPS the volume filter — point of per-type allocation
    // is to surface low-volume types (event_short) the legacy MIN_VOLUME
    // filter excludes. Per-type LIMIT caps the result set instead.
    expect(sql).not.toContain('m.volume_24h >= $3');
  });

  it('drops types with unsafe characters from the SQL (defence in depth)', () => {
    const budgets = new Map([
      ['crypto_daily', 5],
      ["bobby'; DROP TABLE--", 5],  // SQL injection attempt
    ]);
    const { sql } = buildFetchSQL(budgets);
    expect(sql).toContain("m.market_type = 'crypto_daily'");
    expect(sql).not.toContain('DROP TABLE');
    expect(sql).not.toContain('bobby');
  });

  it('floors fractional budgets and clamps to a minimum of 1', () => {
    const budgets = new Map([['event_short', 0.5]]);
    const { sql } = buildFetchSQL(budgets);
    expect(sql).toContain('LIMIT 1');
  });
});
