import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const scanMock = vi.fn();
const execMock = vi.fn();
const reconcileMock = vi.fn();
const ensureSchemaMock = vi.fn();

vi.mock('./FLBScanner.js', () => ({ FLBScanner: class { scan = scanMock; } }));
vi.mock('./FLBExecutor.js', () => ({
  FLBExecutor: class { ensureFLBSchema = ensureSchemaMock; executeCandidates = execMock; },
}));
vi.mock('./FLBReconciler.js', () => ({ FLBReconciler: class { run = reconcileMock; } }));
vi.mock('../database/index.js', () => ({ isDatabaseConfigured: () => true, query: vi.fn() }));

import { FLBService } from './FLBService.js';

beforeEach(() => {
  scanMock.mockReset(); execMock.mockReset(); reconcileMock.mockReset(); ensureSchemaMock.mockReset();
  scanMock.mockResolvedValue([]); execMock.mockResolvedValue({ opened: 0, rejected: 0, dryRunIntents: 0 });
  reconcileMock.mockResolvedValue({ settled: 0, voided: 0, alerts: 0 });
  delete process.env.FLB_EXECUTOR_ENABLED;
});
afterEach(() => { vi.useRealTimers(); });

describe('FLBService', () => {
  it('does nothing when disabled', async () => {
    const svc = new FLBService();
    await svc.start();
    expect(ensureSchemaMock).not.toHaveBeenCalled();
    expect(scanMock).not.toHaveBeenCalled();
    await svc.stop();
  });

  it('ensures schema and runs an initial scan + reconcile when enabled', async () => {
    process.env.FLB_EXECUTOR_ENABLED = 'true';
    const svc = new FLBService();
    await svc.start();
    expect(ensureSchemaMock).toHaveBeenCalledTimes(1);
    expect(scanMock).toHaveBeenCalledTimes(1);
    expect(reconcileMock).toHaveBeenCalledTimes(1);
    await svc.stop();
  });
});
