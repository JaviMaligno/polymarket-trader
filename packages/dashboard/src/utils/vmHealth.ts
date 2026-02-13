/**
 * VM Health Monitoring Utilities
 *
 * Monitors memory and CPU usage to prevent VM overload during optimization.
 */

export interface VMHealthStatus {
  memoryUsagePct: number;
  heapUsedMB: number;
  heapTotalMB: number;
  isHealthy: boolean;
  shouldPause: boolean;
}

const MEMORY_WARNING_THRESHOLD = 0.75;  // 75%
const MEMORY_CRITICAL_THRESHOLD = 0.85; // 85%

/**
 * Check current VM health status
 */
export function checkVMHealth(): VMHealthStatus {
  const memUsage = process.memoryUsage();
  const heapUsedMB = memUsage.heapUsed / (1024 * 1024);
  const heapTotalMB = memUsage.heapTotal / (1024 * 1024);
  const memoryUsagePct = memUsage.heapUsed / memUsage.heapTotal;

  return {
    memoryUsagePct: memoryUsagePct * 100,
    heapUsedMB,
    heapTotalMB,
    isHealthy: memoryUsagePct < MEMORY_WARNING_THRESHOLD,
    shouldPause: memoryUsagePct >= MEMORY_CRITICAL_THRESHOLD,
  };
}

/**
 * Try to free memory via garbage collection
 */
export function tryFreeMemory(): void {
  if (global.gc) {
    global.gc();
    console.log('[VMHealth] Forced garbage collection');
  }
}

/**
 * Log current health status
 */
export function logHealthStatus(status: VMHealthStatus): void {
  const level = status.shouldPause ? 'CRITICAL' : status.isHealthy ? 'OK' : 'WARNING';
  console.log(`[VMHealth] ${level}: Memory ${status.memoryUsagePct.toFixed(1)}% (${status.heapUsedMB.toFixed(0)}MB / ${status.heapTotalMB.toFixed(0)}MB)`);
}
