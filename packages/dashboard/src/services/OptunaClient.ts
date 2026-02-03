/**
 * Optuna Client
 *
 * HTTP client for the Python Optuna optimization server.
 * Handles cold-start retries (Render free tier spins down after 15min idle).
 */

export interface ParameterDef {
  name: string;
  type: 'float' | 'int' | 'categorical';
  low?: number;
  high?: number;
  choices?: (string | number | boolean | null)[];
  log?: boolean;
}

interface CreateOptimizerResponse {
  optimizer_id: string;
  name: string;
  parameter_names: string[];
  created_at: string;
}

interface SuggestResponse {
  trial_ids: number[];
  suggestions: Record<string, any>[];
}

interface ReportResponse {
  recorded: boolean;
  best_score: number | null;
  best_params: Record<string, any> | null;
  n_trials: number;
}

interface BestParamsResponse {
  best_params: Record<string, any> | null;
  best_score: number | null;
  n_trials: number;
  optimization_history: Record<string, any>[];
}

export class OptunaClient {
  private baseUrl: string;
  private warmedUp = false;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  /**
   * Wake the server (Render cold start can take ~30s)
   */
  async ping(): Promise<boolean> {
    try {
      const res = await this.fetchWithRetry('/health', { method: 'GET' }, 3, 60_000);
      this.warmedUp = res.ok;
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Create a new optimizer session
   */
  async createOptimizer(
    name: string,
    parameters: ParameterDef[],
    options?: { direction?: string; sampler?: string; nStartupTrials?: number }
  ): Promise<string> {
    const res = await this.post<CreateOptimizerResponse>('/optimizer/create', {
      name,
      parameters,
      direction: options?.direction ?? 'maximize',
      sampler: options?.sampler ?? 'tpe',
      n_startup_trials: options?.nStartupTrials ?? 5,
    });
    return res.optimizer_id;
  }

  /**
   * Get next parameter suggestion from the optimizer
   */
  async suggest(optimizerId: string): Promise<{ trialId: number; params: Record<string, any> }> {
    const res = await this.post<SuggestResponse>('/optimizer/suggest', {
      optimizer_id: optimizerId,
      n_suggestions: 1,
    });
    return {
      trialId: res.trial_ids[0],
      params: res.suggestions[0],
    };
  }

  /**
   * Report trial result back to the optimizer
   */
  async report(
    optimizerId: string,
    trialId: number,
    score: number,
    metrics?: Record<string, number>
  ): Promise<ReportResponse> {
    return this.post<ReportResponse>('/optimizer/report', {
      optimizer_id: optimizerId,
      trial_id: trialId,
      score,
      metrics,
    });
  }

  /**
   * Get the best parameters found so far
   */
  async getBest(optimizerId: string): Promise<BestParamsResponse> {
    const res = await this.fetchWithRetry(`/optimizer/${optimizerId}/best`, { method: 'GET' });
    if (!res.ok) throw new Error(`getBest failed: ${res.status}`);
    return res.json() as Promise<BestParamsResponse>;
  }

  /**
   * Delete an optimizer session (cleanup)
   */
  async deleteOptimizer(optimizerId: string): Promise<void> {
    try {
      await this.fetchWithRetry(`/optimizer/${optimizerId}`, { method: 'DELETE' });
    } catch {
      // Best-effort cleanup
    }
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchWithRetry(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Optuna API ${path} failed (${res.status}): ${text}`);
    }
    return res.json() as Promise<T>;
  }

  private async fetchWithRetry(
    path: string,
    init: RequestInit,
    maxRetries = 3,
    timeoutMs?: number
  ): Promise<Response> {
    const timeout = timeoutMs ?? (this.warmedUp ? 15_000 : 60_000);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);

        const res = await fetch(`${this.baseUrl}${path}`, {
          ...init,
          signal: controller.signal,
        });

        clearTimeout(timer);
        this.warmedUp = true;
        return res;
      } catch (err) {
        if (attempt === maxRetries) throw err;

        const delay = Math.min(1000 * Math.pow(2, attempt), 30_000);
        console.log(`[OptunaClient] Retry ${attempt + 1}/${maxRetries} for ${path} in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }

    throw new Error('Unreachable');
  }
}
