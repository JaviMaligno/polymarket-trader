/**
 * Tests for EnsembleOptimizer
 */

import { describe, it, expect } from 'vitest';
import {
  EnsembleOptimizer,
  createEnsembleOptimizer,
} from './EnsembleOptimizer.js';
import type { BacktestMetrics } from './ObjectiveFunctions.js';

// ============================================
// Helpers
// ============================================

function makeMetrics(overrides: Partial<BacktestMetrics> = {}): BacktestMetrics {
  return {
    totalReturn: 0.10,
    sharpeRatio: 1.2,
    maxDrawdown: -0.08,
    winRate: 0.55,
    profitFactor: 1.5,
    totalTrades: 40,
    averageTradeReturn: 0.004,
    volatility: 0.08,
    ...overrides,
  };
}

// ============================================
// Tests
// ============================================

describe('EnsembleOptimizer', () => {
  describe('createEnsembleOptimizer', () => {
    it('should create with default config', () => {
      const ensemble = createEnsembleOptimizer();
      expect(ensemble).toBeInstanceOf(EnsembleOptimizer);
    });

    it('should accept custom config', () => {
      const ensemble = createEnsembleOptimizer({
        numMembers: 5,
        aggregation: 'median',
        diversityMethods: ['random_seed'],
      });
      expect(ensemble).toBeInstanceOf(EnsembleOptimizer);
    });
  });

  describe('optimize', () => {
    it('should run multiple members and aggregate', async () => {
      const ensemble = createEnsembleOptimizer({
        numMembers: 3,
        aggregation: 'trimmed_mean',
        diversityMethods: ['random_seed'],
        evaluateEnsemble: false,
      });

      const optimizer = async (seed: number) => ({
        params: { rsiPeriod: 14 + seed % 5, stopLoss: 0.10 + (seed % 3) * 0.01 },
        metrics: makeMetrics({ sharpeRatio: 1.0 + (seed % 3) * 0.2 }),
        score: 1.0 + (seed % 3) * 0.2,
      });

      const result = await ensemble.optimize(optimizer);

      expect(result.members.length).toBe(3);
      expect(result.consensusParams).toBeDefined();
      expect(result.consensusParams.rsiPeriod).toBeDefined();
      expect(result.consensusParams.stopLoss).toBeDefined();
      expect(result.agreement.overallAgreement).toBeGreaterThan(0);
      expect(result.stability.overallStability).toBeGreaterThan(0);
      expect(result.assessment.confidence).toBeDefined();
    });

    it('should detect high agreement when members agree', async () => {
      const ensemble = createEnsembleOptimizer({
        numMembers: 5,
        aggregation: 'median',
        evaluateEnsemble: false,
      });

      // All members return nearly identical params
      const optimizer = async () => ({
        params: { rsiPeriod: 14, stopLoss: 0.10 },
        metrics: makeMetrics({ sharpeRatio: 1.5 }),
        score: 1.5,
      });

      const result = await ensemble.optimize(optimizer);

      expect(result.agreement.overallAgreement).toBe(1);
      expect(result.agreement.weakConsensus.length).toBe(0);
    });

    it('should detect low agreement when members disagree', async () => {
      const ensemble = createEnsembleOptimizer({
        numMembers: 5,
        aggregation: 'trimmed_mean',
        evaluateEnsemble: false,
      });

      let callCount = 0;
      const optimizer = async () => {
        callCount++;
        return {
          params: { rsiPeriod: callCount * 10, stopLoss: callCount * 0.05 },
          metrics: makeMetrics({ sharpeRatio: Math.random() * 2 }),
          score: Math.random() * 2,
        };
      };

      const result = await ensemble.optimize(optimizer);

      // Large spread in parameters → lower agreement
      expect(result.agreement.overallAgreement).toBeLessThan(1);
      expect(result.members.length).toBe(5);
    });

    it('should evaluate consensus if backtestRunner provided', async () => {
      const ensemble = createEnsembleOptimizer({
        numMembers: 3,
        evaluateEnsemble: true,
      });

      const optimizer = async () => ({
        params: { rsiPeriod: 14 },
        metrics: makeMetrics(),
        score: 1.0,
      });

      const backtestRunner = async () => ({
        metrics: makeMetrics({ sharpeRatio: 1.1, totalReturn: 0.08 }),
        score: 1.1,
      });

      const result = await ensemble.optimize(optimizer, backtestRunner);

      expect(result.consensusMetrics).not.toBeNull();
      expect(result.consensusMetrics!.sharpeRatio).toBe(1.1);
    });

    it('should generate meaningful assessment', async () => {
      const ensemble = createEnsembleOptimizer({
        numMembers: 5,
        evaluateEnsemble: false,
      });

      const optimizer = async () => ({
        params: { rsiPeriod: 14 },
        metrics: makeMetrics({ totalReturn: 0.10, sharpeRatio: 1.0 }),
        score: 1.0,
      });

      const result = await ensemble.optimize(optimizer);

      expect(['high', 'moderate', 'low']).toContain(result.assessment.confidence);
      expect(result.assessment.edgePersistenceProbability).toBeGreaterThanOrEqual(0);
      expect(result.assessment.edgePersistenceProbability).toBeLessThanOrEqual(1);
      expect(result.assessment.recommendation).toBeTruthy();
      expect(result.assessment.findings.length).toBeGreaterThan(0);
    });

    it('should assign different seeds and methods to members', async () => {
      const ensemble = createEnsembleOptimizer({
        numMembers: 4,
        diversityMethods: ['random_seed', 'data_subset'],
        evaluateEnsemble: false,
      });

      const seeds: number[] = [];
      const methods: string[] = [];

      const optimizer = async (seed: number, method: string) => {
        seeds.push(seed);
        methods.push(method);
        return {
          params: { rsiPeriod: 14 },
          metrics: makeMetrics(),
          score: 1.0,
        };
      };

      await ensemble.optimize(optimizer as any);

      // All seeds should be unique
      expect(new Set(seeds).size).toBe(4);
      // Methods should alternate
      expect(methods[0]).toBe('random_seed');
      expect(methods[1]).toBe('data_subset');
      expect(methods[2]).toBe('random_seed');
      expect(methods[3]).toBe('data_subset');
    });
  });
});
