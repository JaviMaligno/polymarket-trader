import axios, { AxiosInstance } from 'axios';
import { pino } from 'pino';

const logger = pino({ name: 'metaculus-source' });

export interface ExternalMarketData {
  id: string;
  question: string;
  platform: string;
  probability: number | null; // 0-1 probability forecast
  fetchedAt: Date;
}

export class MetaculusSource {
  private baseUrl = 'https://www.metaculus.com/api2';
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 15000,
      headers: { Accept: 'application/json' },
    });
  }

  async fetchActiveQuestions(limit = 50): Promise<ExternalMarketData[]> {
    try {
      const response = await this.client.get('/questions/', {
        params: {
          status: 'open',
          type: 'binary',
          limit,
          order_by: '-activity',
        },
      });

      const results: unknown[] = response.data?.results ?? [];

      return results.map((q: any) => ({
        id: String(q.id),
        question: q.title,
        platform: 'metaculus',
        probability: q.community_prediction?.full?.q2 ?? null,
        fetchedAt: new Date(),
      }));
    } catch (error) {
      logger.error({ error }, 'Error fetching Metaculus questions');
      return [];
    }
  }

  async fetchQuestionById(id: string): Promise<ExternalMarketData | null> {
    try {
      const response = await this.client.get(`/questions/${id}/`);
      const q = response.data;

      return {
        id: String(q.id),
        question: q.title,
        platform: 'metaculus',
        probability: q.community_prediction?.full?.q2 ?? null,
        fetchedAt: new Date(),
      };
    } catch (error) {
      logger.error({ error, id }, 'Error fetching Metaculus question by id');
      return null;
    }
  }
}
