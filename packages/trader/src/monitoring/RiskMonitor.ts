/**
 * Risk Monitor
 *
 * Real-time monitoring of portfolio risk metrics.
 * Triggers alerts and actions when limits are breached.
 */

import pino from 'pino';
import { EventEmitter } from 'eventemitter3';
import type {
  Position,
  PortfolioState,
  RiskMetrics,
  TradingMetrics,
  MonitoringSnapshot,
  SystemMetrics,
  Alert,
  AlertSeverity,
} from '../types/index.js';
import type { PaperTradingEngine } from '../engine/PaperTradingEngine.js';

const logger = pino({ name: 'RiskMonitor' });

// ============================================
// Types
// ============================================

export interface RiskMonitorConfig {
  /** Monitor update interval (ms) */
  updateIntervalMs: number;
  /** Maximum portfolio exposure (0-1) */
  maxExposure: number;
  /** Maximum single position exposure (0-1) */
  maxPositionExposure: number;
  /** Maximum drawdown before alert (0-1) */
  maxDrawdown: number;
  /** Maximum drawdown before halt (0-1) */
  haltDrawdown: number;
  /** Maximum daily loss */
  maxDailyLoss: number;
  /** Maximum correlation between positions */
  maxCorrelation: number;
  /** Value at Risk confidence level */
  varConfidence: number;
  /** High water mark for drawdown calculation */
  highWaterMark: number;
}

export interface RiskMonitorEvents {
  'update': (snapshot: MonitoringSnapshot) => void;
  'alert': (alert: Alert) => void;
  'limit:warning': (limitType: string, value: number, threshold: number) => void;
  'limit:breach': (limitType: string, value: number, threshold: number) => void;
  'action:reduce': (reason: string) => void;
  'action:halt': (reason: string) => void;
}

export interface RiskLimit {
  type: string;
  value: number;
  warningThreshold: number;
  breachThreshold: number;
  status: 'OK' | 'WARNING' | 'BREACH';
}

// ============================================
// Default Configuration
// ============================================

const DEFAULT_CONFIG: RiskMonitorConfig = {
  updateIntervalMs: 1000,
  maxExposure: 0.8,
  maxPositionExposure: 0.2,
  maxDrawdown: 0.15,
  haltDrawdown: 0.25,
  maxDailyLoss: 1000,
  maxCorrelation: 0.8,
  varConfidence: 0.95,
  highWaterMark: 0,
};

// ============================================
// Risk Monitor
// ============================================

export class RiskMonitor extends EventEmitter<RiskMonitorEvents> {
  private config: RiskMonitorConfig;
  private engine: PaperTradingEngine;

  private updateInterval: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private isHalted: boolean = false;

  private highWaterMark: number;
  private dailyStartEquity: number;
  private dailyStartDate: string;
  private equityHistory: Array<{ timestamp: Date; value: number }> = [];
  private alertHistory: Alert[] = [];
  private alertCount: number = 0;

  constructor(engine: PaperTradingEngine, config?: Partial<RiskMonitorConfig>) {
    super();
    this.engine = engine;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.highWaterMark = config?.highWaterMark || engine.getEquity();
    this.dailyStartEquity = engine.getEquity();
    this.dailyStartDate = this.getTodayDateString();
  }

  // ============================================
  // Lifecycle
  // ============================================

  /**
   * Start the risk monitor
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('Risk monitor already running');
      return;
    }

    logger.info('Starting risk monitor');

    this.isRunning = true;
    this.isHalted = false;

    // Initial update
    this.update();

    // Start periodic updates
    this.updateInterval = setInterval(() => {
      this.update();
    }, this.config.updateIntervalMs);
  }

  /**
   * Stop the risk monitor
   */
  stop(): void {
    if (!this.isRunning) return;

    logger.info('Stopping risk monitor');

    this.isRunning = false;

    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  /**
   * Check if trading is halted
   */
  isTradingHalted(): boolean {
    return this.isHalted;
  }

  /**
   * Resume trading after halt
   */
  resumeTrading(): void {
    if (!this.isHalted) return;

    this.isHalted = false;
    logger.info('Trading resumed');

    this.createAlert('INFO', 'Trading Resumed', 'Trading has been manually resumed');
  }

  // ============================================
  // Monitoring
  // ============================================

  /**
   * Perform monitoring update
   */
  private update(): void {
    // Check for new day
    this.checkDayRollover();

    // Get current state
    const portfolio = this.engine.getPortfolioState();

    // Update equity history
    this.equityHistory.push({
      timestamp: new Date(),
      value: portfolio.equity,
    });

    // Keep last 24 hours of history
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    this.equityHistory = this.equityHistory.filter(e => e.timestamp.getTime() > cutoff);

    // Update high water mark
    if (portfolio.equity > this.highWaterMark) {
      this.highWaterMark = portfolio.equity;
    }

    // Calculate metrics
    const riskMetrics = this.calculateRiskMetrics(portfolio);
    const tradingMetrics = this.calculateTradingMetrics(portfolio);
    const systemMetrics = this.getSystemMetrics();

    // Check limits
    this.checkLimits(portfolio, riskMetrics);

    // Create snapshot
    const snapshot: MonitoringSnapshot = {
      timestamp: new Date(),
      system: systemMetrics,
      trading: tradingMetrics,
      risk: riskMetrics,
      positions: portfolio.positions,
      openOrders: portfolio.openOrders,
      recentAlerts: this.alertHistory.slice(-10),
    };

    this.emit('update', snapshot);
  }

  /**
   * Calculate risk metrics
   */
  private calculateRiskMetrics(portfolio: PortfolioState): RiskMetrics {
    const positions = portfolio.positions;
    const equity = portfolio.equity;

    // Portfolio exposure
    const totalPositionValue = positions.reduce(
      (sum, p) => sum + Math.abs(p.size * p.currentPrice),
      0
    );
    const portfolioExposure = equity > 0 ? totalPositionValue / equity : 0;

    // Max position exposure
    const maxPositionValue = positions.length > 0
      ? Math.max(...positions.map(p => Math.abs(p.size * p.currentPrice)))
      : 0;
    const maxPositionExposure = equity > 0 ? maxPositionValue / equity : 0;

    // Concentration risk (Herfindahl index)
    let concentrationRisk = 0;
    if (totalPositionValue > 0) {
      for (const pos of positions) {
        const weight = Math.abs(pos.size * pos.currentPrice) / totalPositionValue;
        concentrationRisk += weight * weight;
      }
    }

    // Correlation risk (simplified - would need historical data)
    const correlationRisk = 0; // Placeholder

    // Liquidity risk (based on position sizes vs market liquidity)
    const liquidityRisk = 0; // Placeholder - would need market liquidity data

    // Value at Risk (simplified historical VaR)
    const valueAtRisk = this.calculateVaR(equity);

    return {
      portfolioExposure,
      maxPositionExposure,
      concentrationRisk,
      correlationRisk,
      liquidityRisk,
      valueAtRisk,
    };
  }

  /**
   * Calculate trading metrics
   */
  private calculateTradingMetrics(portfolio: PortfolioState): TradingMetrics {
    const stats = this.engine.getStatistics();
    const equity = portfolio.equity;
    const initialCapital = this.config.highWaterMark || equity;

    // Drawdown
    const maxDrawdown = this.highWaterMark > 0
      ? (this.highWaterMark - Math.min(...this.equityHistory.map(e => e.value))) / this.highWaterMark
      : 0;

    const currentDrawdown = this.highWaterMark > 0
      ? (this.highWaterMark - equity) / this.highWaterMark
      : 0;

    // Daily P&L
    const todayPnl = equity - this.dailyStartEquity;

    // Calculate Sharpe (simplified - using equity history)
    const returns = this.calculateReturns();
    const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const stdReturn = this.stdDev(returns);
    const sharpeRatio = stdReturn > 0 ? (avgReturn * Math.sqrt(252)) / stdReturn : 0;

    return {
      totalTrades: stats.totalTrades,
      winRate: stats.winRate,
      profitFactor: 0, // Would need trade-by-trade data
      sharpeRatio,
      maxDrawdown,
      currentDrawdown,
      todayPnl,
      totalPnl: stats.totalPnl,
      avgTradeSize: 0, // Would need trade-by-trade data
      avgHoldTime: 0, // Would need trade-by-trade data
    };
  }

  /**
   * Calculate VaR from equity history
   */
  private calculateVaR(currentEquity: number): number {
    const returns = this.calculateReturns();
    if (returns.length < 10) return 0;

    // Sort returns
    const sorted = [...returns].sort((a, b) => a - b);

    // Get percentile
    const index = Math.floor((1 - this.config.varConfidence) * sorted.length);
    const varReturn = sorted[index] || 0;

    return Math.abs(varReturn * currentEquity);
  }

  /**
   * Calculate returns from equity history
   */
  private calculateReturns(): number[] {
    const returns: number[] = [];
    for (let i = 1; i < this.equityHistory.length; i++) {
      const prev = this.equityHistory[i - 1].value;
      const curr = this.equityHistory[i].value;
      if (prev > 0) {
        returns.push((curr - prev) / prev);
      }
    }
    return returns;
  }

  /**
   * Get system metrics
   */
  private getSystemMetrics(): SystemMetrics {
    return {
      cpuUsage: 0, // Would need process monitoring
      memoryUsage: process.memoryUsage().heapUsed / process.memoryUsage().heapTotal,
      eventQueueSize: 0,
      latencyMs: 0,
      uptime: process.uptime(),
      timestamp: new Date(),
    };
  }

  // ============================================
  // Limit Checking
  // ============================================

  /**
   * Check all risk limits
   */
  private checkLimits(portfolio: PortfolioState, metrics: RiskMetrics): void {
    // Exposure limits
    this.checkLimit('portfolioExposure', metrics.portfolioExposure, this.config.maxExposure);
    this.checkLimit('positionExposure', metrics.maxPositionExposure, this.config.maxPositionExposure);

    // Drawdown
    const currentDrawdown = this.highWaterMark > 0
      ? (this.highWaterMark - portfolio.equity) / this.highWaterMark
      : 0;

    this.checkLimit('drawdown', currentDrawdown, this.config.maxDrawdown);

    // Check halt drawdown
    if (currentDrawdown >= this.config.haltDrawdown && !this.isHalted) {
      this.haltTrading(`Drawdown ${(currentDrawdown * 100).toFixed(1)}% exceeded halt threshold`);
    }

    // Daily loss
    const dailyLoss = this.dailyStartEquity - portfolio.equity;
    if (dailyLoss > 0) {
      this.checkLimit('dailyLoss', dailyLoss, this.config.maxDailyLoss);

      if (dailyLoss >= this.config.maxDailyLoss && !this.isHalted) {
        this.haltTrading(`Daily loss $${dailyLoss.toFixed(2)} exceeded limit`);
      }
    }

    // Concentration
    this.checkLimit('concentration', metrics.concentrationRisk, 0.5);
  }

  /**
   * Check a single limit
   */
  private checkLimit(name: string, value: number, threshold: number): void {
    const warningThreshold = threshold * 0.8;

    if (value >= threshold) {
      this.emit('limit:breach', name, value, threshold);

      this.createAlert(
        'ERROR',
        `${name} Limit Breach`,
        `${name} at ${(value * 100).toFixed(1)}% exceeds ${(threshold * 100).toFixed(1)}% limit`
      );
    } else if (value >= warningThreshold) {
      this.emit('limit:warning', name, value, threshold);

      this.createAlert(
        'WARNING',
        `${name} Warning`,
        `${name} at ${(value * 100).toFixed(1)}% approaching ${(threshold * 100).toFixed(1)}% limit`
      );
    }
  }

  /**
   * Halt trading
   */
  private haltTrading(reason: string): void {
    this.isHalted = true;
    this.emit('action:halt', reason);

    this.createAlert('CRITICAL', 'Trading Halted', reason);
    logger.error({ reason }, 'Trading halted');
  }

  // ============================================
  // Alerts
  // ============================================

  /**
   * Create an alert
   */
  private createAlert(severity: AlertSeverity, title: string, message: string): Alert {
    const alert: Alert = {
      id: `alert_${++this.alertCount}`,
      severity,
      title,
      message,
      timestamp: new Date(),
      source: 'RiskMonitor',
      acknowledged: false,
    };

    this.alertHistory.push(alert);

    // Keep last 100 alerts
    if (this.alertHistory.length > 100) {
      this.alertHistory = this.alertHistory.slice(-100);
    }

    this.emit('alert', alert);
    return alert;
  }

  /**
   * Acknowledge an alert
   */
  acknowledgeAlert(alertId: string): void {
    const alert = this.alertHistory.find(a => a.id === alertId);
    if (alert) {
      alert.acknowledged = true;
    }
  }

  /**
   * Get recent alerts
   */
  getRecentAlerts(count: number = 10): Alert[] {
    return this.alertHistory.slice(-count);
  }

  /**
   * Get unacknowledged alerts
   */
  getUnacknowledgedAlerts(): Alert[] {
    return this.alertHistory.filter(a => !a.acknowledged);
  }

  // ============================================
  // Helpers
  // ============================================

  /**
   * Check for day rollover
   */
  private checkDayRollover(): void {
    const today = this.getTodayDateString();
    if (today !== this.dailyStartDate) {
      this.dailyStartEquity = this.engine.getEquity();
      this.dailyStartDate = today;
      logger.info({ date: today }, 'Day rollover');
    }
  }

  /**
   * Get today's date string
   */
  private getTodayDateString(): string {
    return new Date().toISOString().split('T')[0];
  }

  /**
   * Calculate standard deviation
   */
  private stdDev(values: number[]): number {
    if (values.length < 2) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
    return Math.sqrt(variance);
  }

  /**
   * Get current risk limits status
   */
  getRiskLimits(): RiskLimit[] {
    const portfolio = this.engine.getPortfolioState();
    const metrics = this.calculateRiskMetrics(portfolio);

    const currentDrawdown = this.highWaterMark > 0
      ? (this.highWaterMark - portfolio.equity) / this.highWaterMark
      : 0;

    const dailyLoss = Math.max(0, this.dailyStartEquity - portfolio.equity);

    const limits: RiskLimit[] = [
      {
        type: 'portfolioExposure',
        value: metrics.portfolioExposure,
        warningThreshold: this.config.maxExposure * 0.8,
        breachThreshold: this.config.maxExposure,
        status: this.getLimitStatus(metrics.portfolioExposure, this.config.maxExposure),
      },
      {
        type: 'positionExposure',
        value: metrics.maxPositionExposure,
        warningThreshold: this.config.maxPositionExposure * 0.8,
        breachThreshold: this.config.maxPositionExposure,
        status: this.getLimitStatus(metrics.maxPositionExposure, this.config.maxPositionExposure),
      },
      {
        type: 'drawdown',
        value: currentDrawdown,
        warningThreshold: this.config.maxDrawdown * 0.8,
        breachThreshold: this.config.maxDrawdown,
        status: this.getLimitStatus(currentDrawdown, this.config.maxDrawdown),
      },
      {
        type: 'dailyLoss',
        value: dailyLoss,
        warningThreshold: this.config.maxDailyLoss * 0.8,
        breachThreshold: this.config.maxDailyLoss,
        status: this.getLimitStatus(dailyLoss, this.config.maxDailyLoss),
      },
    ];

    return limits;
  }

  /**
   * Get limit status
   */
  private getLimitStatus(value: number, threshold: number): 'OK' | 'WARNING' | 'BREACH' {
    if (value >= threshold) return 'BREACH';
    if (value >= threshold * 0.8) return 'WARNING';
    return 'OK';
  }

  /**
   * Get monitoring snapshot
   */
  getSnapshot(): MonitoringSnapshot {
    const portfolio = this.engine.getPortfolioState();
    const riskMetrics = this.calculateRiskMetrics(portfolio);
    const tradingMetrics = this.calculateTradingMetrics(portfolio);
    const systemMetrics = this.getSystemMetrics();

    return {
      timestamp: new Date(),
      system: systemMetrics,
      trading: tradingMetrics,
      risk: riskMetrics,
      positions: portfolio.positions,
      openOrders: portfolio.openOrders,
      recentAlerts: this.alertHistory.slice(-10),
    };
  }
}

/**
 * Create a risk monitor
 */
export function createRiskMonitor(
  engine: PaperTradingEngine,
  config?: Partial<RiskMonitorConfig>
): RiskMonitor {
  return new RiskMonitor(engine, config);
}
