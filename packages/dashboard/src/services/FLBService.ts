import { isDatabaseConfigured } from '../database/index.js';
import { getFLBConfig } from './FLBConfig.js';
import { FLBScanner } from './FLBScanner.js';
import { FLBExecutor } from './FLBExecutor.js';
import { FLBReconciler } from './FLBReconciler.js';

export class FLBService {
  private scanner = new FLBScanner();
  private executor = new FLBExecutor();
  private reconciler = new FLBReconciler();
  private scanTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private running = false;

  async start(): Promise<void> {
    const cfg = getFLBConfig();
    if (!cfg.enabled) {
      console.log('[FLB] disabled (FLB_EXECUTOR_ENABLED=false) — not starting');
      return;
    }
    if (!isDatabaseConfigured()) {
      console.warn('[FLB] database not configured — cannot start');
      return;
    }
    if (this.running) return;
    this.running = true;

    await this.executor.ensureFLBSchema();
    console.log(`[FLB] started (scan ${cfg.scanIntervalMs / 3_600_000}h, reconcile ${cfg.reconcileIntervalMs / 3_600_000}h, dryRun=${cfg.dryRun})`);

    await this.runScan();
    await this.runReconcile();

    this.scanTimer = setInterval(() => { this.runScan().catch(e => console.error('[FLB] scan failed:', e)); }, cfg.scanIntervalMs);
    this.reconcileTimer = setInterval(() => { this.runReconcile().catch(e => console.error('[FLB] reconcile failed:', e)); }, cfg.reconcileIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.scanTimer = this.reconcileTimer = null;
    this.running = false;
  }

  private async runScan(): Promise<void> {
    const cfg = getFLBConfig();
    const candidates = await this.scanner.scan(cfg);
    const r = await this.executor.executeCandidates(candidates, cfg);
    console.log(`[FLB] scan: candidates=${candidates.length} opened=${r.opened} rejected=${r.rejected} dryRun=${r.dryRunIntents}`);
  }

  private async runReconcile(): Promise<void> {
    const r = await this.reconciler.run();
    if (r.settled || r.voided || r.alerts) {
      console.log(`[FLB] reconcile: settled=${r.settled} voided=${r.voided} alerts=${r.alerts}`);
    }
  }
}

let instance: FLBService | null = null;
export function getFLBService(): FLBService {
  if (!instance) instance = new FLBService();
  return instance;
}
export function initializeFLBService(): FLBService {
  return getFLBService();
}
