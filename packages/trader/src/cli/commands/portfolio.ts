/**
 * Portfolio Commands
 *
 * Commands for viewing portfolio state, positions, and P&L.
 */

import {
  createTable,
  formatCurrency,
  formatPercent,
  formatDate,
  bold,
  cyan,
  green,
  red,
  yellow,
  dim,
  box,
  divider,
  pnlColor,
  statusBadge,
} from '../utils/display.js';
import { getContext } from '../utils/context.js';

// ============================================
// Portfolio Summary
// ============================================

export function showPortfolioSummary(): void {
  const ctx = getContext();

  if (!ctx.system) {
    console.log(red('System not initialized. Run "start" first.'));
    return;
  }

  const portfolio = ctx.system.engine.getPortfolioState();
  const stats = ctx.system.engine.getStatistics();

  console.log('\n' + bold(cyan('═══ PORTFOLIO SUMMARY ═══')) + '\n');

  // Main metrics
  const metricsTable = createTable(['Metric', 'Value']);

  const initialCapital = ctx.config.initialCapital;
  const totalReturn = (portfolio.equity - initialCapital) / initialCapital;

  metricsTable.push(
    ['Cash', formatCurrency(portfolio.cash)],
    ['Positions Value', formatCurrency(portfolio.equity - portfolio.cash)],
    ['Total Equity', bold(formatCurrency(portfolio.equity))],
    [divider(), divider()],
    ['Initial Capital', formatCurrency(initialCapital)],
    ['Total P&L', pnlColor(stats.totalPnl)],
    ['Total Return', formatPercent(totalReturn)],
    [divider(), divider()],
    ['Unrealized P&L', pnlColor(portfolio.totalUnrealizedPnl)],
    ['Realized P&L', pnlColor(portfolio.totalRealizedPnl)],
    [divider(), divider()],
    ['Total Trades', stats.totalTrades.toString()],
    ['Win Rate', formatPercent(stats.winRate)],
    ['Total Fees', red(formatCurrency(-stats.totalFees))],
  );

  console.log(metricsTable.toString());
  console.log();
}

// ============================================
// Positions
// ============================================

export function showPositions(): void {
  const ctx = getContext();

  if (!ctx.system) {
    console.log(red('System not initialized. Run "start" first.'));
    return;
  }

  const positions = ctx.system.engine.getAllPositions();

  console.log('\n' + bold(cyan('═══ OPEN POSITIONS ═══')) + '\n');

  if (positions.length === 0) {
    console.log(dim('No open positions'));
    console.log();
    return;
  }

  const table = createTable([
    'Market',
    'Outcome',
    'Size',
    'Entry',
    'Current',
    'P&L',
    'P&L %',
  ]);

  for (const pos of positions) {
    const pnlPct = pos.avgEntryPrice > 0
      ? (pos.currentPrice - pos.avgEntryPrice) / pos.avgEntryPrice
      : 0;

    table.push([
      pos.marketId.slice(0, 16) + '...',
      pos.outcome,
      pos.size.toFixed(2),
      pos.avgEntryPrice.toFixed(4),
      pos.currentPrice.toFixed(4),
      pnlColor(pos.unrealizedPnl),
      formatPercent(pnlPct),
    ]);
  }

  console.log(table.toString());

  // Summary
  const totalValue = positions.reduce((sum, p) => sum + p.size * p.currentPrice, 0);
  const totalPnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);

  console.log();
  console.log(`  Total Positions: ${bold(positions.length.toString())}`);
  console.log(`  Total Value: ${formatCurrency(totalValue)}`);
  console.log(`  Total Unrealized P&L: ${pnlColor(totalPnl)}`);
  console.log();
}

// ============================================
// Orders
// ============================================

export function showOrders(): void {
  const ctx = getContext();

  if (!ctx.system) {
    console.log(red('System not initialized. Run "start" first.'));
    return;
  }

  const orders = ctx.system.engine.getOpenOrders();

  console.log('\n' + bold(cyan('═══ OPEN ORDERS ═══')) + '\n');

  if (orders.length === 0) {
    console.log(dim('No open orders'));
    console.log();
    return;
  }

  const table = createTable([
    'ID',
    'Market',
    'Type',
    'Side',
    'Size',
    'Price',
    'Status',
    'Created',
  ]);

  for (const order of orders) {
    table.push([
      order.id.slice(0, 12),
      order.marketId.slice(0, 12) + '...',
      order.type,
      order.side === 'BUY' ? green(order.side) : red(order.side),
      order.size.toFixed(2),
      order.price?.toFixed(4) || '-',
      statusBadge(order.status),
      formatDate(order.createdAt),
    ]);
  }

  console.log(table.toString());
  console.log();
}

// ============================================
// Trade History
// ============================================

export function showTradeHistory(limit: number = 20): void {
  const ctx = getContext();

  if (!ctx.system) {
    console.log(red('System not initialized. Run "start" first.'));
    return;
  }

  const portfolio = ctx.system.engine.getPortfolioState();

  console.log('\n' + bold(cyan(`═══ RECENT TRADES (last ${limit}) ═══`)) + '\n');

  // Note: We'd need to track fills in the engine for full history
  // For now, show a placeholder message
  console.log(dim('Trade history tracking coming soon...'));
  console.log();
}

// ============================================
// Equity Curve
// ============================================

export function showEquityCurve(): void {
  const ctx = getContext();

  if (!ctx.system) {
    console.log(red('System not initialized. Run "start" first.'));
    return;
  }

  // Get equity from monitoring snapshot
  const snapshot = ctx.system.riskMonitor.getSnapshot();
  const equity = snapshot.trading.totalPnl + ctx.config.initialCapital;

  console.log('\n' + bold(cyan('═══ EQUITY CURVE ═══')) + '\n');

  // Simple ASCII chart
  const width = 50;
  const height = 10;
  const initialCapital = ctx.config.initialCapital;
  const currentEquity = ctx.system.engine.getEquity();

  // Create simple bar
  const change = currentEquity - initialCapital;
  const changePct = change / initialCapital;
  const barLength = Math.min(width, Math.abs(Math.round(changePct * width * 10)));

  console.log(`  Initial: ${formatCurrency(initialCapital)}`);
  console.log(`  Current: ${formatCurrency(currentEquity)}`);
  console.log(`  Change:  ${pnlColor(change)} (${formatPercent(changePct)})`);
  console.log();

  // Simple visual
  const bar = change >= 0
    ? green('█'.repeat(barLength))
    : red('█'.repeat(barLength));

  console.log(`  ${'─'.repeat(width)}`);
  console.log(`  ${bar}`);
  console.log(`  ${'─'.repeat(width)}`);
  console.log();
}

// ============================================
// Risk Exposure
// ============================================

export function showRiskExposure(): void {
  const ctx = getContext();

  if (!ctx.system) {
    console.log(red('System not initialized. Run "start" first.'));
    return;
  }

  const limits = ctx.system.riskMonitor.getRiskLimits();
  const snapshot = ctx.system.riskMonitor.getSnapshot();

  console.log('\n' + bold(cyan('═══ RISK EXPOSURE ═══')) + '\n');

  const table = createTable(['Limit', 'Current', 'Warning', 'Breach', 'Status']);

  for (const limit of limits) {
    const currentStr = limit.type.includes('Loss')
      ? formatCurrency(limit.value)
      : formatPercent(limit.value);

    const warningStr = limit.type.includes('Loss')
      ? formatCurrency(limit.warningThreshold)
      : formatPercent(limit.warningThreshold);

    const breachStr = limit.type.includes('Loss')
      ? formatCurrency(limit.breachThreshold)
      : formatPercent(limit.breachThreshold);

    table.push([
      limit.type,
      currentStr,
      yellow(warningStr),
      red(breachStr),
      statusBadge(limit.status),
    ]);
  }

  console.log(table.toString());

  // Additional risk metrics
  console.log();
  console.log(`  Portfolio Exposure: ${formatPercent(snapshot.risk.portfolioExposure)}`);
  console.log(`  Max Position Exposure: ${formatPercent(snapshot.risk.maxPositionExposure)}`);
  console.log(`  Concentration Risk: ${formatPercent(snapshot.risk.concentrationRisk)}`);
  console.log(`  Value at Risk (95%): ${formatCurrency(snapshot.risk.valueAtRisk)}`);
  console.log();

  if (ctx.system.riskMonitor.isTradingHalted()) {
    console.log(red(bold('  ⚠ TRADING IS HALTED')));
    console.log();
  }
}
