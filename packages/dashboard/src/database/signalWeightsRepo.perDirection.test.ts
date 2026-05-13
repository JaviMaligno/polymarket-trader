/**
 * PR-A 2026-05-13: per-direction signal_weights schema.
 *
 * Tests verify that the repository layer accepts the new optional `direction`
 * argument with a backwards-compatible default of '__all__'. Each method's SQL
 * carries the direction parameter so the upsert/lookup targets the 3-column PK
 * introduced by init/029_signal_weights_per_direction.sql.
 *
 * We don't test combiner fallback semantics here — that's PR-B's scope. PR-A's
 * goal is "no existing caller breaks; new direction parameter routes correctly".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./index.js', () => ({
  query: vi.fn(),
  transaction: vi.fn(async (fn) => {
    const fakeClient = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    return fn(fakeClient);
  }),
}));

import { query } from './index.js';
import { signalWeightsRepo } from './repositories.js';

describe('signalWeightsRepo per-direction parameter (PR-A)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (query as any).mockResolvedValue({ rows: [] });
  });

  describe('getAll', () => {
    it('defaults direction to "__all__"', async () => {
      await signalWeightsRepo.getAll();
      const [sql, params] = (query as any).mock.calls[0];
      expect(sql).toMatch(/direction = \$1/);
      expect(params).toEqual(['__all__']);
    });

    it('passes explicit direction through', async () => {
      await signalWeightsRepo.getAll('long');
      const [, params] = (query as any).mock.calls[0];
      expect(params).toEqual(['long']);
    });
  });

  describe('get', () => {
    it('defaults direction to "__all__"', async () => {
      await signalWeightsRepo.get('momentum');
      const [sql, params] = (query as any).mock.calls[0];
      expect(sql).toMatch(/AND direction = \$2/);
      expect(params).toEqual(['momentum', '__all__']);
    });

    it('passes explicit direction through', async () => {
      await signalWeightsRepo.get('momentum', 'short');
      const [, params] = (query as any).mock.calls[0];
      expect(params).toEqual(['momentum', 'short']);
    });
  });

  describe('getPerType', () => {
    it('defaults direction to "__all__"', async () => {
      await signalWeightsRepo.getPerType('mean_reversion', 'crypto_intraday');
      const [sql, params] = (query as any).mock.calls[0];
      expect(sql).toMatch(/AND direction = \$3/);
      expect(params).toEqual(['mean_reversion', 'crypto_intraday', '__all__']);
    });

    it('passes explicit direction through', async () => {
      await signalWeightsRepo.getPerType('mean_reversion', 'crypto_intraday', 'long');
      const [, params] = (query as any).mock.calls[0];
      expect(params).toEqual(['mean_reversion', 'crypto_intraday', 'long']);
    });
  });

  describe('getAllPerType', () => {
    it("filters on direction='__all__' so legacy callers see only the global-direction rows", async () => {
      await signalWeightsRepo.getAllPerType();
      const [sql] = (query as any).mock.calls[0];
      expect(sql).toMatch(/direction = '__all__'/);
    });
  });

  describe('updatePerType', () => {
    it('writes direction column with default "__all__" and 3-col ON CONFLICT', async () => {
      await signalWeightsRepo.updatePerType('momentum', 'event_financial', 0.5, 'test');
      const [sql, params] = (query as any).mock.calls[0];
      expect(sql).toMatch(/INSERT INTO signal_weights \(signal_type, market_type, direction, weight, updated_at\)/);
      expect(sql).toMatch(/ON CONFLICT \(signal_type, market_type, direction\)/);
      expect(params).toEqual(['momentum', 'event_financial', '__all__', 0.5]);
    });

    it('writes a per-direction row when direction is explicitly long', async () => {
      await signalWeightsRepo.updatePerType('mean_reversion', 'crypto_intraday', 0.8, 'optuna', 'long');
      const [, params] = (query as any).mock.calls[0];
      expect(params).toEqual(['mean_reversion', 'crypto_intraday', 'long', 0.8]);
    });
  });
});
