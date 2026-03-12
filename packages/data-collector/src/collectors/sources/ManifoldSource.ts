import axios, { AxiosInstance } from 'axios';
import { pino } from 'pino';
import type { ExternalMarketData } from './MetaculusSource.js';

const logger = pino({ name: 'manifold-source' });

export class ManifoldSource {
  private baseUrl = 'https://api.manifold.markets/v0';
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 15000,
      headers: { Accept: 'application/json' },
    });
  }

  async fetchActiveMarkets(limit = 50): Promise<ExternalMarketData[]> {
    try {
      const response = await this.client.get('/markets', {
        params: {
          limit,
          sort: 'liquidity',
          filter: 'open',
        },
      });

      const markets: unknown[] = response.data ?? [];

      return markets
        .filter((m: any) => m.outcomeType === 'BINARY')
        .map((m: any) => ({
          id: m.id,
          question: m.question,
          platform: 'manifold',
          probability: m.probability ?? null,
          fetchedAt: new Date(),
        }));
    } catch (error) {
      logger.error({ error }, 'Error fetching Manifold markets');
      return [];
    }
  }

  async fetchMarketById(id: string): Promise<ExternalMarketData | null> {
    try {
      const response = await this.client.get(`/market/${id}`);
      const m = response.data;

      return {
        id: m.id,
        question: m.question,
        platform: 'manifold',
        probability: m.probability ?? null,
        fetchedAt: new Date(),
      };
    } catch (error) {
      logger.error({ error, id }, 'Error fetching Manifold market by id');
      return null;
    }
  }
}
