import { describe, it, expect } from 'vitest';

/**
 * Standalone computeDecayFactor for testing — mirrors the implementation.
 * Takes array of { bestScore, oosScore } rows, returns p25 of ratios.
 */
function computeDecayFactor(
  rows: Array<{ bestScore: number; oosScore: number }>,
  coldStartDefault = 0.3,
  minRows = 10,
): number {
  if (rows.length < minRows) return coldStartDefault;

  const ratios = rows
    .filter(r => r.bestScore > 0)
    .map(r => r.oosScore / r.bestScore)
    .sort((a, b) => a - b);

  if (ratios.length < minRows) return coldStartDefault;

  const idx = Math.floor(ratios.length * 0.25);
  return ratios[idx];
}

/**
 * Standalone adaptive OOS gate for testing — mirrors the implementation.
 */
function shouldDeploy(
  isScore: number,
  oosScore: number,
  drawdownOOS: number,
  tradesOOS: number,
  decayFactor: number,
): { passed: boolean; reason?: string } {
  // Safety floor
  if (isScore <= 0) return { passed: false, reason: 'IS Sharpe <= 0' };
  if (tradesOOS < 20) return { passed: false, reason: `Trades ${tradesOOS} < 20` };
  if (oosScore < -1.0) return { passed: false, reason: `OOS Sharpe ${oosScore} < -1.0` };
  if (Math.abs(drawdownOOS) > 0.50) return { passed: false, reason: `Drawdown ${drawdownOOS} > 50%` };

  // Adaptive gate
  const threshold = isScore * decayFactor;
  if (oosScore >= threshold) return { passed: true };
  return { passed: false, reason: `OOS ${oosScore.toFixed(3)} < IS ${isScore.toFixed(3)} * decay ${decayFactor.toFixed(3)} = ${threshold.toFixed(3)}` };
}

describe('computeDecayFactor', () => {
  it('returns cold start default when fewer than 10 rows', () => {
    const rows = Array.from({ length: 9 }, (_, i) => ({ bestScore: 1.0, oosScore: 0.5 }));
    expect(computeDecayFactor(rows)).toBe(0.3);
  });

  it('returns p25 of ratios when enough data', () => {
    const ratios = [0.1, 0.2, 0.3, 0.4, 0.5, 0.5, 0.6, 0.7, 0.8, 0.8, 0.9, 1.0];
    const rows = ratios.map(r => ({ bestScore: 1.0, oosScore: r }));
    // p25 index = floor(12 * 0.25) = 3 → ratios[3] = 0.4
    expect(computeDecayFactor(rows)).toBe(0.4);
  });

  it('filters out rows with bestScore <= 0', () => {
    const goodRows = Array.from({ length: 10 }, () => ({ bestScore: 1.0, oosScore: 0.6 }));
    const badRows = [{ bestScore: 0, oosScore: 0.5 }, { bestScore: -1, oosScore: 0.3 }];
    expect(computeDecayFactor([...goodRows, ...badRows])).toBe(0.6);
  });

  it('returns cold start when all bestScores are <= 0', () => {
    const rows = Array.from({ length: 15 }, () => ({ bestScore: -0.5, oosScore: 0.1 }));
    expect(computeDecayFactor(rows)).toBe(0.3);
  });

  it('handles negative OOS/IS ratios correctly', () => {
    const rows = [
      ...Array.from({ length: 5 }, () => ({ bestScore: 1.0, oosScore: -0.5 })),
      ...Array.from({ length: 5 }, () => ({ bestScore: 1.0, oosScore: 0.8 })),
      ...Array.from({ length: 2 }, () => ({ bestScore: 1.0, oosScore: 0.3 })),
    ];
    // sorted ratios: [-0.5, -0.5, -0.5, -0.5, -0.5, 0.3, 0.3, 0.8, 0.8, 0.8, 0.8, 0.8]
    // p25 index = floor(12 * 0.25) = 3 → -0.5
    expect(computeDecayFactor(rows)).toBe(-0.5);
  });
});

describe('shouldDeploy (adaptive OOS gate)', () => {
  const defaultDecay = 0.3;

  it('rejects when IS Sharpe <= 0', () => {
    const result = shouldDeploy(0, 0.5, 0.1, 50, defaultDecay);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('IS Sharpe <= 0');
  });

  it('rejects when trades < 20', () => {
    const result = shouldDeploy(1.0, 0.5, 0.1, 15, defaultDecay);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('Trades 15 < 20');
  });

  it('rejects when OOS Sharpe < -1.0', () => {
    const result = shouldDeploy(1.0, -1.5, 0.1, 50, defaultDecay);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('OOS Sharpe');
  });

  it('rejects when drawdown > 50%', () => {
    const result = shouldDeploy(1.0, 0.5, -0.55, 50, defaultDecay);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('Drawdown');
  });

  it('passes when OOS >= IS * decay', () => {
    const result = shouldDeploy(1.0, 0.4, 0.1, 50, 0.3);
    expect(result.passed).toBe(true);
  });

  it('rejects when OOS < IS * decay', () => {
    const result = shouldDeploy(1.0, 0.3, 0.1, 50, 0.5);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('OOS 0.300 < IS 1.000 * decay 0.500');
  });

  it('handles high IS Sharpe naturally (no special case)', () => {
    const result = shouldDeploy(5.0, 2.0, 0.1, 50, 0.45);
    expect(result.passed).toBe(false);
  });

  it('works with negative decay factor', () => {
    const result = shouldDeploy(1.0, -0.3, 0.1, 50, -0.5);
    expect(result.passed).toBe(true);
  });
});
