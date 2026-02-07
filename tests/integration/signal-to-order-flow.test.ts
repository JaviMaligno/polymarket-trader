/**
 * signal-to-order-flow.test.ts - Integration tests for signal-to-order conversion
 */

import { describe, it, expect } from 'vitest';
import type { SignalDirection } from '../../packages/signals/src/core/types/signal.types.js';

// Types for testing
interface SignalOutput {
  signalId: string;
  marketId: string;
  tokenId: string;
  direction: SignalDirection;
  strength: number;
  confidence: number;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

interface OrderRequest {
  marketId: string;
  outcome: string;
  type: 'MARKET' | 'LIMIT';
  side: 'BUY' | 'SELL';
  size: number;
  price?: number;
}

interface RiskParams {
  maxPositionSizePct: number;
  maxExposurePct: number;
  minConfidence: number;
  minStrength: number;
}

// Simplified order generator for testing
function generateOrderFromSignal(
  signal: SignalOutput,
  portfolioValue: number,
  currentPosition: number,
  riskParams: RiskParams
): OrderRequest | null {
  // Check minimum thresholds
  if (signal.confidence < riskParams.minConfidence) {
    return null;
  }

  if (Math.abs(signal.strength) < riskParams.minStrength) {
    return null;
  }

  // Calculate position size based on strength and confidence
  const maxPositionSize = portfolioValue * (riskParams.maxPositionSizePct / 100);
  const sizeMultiplier = signal.confidence * Math.abs(signal.strength);
  const targetSize = maxPositionSize * sizeMultiplier;

  if (signal.direction === 'NEUTRAL') {
    // Close position if any
    if (currentPosition > 0) {
      return {
        marketId: signal.marketId,
        outcome: 'Yes',
        type: 'MARKET',
        side: 'SELL',
        size: currentPosition,
      };
    }
    return null;
  }

  if (signal.direction === 'LONG') {
    // Want to be long - buy if not already at target
    if (currentPosition < targetSize) {
      const buySize = targetSize - currentPosition;
      return {
        marketId: signal.marketId,
        outcome: 'Yes',
        type: 'MARKET',
        side: 'BUY',
        size: buySize,
      };
    }
    return null;
  }

  if (signal.direction === 'SHORT') {
    // In prediction markets, SHORT means selling existing position
    // or buying the opposite outcome
    if (currentPosition > 0) {
      return {
        marketId: signal.marketId,
        outcome: 'Yes',
        type: 'MARKET',
        side: 'SELL',
        size: Math.min(currentPosition, targetSize),
      };
    }
    // Buy the "No" outcome instead
    return {
      marketId: signal.marketId,
      outcome: 'No',
      type: 'MARKET',
      side: 'BUY',
      size: targetSize,
    };
  }

  return null;
}

describe('Signal to Order Flow', () => {
  const defaultRiskParams: RiskParams = {
    maxPositionSizePct: 10,
    maxExposurePct: 50,
    minConfidence: 0.3,
    minStrength: 0.2,
  };

  describe('Order Generation', () => {
    it('should generate BUY order for LONG signal', () => {
      const signal: SignalOutput = {
        signalId: 'momentum',
        marketId: 'market-123',
        tokenId: 'token-456',
        direction: 'LONG',
        strength: 0.7,
        confidence: 0.8,
        timestamp: new Date(),
      };

      const order = generateOrderFromSignal(signal, 10000, 0, defaultRiskParams);

      expect(order).not.toBeNull();
      expect(order?.side).toBe('BUY');
      expect(order?.outcome).toBe('Yes');
      expect(order?.marketId).toBe('market-123');
    });

    it('should generate SELL order for SHORT signal with position', () => {
      const signal: SignalOutput = {
        signalId: 'mean_reversion',
        marketId: 'market-123',
        tokenId: 'token-456',
        direction: 'SHORT',
        strength: -0.6,
        confidence: 0.7,
        timestamp: new Date(),
      };

      const order = generateOrderFromSignal(signal, 10000, 500, defaultRiskParams);

      expect(order).not.toBeNull();
      expect(order?.side).toBe('SELL');
      expect(order?.outcome).toBe('Yes');
    });

    it('should buy No outcome for SHORT signal without position', () => {
      const signal: SignalOutput = {
        signalId: 'mean_reversion',
        marketId: 'market-123',
        tokenId: 'token-456',
        direction: 'SHORT',
        strength: -0.5,
        confidence: 0.6,
        timestamp: new Date(),
      };

      const order = generateOrderFromSignal(signal, 10000, 0, defaultRiskParams);

      expect(order).not.toBeNull();
      expect(order?.side).toBe('BUY');
      expect(order?.outcome).toBe('No');
    });

    it('should close position for NEUTRAL signal', () => {
      const signal: SignalOutput = {
        signalId: 'combined',
        marketId: 'market-123',
        tokenId: 'token-456',
        direction: 'NEUTRAL',
        strength: 0.05,
        confidence: 0.5,
        timestamp: new Date(),
      };

      const order = generateOrderFromSignal(signal, 10000, 300, defaultRiskParams);

      expect(order).not.toBeNull();
      expect(order?.side).toBe('SELL');
      expect(order?.size).toBe(300);
    });

    it('should return null for NEUTRAL signal without position', () => {
      const signal: SignalOutput = {
        signalId: 'combined',
        marketId: 'market-123',
        tokenId: 'token-456',
        direction: 'NEUTRAL',
        strength: 0.0,
        confidence: 0.5,
        timestamp: new Date(),
      };

      const order = generateOrderFromSignal(signal, 10000, 0, defaultRiskParams);

      expect(order).toBeNull();
    });
  });

  describe('Risk Filtering', () => {
    it('should reject signal below minimum confidence', () => {
      const signal: SignalOutput = {
        signalId: 'momentum',
        marketId: 'market-123',
        tokenId: 'token-456',
        direction: 'LONG',
        strength: 0.8,
        confidence: 0.2, // Below 0.3 threshold
        timestamp: new Date(),
      };

      const order = generateOrderFromSignal(signal, 10000, 0, defaultRiskParams);

      expect(order).toBeNull();
    });

    it('should reject signal below minimum strength', () => {
      const signal: SignalOutput = {
        signalId: 'momentum',
        marketId: 'market-123',
        tokenId: 'token-456',
        direction: 'LONG',
        strength: 0.1, // Below 0.2 threshold
        confidence: 0.9,
        timestamp: new Date(),
      };

      const order = generateOrderFromSignal(signal, 10000, 0, defaultRiskParams);

      expect(order).toBeNull();
    });
  });

  describe('Position Sizing', () => {
    it('should size position based on strength and confidence', () => {
      const strongSignal: SignalOutput = {
        signalId: 'momentum',
        marketId: 'market-123',
        tokenId: 'token-456',
        direction: 'LONG',
        strength: 0.9,
        confidence: 0.9,
        timestamp: new Date(),
      };

      const weakSignal: SignalOutput = {
        signalId: 'momentum',
        marketId: 'market-123',
        tokenId: 'token-456',
        direction: 'LONG',
        strength: 0.3,
        confidence: 0.4,
        timestamp: new Date(),
      };

      const strongOrder = generateOrderFromSignal(strongSignal, 10000, 0, defaultRiskParams);
      const weakOrder = generateOrderFromSignal(weakSignal, 10000, 0, defaultRiskParams);

      expect(strongOrder!.size).toBeGreaterThan(weakOrder!.size);
    });

    it('should respect max position size', () => {
      const signal: SignalOutput = {
        signalId: 'momentum',
        marketId: 'market-123',
        tokenId: 'token-456',
        direction: 'LONG',
        strength: 1.0,
        confidence: 1.0,
        timestamp: new Date(),
      };

      const order = generateOrderFromSignal(signal, 10000, 0, defaultRiskParams);

      // Max position is 10% of 10000 = 1000
      expect(order!.size).toBeLessThanOrEqual(1000);
    });

    it('should not buy if already at target position', () => {
      const signal: SignalOutput = {
        signalId: 'momentum',
        marketId: 'market-123',
        tokenId: 'token-456',
        direction: 'LONG',
        strength: 0.5,
        confidence: 0.5,
        timestamp: new Date(),
      };

      // Already have a large position
      const order = generateOrderFromSignal(signal, 10000, 1000, defaultRiskParams);

      expect(order).toBeNull();
    });
  });

  describe('Order Type', () => {
    it('should generate MARKET orders', () => {
      const signal: SignalOutput = {
        signalId: 'momentum',
        marketId: 'market-123',
        tokenId: 'token-456',
        direction: 'LONG',
        strength: 0.6,
        confidence: 0.7,
        timestamp: new Date(),
      };

      const order = generateOrderFromSignal(signal, 10000, 0, defaultRiskParams);

      expect(order?.type).toBe('MARKET');
    });
  });
});
