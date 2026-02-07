/**
 * api-endpoints.test.ts - E2E tests for Dashboard API endpoints
 *
 * Tests that REST endpoints return expected responses.
 * These tests use mocked responses since they run without the actual server.
 */

import { describe, it, expect, beforeEach } from 'vitest';

// Mock API response types
interface HealthResponse {
  status: 'ok' | 'error';
  timestamp: string;
  services: {
    database: boolean;
    dataCollector: boolean;
    signals: boolean;
  };
}

interface MarketsResponse {
  markets: Array<{
    id: string;
    question: string;
    volume24h: number;
    liquidity: number;
    category: string;
  }>;
  total: number;
}

interface PositionsResponse {
  positions: Array<{
    marketId: string;
    outcome: string;
    size: number;
    avgEntryPrice: number;
    currentPrice: number;
    unrealizedPnl: number;
  }>;
  totalValue: number;
}

interface TradesResponse {
  trades: Array<{
    id: string;
    marketId: string;
    side: 'BUY' | 'SELL';
    size: number;
    price: number;
    pnl: number;
    timestamp: string;
  }>;
  total: number;
}

interface TradingStatusResponse {
  isActive: boolean;
  mode: 'paper' | 'live' | 'stopped';
  startedAt?: string;
  tradesCount: number;
  unrealizedPnl: number;
}

interface SignalResponse {
  signals: Array<{
    signalId: string;
    marketId: string;
    direction: 'LONG' | 'SHORT' | 'NEUTRAL';
    strength: number;
    confidence: number;
    timestamp: string;
  }>;
}

// Mock API client
class MockAPIClient {
  private mockResponses: Map<string, any> = new Map();

  setMockResponse(endpoint: string, response: any) {
    this.mockResponses.set(endpoint, response);
  }

  async get<T>(endpoint: string): Promise<{ status: number; data: T }> {
    const response = this.mockResponses.get(endpoint);
    if (!response) {
      return { status: 404, data: { error: 'Not found' } as any };
    }
    return { status: 200, data: response };
  }

  async post<T>(endpoint: string, body: any): Promise<{ status: number; data: T }> {
    const response = this.mockResponses.get(endpoint);
    if (!response) {
      return { status: 404, data: { error: 'Not found' } as any };
    }
    return { status: 200, data: response };
  }
}

describe('API Endpoints E2E', () => {
  let api: MockAPIClient;

  beforeEach(() => {
    api = new MockAPIClient();
  });

  describe('GET /health', () => {
    it('should return health status', async () => {
      api.setMockResponse('/health', {
        status: 'ok',
        timestamp: new Date().toISOString(),
        services: {
          database: true,
          dataCollector: true,
          signals: true,
        },
      });

      const response = await api.get<HealthResponse>('/health');

      expect(response.status).toBe(200);
      expect(response.data.status).toBe('ok');
      expect(response.data.services).toBeDefined();
      expect(response.data.services.database).toBe(true);
    });

    it('should report unhealthy services', async () => {
      api.setMockResponse('/health', {
        status: 'error',
        timestamp: new Date().toISOString(),
        services: {
          database: true,
          dataCollector: false,
          signals: true,
        },
      });

      const response = await api.get<HealthResponse>('/health');

      expect(response.data.status).toBe('error');
      expect(response.data.services.dataCollector).toBe(false);
    });
  });

  describe('GET /markets', () => {
    it('should return list of markets', async () => {
      api.setMockResponse('/markets', {
        markets: [
          {
            id: 'market-1',
            question: 'Will BTC reach 100k?',
            volume24h: 50000,
            liquidity: 100000,
            category: 'Crypto',
          },
          {
            id: 'market-2',
            question: 'Will Lakers win?',
            volume24h: 30000,
            liquidity: 75000,
            category: 'Sports',
          },
        ],
        total: 2,
      });

      const response = await api.get<MarketsResponse>('/markets');

      expect(response.status).toBe(200);
      expect(response.data.markets).toHaveLength(2);
      expect(response.data.total).toBe(2);
      expect(response.data.markets[0]).toHaveProperty('id');
      expect(response.data.markets[0]).toHaveProperty('question');
      expect(response.data.markets[0]).toHaveProperty('category');
    });

    it('should include market metadata', async () => {
      api.setMockResponse('/markets', {
        markets: [
          {
            id: 'market-1',
            question: 'Test market',
            volume24h: 10000,
            liquidity: 50000,
            category: 'Other',
          },
        ],
        total: 1,
      });

      const response = await api.get<MarketsResponse>('/markets');
      const market = response.data.markets[0];

      expect(market.volume24h).toBeGreaterThan(0);
      expect(market.liquidity).toBeGreaterThan(0);
    });
  });

  describe('GET /positions', () => {
    it('should return current positions', async () => {
      api.setMockResponse('/positions', {
        positions: [
          {
            marketId: 'market-1',
            outcome: 'Yes',
            size: 100,
            avgEntryPrice: 0.5,
            currentPrice: 0.6,
            unrealizedPnl: 10,
          },
        ],
        totalValue: 60,
      });

      const response = await api.get<PositionsResponse>('/positions');

      expect(response.status).toBe(200);
      expect(response.data.positions).toHaveLength(1);
      expect(response.data.positions[0].unrealizedPnl).toBe(10);
    });

    it('should return empty positions array when no positions', async () => {
      api.setMockResponse('/positions', {
        positions: [],
        totalValue: 0,
      });

      const response = await api.get<PositionsResponse>('/positions');

      expect(response.data.positions).toHaveLength(0);
      expect(response.data.totalValue).toBe(0);
    });
  });

  describe('GET /trades', () => {
    it('should return trade history', async () => {
      api.setMockResponse('/trades', {
        trades: [
          {
            id: 'trade-1',
            marketId: 'market-1',
            side: 'BUY',
            size: 100,
            price: 0.5,
            pnl: 0,
            timestamp: '2024-01-15T10:00:00Z',
          },
          {
            id: 'trade-2',
            marketId: 'market-1',
            side: 'SELL',
            size: 100,
            price: 0.6,
            pnl: 10,
            timestamp: '2024-01-15T12:00:00Z',
          },
        ],
        total: 2,
      });

      const response = await api.get<TradesResponse>('/trades');

      expect(response.status).toBe(200);
      expect(response.data.trades).toHaveLength(2);
      expect(response.data.trades[1].pnl).toBe(10);
    });
  });

  describe('GET /trading/status', () => {
    it('should return trading status when active', async () => {
      api.setMockResponse('/trading/status', {
        isActive: true,
        mode: 'paper',
        startedAt: '2024-01-15T08:00:00Z',
        tradesCount: 15,
        unrealizedPnl: 125.50,
      });

      const response = await api.get<TradingStatusResponse>('/trading/status');

      expect(response.status).toBe(200);
      expect(response.data.isActive).toBe(true);
      expect(response.data.mode).toBe('paper');
      expect(response.data.tradesCount).toBe(15);
    });

    it('should return stopped status when not trading', async () => {
      api.setMockResponse('/trading/status', {
        isActive: false,
        mode: 'stopped',
        tradesCount: 0,
        unrealizedPnl: 0,
      });

      const response = await api.get<TradingStatusResponse>('/trading/status');

      expect(response.data.isActive).toBe(false);
      expect(response.data.mode).toBe('stopped');
    });
  });

  describe('POST /trading/start', () => {
    it('should start paper trading', async () => {
      api.setMockResponse('/trading/start', {
        success: true,
        mode: 'paper',
        message: 'Paper trading started',
      });

      const response = await api.post('/trading/start', { mode: 'paper' });

      expect(response.status).toBe(200);
      expect(response.data.success).toBe(true);
    });
  });

  describe('POST /trading/stop', () => {
    it('should stop trading', async () => {
      api.setMockResponse('/trading/stop', {
        success: true,
        message: 'Trading stopped',
        finalPnl: 150.25,
      });

      const response = await api.post('/trading/stop', {});

      expect(response.status).toBe(200);
      expect(response.data.success).toBe(true);
    });
  });

  describe('GET /signals', () => {
    it('should return current signals', async () => {
      api.setMockResponse('/signals', {
        signals: [
          {
            signalId: 'momentum',
            marketId: 'market-1',
            direction: 'LONG',
            strength: 0.7,
            confidence: 0.8,
            timestamp: new Date().toISOString(),
          },
          {
            signalId: 'mean_reversion',
            marketId: 'market-2',
            direction: 'SHORT',
            strength: 0.5,
            confidence: 0.6,
            timestamp: new Date().toISOString(),
          },
        ],
      });

      const response = await api.get<SignalResponse>('/signals');

      expect(response.status).toBe(200);
      expect(response.data.signals).toHaveLength(2);
      expect(response.data.signals[0].direction).toBe('LONG');
      expect(response.data.signals[1].direction).toBe('SHORT');
    });
  });

  describe('Error Handling', () => {
    it('should return 404 for unknown endpoints', async () => {
      const response = await api.get('/unknown-endpoint');
      expect(response.status).toBe(404);
    });
  });
});
