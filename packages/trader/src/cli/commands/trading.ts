/**
 * Trading Commands
 *
 * Commands for submitting orders and managing trades.
 */

import {
  bold,
  cyan,
  green,
  red,
  yellow,
  dim,
  formatCurrency,
  formatPercent,
  statusBadge,
  createTable,
  spinner,
} from '../utils/display.js';
import { getContext } from '../utils/context.js';
import type { OrderType, OrderSide } from '../../types/index.js';

// ============================================
// Submit Order
// ============================================

export async function submitOrder(
  marketId: string,
  outcome: string,
  side: OrderSide,
  size: number,
  type: OrderType = 'MARKET',
  price?: number
): Promise<void> {
  const ctx = getContext();

  if (!ctx.system) {
    console.log(red('System not initialized. Run "start" first.'));
    return;
  }

  if (!ctx.isRunning) {
    console.log(red('Trading not started. Run "start" first.'));
    return;
  }

  console.log();
  const spin = spinner();
  spin.start(`Submitting ${type} ${side} order...`);

  try {
    const order = await ctx.system.engine.submitOrder({
      marketId,
      outcome,
      type,
      side,
      size,
      price,
    });

    spin.stop();

    if (order.status === 'REJECTED') {
      console.log(red(`Order rejected`));
    } else if (order.status === 'FILLED') {
      console.log(green(`Order filled at ${order.avgFillPrice.toFixed(4)}`));
    } else {
      console.log(yellow(`Order ${statusBadge(order.status)}`));
    }

    console.log(`  Order ID: ${dim(order.id)}`);
    console.log(`  Market: ${marketId}`);
    console.log(`  ${side} ${size} @ ${price?.toFixed(4) || 'MARKET'}`);
    console.log();
  } catch (error) {
    spin.stop();
    console.log(red(`Failed to submit order: ${error}`));
    console.log();
  }
}

// ============================================
// Quick Trade Helpers
// ============================================

export async function buyMarket(
  marketId: string,
  outcome: string,
  size: number
): Promise<void> {
  await submitOrder(marketId, outcome, 'BUY', size, 'MARKET');
}

export async function sellMarket(
  marketId: string,
  outcome: string,
  size: number
): Promise<void> {
  await submitOrder(marketId, outcome, 'SELL', size, 'MARKET');
}

export async function buyLimit(
  marketId: string,
  outcome: string,
  size: number,
  price: number
): Promise<void> {
  await submitOrder(marketId, outcome, 'BUY', size, 'LIMIT', price);
}

export async function sellLimit(
  marketId: string,
  outcome: string,
  size: number,
  price: number
): Promise<void> {
  await submitOrder(marketId, outcome, 'SELL', size, 'LIMIT', price);
}

// ============================================
// Cancel Orders
// ============================================

export async function cancelOrder(orderId: string): Promise<void> {
  const ctx = getContext();

  if (!ctx.system) {
    console.log(red('System not initialized. Run "start" first.'));
    return;
  }

  const success = await ctx.system.engine.cancelOrder(orderId);

  if (success) {
    console.log(green(`Order ${orderId} cancelled`));
  } else {
    console.log(red(`Failed to cancel order ${orderId}`));
  }
  console.log();
}

export async function cancelAllOrders(): Promise<void> {
  const ctx = getContext();

  if (!ctx.system) {
    console.log(red('System not initialized. Run "start" first.'));
    return;
  }

  const count = await ctx.system.engine.cancelAllOrders();
  console.log(green(`Cancelled ${count} orders`));
  console.log();
}

// ============================================
// Close Positions
// ============================================

export async function closePosition(marketId: string, outcome: string): Promise<void> {
  const ctx = getContext();

  if (!ctx.system) {
    console.log(red('System not initialized. Run "start" first.'));
    return;
  }

  console.log();
  const spin = spinner();
  spin.start('Closing position...');

  try {
    const order = await ctx.system.engine.closePosition(marketId, outcome);

    spin.stop();

    if (order) {
      if (order.status === 'FILLED') {
        console.log(green('Position closed'));
        console.log(`  Closed ${order.filledSize} @ ${order.avgFillPrice.toFixed(4)}`);
      } else {
        console.log(yellow(`Close order ${statusBadge(order.status)}`));
      }
    } else {
      console.log(yellow('No position to close'));
    }
    console.log();
  } catch (error) {
    spin.stop();
    console.log(red(`Failed to close position: ${error}`));
    console.log();
  }
}

export async function closeAllPositions(): Promise<void> {
  const ctx = getContext();

  if (!ctx.system) {
    console.log(red('System not initialized. Run "start" first.'));
    return;
  }

  console.log();
  const spin = spinner();
  spin.start('Closing all positions...');

  try {
    const count = await ctx.system.engine.closeAllPositions();
    spin.stop();
    console.log(green(`Closed ${count} positions`));
    console.log();
  } catch (error) {
    spin.stop();
    console.log(red(`Failed to close positions: ${error}`));
    console.log();
  }
}

// ============================================
// Market Data
// ============================================

export function showMarketPrice(marketId: string): void {
  const ctx = getContext();

  if (!ctx.system) {
    console.log(red('System not initialized. Run "start" first.'));
    return;
  }

  const market = ctx.system.feed.getMarket(marketId);

  if (!market) {
    console.log(red(`Market ${marketId} not found or not subscribed`));
    console.log(dim('Use "watch <marketId>" to subscribe'));
    console.log();
    return;
  }

  console.log('\n' + bold(cyan('═══ MARKET INFO ═══')) + '\n');

  console.log(`  ${bold('Question:')} ${market.question}`);
  console.log(`  ${bold('Market ID:')} ${dim(market.id)}`);
  console.log(`  ${bold('Status:')} ${market.isActive ? green('Active') : red('Closed')}`);
  console.log(`  ${bold('End Date:')} ${market.endDate.toLocaleString()}`);
  console.log();

  const table = createTable(['Outcome', 'Price', 'Bid', 'Ask', 'Spread']);

  for (let i = 0; i < market.outcomes.length; i++) {
    const outcome = market.outcomes[i];
    const price = ctx.system.feed.getPrice(marketId, outcome);

    if (price) {
      table.push([
        outcome,
        formatPercent(price.price),
        formatPercent(price.bid),
        formatPercent(price.ask),
        formatPercent(price.spread),
      ]);
    } else {
      table.push([
        outcome,
        formatPercent(market.outcomePrices[i]),
        '-',
        '-',
        '-',
      ]);
    }
  }

  console.log(table.toString());

  console.log();
  console.log(`  ${bold('Volume:')} ${formatCurrency(market.volume)}`);
  console.log(`  ${bold('Liquidity:')} ${formatCurrency(market.liquidity)}`);
  console.log(`  ${bold('Last Update:')} ${market.lastUpdate.toLocaleString()}`);
  console.log();
}

// ============================================
// Watch Markets
// ============================================

export function watchMarket(marketId: string): void {
  const ctx = getContext();

  if (!ctx.system) {
    console.log(red('System not initialized. Run "start" first.'));
    return;
  }

  ctx.system.feed.subscribe(marketId);
  ctx.watchedMarkets.add(marketId);

  console.log(green(`Watching market ${marketId}`));
  console.log();
}

export function unwatchMarket(marketId: string): void {
  const ctx = getContext();

  if (!ctx.system) {
    console.log(red('System not initialized. Run "start" first.'));
    return;
  }

  ctx.system.feed.unsubscribe(marketId);
  ctx.watchedMarkets.delete(marketId);

  console.log(yellow(`Stopped watching market ${marketId}`));
  console.log();
}

export function showWatchedMarkets(): void {
  const ctx = getContext();

  if (!ctx.system) {
    console.log(red('System not initialized. Run "start" first.'));
    return;
  }

  console.log('\n' + bold(cyan('═══ WATCHED MARKETS ═══')) + '\n');

  const subscriptions = ctx.system.feed.getSubscriptions();

  if (subscriptions.length === 0) {
    console.log(dim('No markets being watched'));
    console.log(dim('Use "watch <marketId>" to subscribe'));
    console.log();
    return;
  }

  const table = createTable(['Market ID', 'Question', 'Price', 'Volume', 'Status']);

  for (const marketId of subscriptions) {
    const market = ctx.system.feed.getMarket(marketId);

    if (market) {
      table.push([
        marketId.slice(0, 16) + '...',
        market.question.slice(0, 40) + (market.question.length > 40 ? '...' : ''),
        formatPercent(market.outcomePrices[0]),
        formatCurrency(market.volume),
        market.isActive ? green('Active') : red('Closed'),
      ]);
    } else {
      table.push([
        marketId.slice(0, 16) + '...',
        dim('Loading...'),
        '-',
        '-',
        '-',
      ]);
    }
  }

  console.log(table.toString());
  console.log();
}
