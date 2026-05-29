import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseResolutionOutcome } from './GammaCollector.js';

vi.mock('../database/connection.js', () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

import { query } from '../database/connection.js';
import { GammaCollector } from './GammaCollector.js';

describe('parseResolutionOutcome', () => {
  it('YES outcome ["1","0"] → yes', () => {
    expect(parseResolutionOutcome('["1", "0"]')).toBe('yes');
  });
  it('NO outcome ["0","1"] → no', () => {
    expect(parseResolutionOutcome('["0", "1"]')).toBe('no');
  });
  it('near-1 yes price ≥0.99 → yes', () => {
    expect(parseResolutionOutcome('["0.995", "0.005"]')).toBe('yes');
  });
  it('near-0 yes price ≤0.01 → no', () => {
    expect(parseResolutionOutcome('["0.004", "0.996"]')).toBe('no');
  });
  it('50-50 / invalid → null', () => {
    expect(parseResolutionOutcome('["0.5", "0.5"]')).toBe(null);
  });
  it('empty array → null', () => {
    expect(parseResolutionOutcome('[]')).toBe(null);
  });
  it('malformed JSON → null', () => {
    expect(parseResolutionOutcome('not json')).toBe(null);
  });
  it('null/undefined → null', () => {
    expect(parseResolutionOutcome(null)).toBe(null);
    expect(parseResolutionOutcome(undefined)).toBe(null);
  });
});

describe('resolveOurMarkets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the one-shot column-ensure guard so each test runs the ALTER first
    // (keeps the call-index assumptions below stable).
    (GammaCollector as any).lastResolutionCheckColumnEnsured = false;
    delete process.env.RESOLUTION_BUDGET_PER_RUN;
    delete process.env.RESOLUTION_BATCH_SIZE;
    delete process.env.RESOLUTION_RECHECK_HOURS;
  });

  it('selects unresolved ended markets with the throttle + priority + budget', async () => {
    (query as any).mockResolvedValue({ rows: [] }); // ALTER, then SELECT returns no ids
    const c = new GammaCollector();
    await c.resolveOurMarkets();

    // First call is the idempotent ALTER; second is the SELECT.
    const selectSql = (query as any).mock.calls[1][0] as string;
    expect(selectSql).toMatch(/end_date < NOW\(\)/);
    expect(selectSql).toMatch(/NOT COALESCE\(m\.is_resolved, false\)/);
    expect(selectSql).toMatch(/last_resolution_check/);
    expect(selectSql).toMatch(/ORDER BY/);
    expect(selectSql).toMatch(/LIMIT/);
  });

  it('resolves returned closed markets and bumps absent ids', async () => {
    const c = new GammaCollector();
    (query as any)
      .mockResolvedValueOnce({ rows: [] })                        // ALTER
      .mockResolvedValueOnce({ rows: [{ id: 'A' }, { id: 'B' }] }) // SELECT
      .mockResolvedValue({ rows: [], rowCount: 1 });              // UPDATE (rowCount=1 → counted) + bumps

    // Gamma returns only A as closed (B still open → absent).
    // client is a private instance property; assign a mock directly.
    (c as any).client = {
      get: vi.fn().mockResolvedValue({
        data: [{ id: 'A', outcomePrices: '["1","0"]', closedTime: '2026-05-12 08:41:05+00' }],
      }),
    };

    const res = await c.resolveOurMarkets();
    expect(res.resolved).toBe(1);

    const updateA = (query as any).mock.calls.find((call: any[]) =>
      /UPDATE markets SET is_resolved=true/.test(call[0]) && call[1] && call[1][2] === 'A');
    expect(updateA).toBeTruthy();
    expect(updateA[1][0]).toBe('yes');
    expect(/COALESCE\(is_resolved,false\) ?= ?false/.test(updateA[0])).toBe(true);

    const bumpB = (query as any).mock.calls.find((call: any[]) =>
      /SET last_resolution_check = NOW\(\)/.test(call[0]) && call[1] && call[1][0] === 'B');
    expect(bumpB).toBeTruthy();
  });

  it('network failure on a batch does not throttle (no last_resolution_check bump)', async () => {
    const c = new GammaCollector();
    (query as any)
      .mockResolvedValueOnce({ rows: [] })             // ALTER
      .mockResolvedValueOnce({ rows: [{ id: 'A' }] })  // SELECT
      .mockResolvedValue({ rows: [] });
    (c as any).client = { get: vi.fn().mockRejectedValue(new Error('ECONNRESET')) };

    const res = await c.resolveOurMarkets();
    expect(res.resolved).toBe(0);
    const anyBump = (query as any).mock.calls.some((call: any[]) =>
      /SET last_resolution_check = NOW\(\)/.test(call[0]));
    expect(anyBump).toBe(false);
  });
});
