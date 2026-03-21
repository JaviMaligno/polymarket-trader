/**
 * Main Dashboard Component
 */

import { useState, useEffect, useCallback } from 'react';
import {
  Activity,
  DollarSign,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  Play,
  Square,
  RefreshCw,
  Eye,
  BarChart3,
  ExternalLink,
} from 'lucide-react';
import {
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
} from 'recharts';

import { Card, StatCard } from './Card';
import { AutomationPanel } from './AutomationPanel';
import { useWebSocket } from '../hooks/useWebSocket';
import { formatCurrency, formatPercent, formatTime, cn, pnlColor } from '../lib/utils';
import * as api from '../lib/api';
import type { DashboardState, Position, Alert, PaperAccount } from '../types/api';

type TabId = 'overview' | 'automation';

interface EquityCurvePoint {
  time: string;
  value: number;
}

interface SignalWeight {
  signal_type: string;
  weight: number;
  is_enabled: boolean;
  min_confidence: number;
  updated_at: string;
}

interface PaperTrade {
  time: string;
  market_id: string;
  side: string;
  executed_size: number;
  executed_price: number;
  value_usd: number;
  signal_type: string;
  fee: number;
}

export function Dashboard() {
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [state, setState] = useState<DashboardState | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [paperAccount, setPaperAccount] = useState<PaperAccount | null>(null);
  const [equityCurve, setEquityCurve] = useState<EquityCurvePoint[]>([]);
  const [signalWeights, setSignalWeights] = useState<SignalWeight[]>([]);
  const [recentTrades, setRecentTrades] = useState<PaperTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Handle WebSocket messages
  const handleMessage = useCallback((message: { type: string; payload: unknown }) => {
    switch (message.type) {
      case 'state_update':
        setState(message.payload as DashboardState);
        break;
      case 'position_update':
        api.getPaperPositionsDB().then((data) => {
          setPositions(mapPositions(data as Array<Record<string, unknown>>));
        });
        break;
      case 'alert':
        setAlerts((prev) => [message.payload as Alert, ...prev].slice(0, 10));
        break;
    }
  }, []);

  const { isConnected } = useWebSocket({
    onMessage: handleMessage,
  });

  // Map backend snake_case positions to frontend camelCase
  function mapPositions(raw: Array<Record<string, unknown>>): Position[] {
    return raw.map((p) => ({
      marketId: (p.market_id as string) || '',
      outcome: (p.side as string) === 'long' ? 'YES' : 'NO',
      size: (p.size as number) || 0,
      avgEntryPrice: (p.avg_entry_price as number) || (p.entry_price as number) || 0,
      currentPrice: (p.current_price as number) || (p.avg_entry_price as number) || 0,
      unrealizedPnl: (p.unrealized_pnl as number) || 0,
      realizedPnl: (p.realized_pnl as number) || 0,
      openedAt: new Date((p.opened_at as string) || (p.entry_time as string) || Date.now()),
      signalType: (p.signal_type as string) || '',
    }));
  }

  // Initial data fetch
  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        const [
          statusData,
          positionsData,
          alertsData,
          accountData,
          equityData,
          weightsData,
          tradesData,
        ] = await Promise.all([
          api.getStatus(),
          api.getPaperPositionsDB().catch(() => []),
          api.getAlerts(10).catch(() => []),
          api.getPaperAccount().catch(() => null),
          api.getPortfolioEquityCurve(30).catch(() => []),
          api.getSignalWeights().catch(() => []),
          api.getRecentPaperTrades(10).catch(() => []),
        ]);
        setState(statusData as DashboardState);
        setPositions(mapPositions(positionsData as Array<Record<string, unknown>>));
        setAlerts(alertsData as Alert[]);
        setPaperAccount(accountData as PaperAccount | null);
        setEquityCurve(equityData as EquityCurvePoint[]);
        setSignalWeights(weightsData as SignalWeight[]);
        setRecentTrades(tradesData as PaperTrade[]);
      } catch (e) {
        setError(`Failed to load data: ${e}`);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, []);

  const handleStartSystem = async () => {
    try {
      await api.startSystem();
    } catch (e) {
      setError(`Failed to start system: ${e}`);
    }
  };

  const handleStopSystem = async () => {
    try {
      await api.stopSystem();
    } catch (e) {
      setError(`Failed to stop system: ${e}`);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-slate-900">
        <RefreshCw className="w-8 h-8 animate-spin text-blue-500" />
      </div>
    );
  }

  const pnl = paperAccount?.total_realized_pnl ?? state?.totalPnl ?? 0;
  const pnlTrend = pnl > 0 ? 'up' : pnl < 0 ? 'down' : 'neutral';
  const equity = paperAccount?.current_capital ?? state?.equity ?? 0;
  const equityTrend = pnl > 0 ? 'up' : pnl < 0 ? 'down' : 'neutral';
  const initialCapital = paperAccount?.initial_capital ?? 10000;
  const totalReturnPct = initialCapital > 0 ? (equity - initialCapital) / initialCapital : 0;
  const totalReturnTrend = totalReturnPct > 0 ? 'up' : totalReturnPct < 0 ? 'down' : 'neutral';
  const maxDrawdown = paperAccount?.max_drawdown ?? state?.drawdown ?? 0;

  // Format equity curve for Recharts
  const chartData = equityCurve.length > 0
    ? equityCurve.map((point) => ({
        date: new Date(point.time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        equity: point.value,
      }))
    : [{ date: 'Start', equity: initialCapital }, { date: 'Now', equity: equity }];

  return (
    <div className="min-h-screen bg-slate-900 text-white p-6">
      {/* Header */}
      <header className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">Polymarket Trader</h1>
          <p className="text-slate-400 text-sm">Automated Trading System — Paper Trading</p>
        </div>
        <div className="flex items-center gap-4">
          {/* Claude Auto-Review Indicator */}
          <a
            href="https://github.com/JaviMaligno/polymarket-trader/issues?q=is%3Aissue+label%3Adaily-review"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 px-3 py-1.5 bg-purple-900/30 border border-purple-700/50 rounded-lg text-sm hover:bg-purple-900/50 transition-colors"
          >
            <Eye className="w-3.5 h-3.5 text-purple-400" />
            <span className="text-purple-300">Auto-Review Active</span>
            <span className="text-purple-500 hidden md:inline">· Daily 08:00 UTC</span>
            <ExternalLink className="w-3 h-3 text-purple-500" />
          </a>
          <div className="flex items-center gap-2">
            <div
              className={cn(
                'w-2 h-2 rounded-full',
                isConnected ? 'bg-green-500' : 'bg-red-500'
              )}
            />
            <span className="text-sm text-slate-400">
              {isConnected ? 'Connected' : 'Disconnected'}
            </span>
          </div>
          {state?.isTrading ? (
            <button
              onClick={handleStopSystem}
              className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 rounded-lg transition-colors"
            >
              <Square className="w-4 h-4" />
              Stop
            </button>
          ) : (
            <button
              onClick={handleStartSystem}
              className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 rounded-lg transition-colors"
            >
              <Play className="w-4 h-4" />
              Start
            </button>
          )}
        </div>
      </header>

      {error && (
        <div className="mb-6 p-4 bg-red-900/50 border border-red-700 rounded-lg text-red-200">
          {error}
        </div>
      )}

      {/* Tab Navigation */}
      <div className="flex gap-2 mb-6 border-b border-slate-700 pb-2">
        {[
          { id: 'overview' as TabId, label: 'Overview' },
          { id: 'automation' as TabId, label: 'Automation' },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              'px-4 py-2 text-sm font-medium rounded-t-lg transition-colors',
              activeTab === tab.id
                ? 'bg-slate-800 text-white border-b-2 border-blue-500'
                : 'text-slate-400 hover:text-white hover:bg-slate-800/50'
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === 'automation' && <AutomationPanel />}

      {activeTab === 'overview' && (
        <>
      {/* Stats Row */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard
          title="Total Equity"
          value={formatCurrency(equity)}
          trend={equityTrend}
          subtitle={`Peak: ${formatCurrency(paperAccount?.peak_equity ?? equity)}`}
          icon={<DollarSign className="w-5 h-5" />}
        />
        <StatCard
          title="Total P&L"
          value={formatCurrency(pnl)}
          trend={pnlTrend}
          subtitle={initialCapital > 0 ? `${(pnl / initialCapital * 100).toFixed(1)}% return` : undefined}
          icon={pnl >= 0 ? <TrendingUp className="w-5 h-5" /> : <TrendingDown className="w-5 h-5" />}
        />
        <StatCard
          title="Total Return"
          value={formatPercent(totalReturnPct)}
          trend={totalReturnTrend}
          subtitle={paperAccount ? `${paperAccount.winning_trades}W / ${paperAccount.losing_trades}L (${paperAccount.win_rate.toFixed(1)}% win)` : undefined}
          icon={<BarChart3 className="w-5 h-5" />}
        />
        <StatCard
          title="Open Positions"
          value={positions.length || state?.openPositions || 0}
          subtitle={paperAccount ? `${paperAccount.total_trades} total trades` : `${state?.openOrders ?? 0} orders pending`}
          icon={<Activity className="w-5 h-5" />}
        />
      </div>

      {/* Performance Metrics — from paper account */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4 mb-6">
        <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-700/50">
          <p className="text-xs text-slate-400">Win Rate</p>
          <p className="text-lg font-semibold">
            {paperAccount ? `${paperAccount.win_rate.toFixed(1)}%` : 'N/A'}
          </p>
        </div>
        <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-700/50">
          <p className="text-xs text-slate-400">Max Drawdown</p>
          <p className="text-lg font-semibold text-red-400">
            {formatPercent(maxDrawdown)}
          </p>
        </div>
        <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-700/50">
          <p className="text-xs text-slate-400">Total Trades</p>
          <p className="text-lg font-semibold">{paperAccount?.total_trades ?? 0}</p>
        </div>
        <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-700/50">
          <p className="text-xs text-slate-400">Profit Factor</p>
          <p className="text-lg font-semibold">
            {paperAccount && paperAccount.losing_trades > 0
              ? (paperAccount.winning_trades / paperAccount.losing_trades).toFixed(2)
              : 'N/A'}
          </p>
        </div>
        <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-700/50">
          <p className="text-xs text-slate-400">Fees Paid</p>
          <p className="text-lg font-semibold text-yellow-400">
            {formatCurrency(paperAccount?.total_fees_paid ?? 0)}
          </p>
        </div>
        <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-700/50">
          <p className="text-xs text-slate-400">Avg Trade</p>
          <p className="text-lg font-semibold">
            {paperAccount && paperAccount.total_trades > 0
              ? formatCurrency(pnl / paperAccount.total_trades)
              : 'N/A'}
          </p>
        </div>
      </div>

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Equity Chart */}
        <div className="lg:col-span-2">
          <Card title="Equity Curve" icon={<TrendingUp className="w-4 h-4 text-blue-400" />}>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                  <XAxis
                    dataKey="date"
                    stroke="#9ca3af"
                    fontSize={12}
                    tickLine={false}
                  />
                  <YAxis
                    stroke="#9ca3af"
                    fontSize={12}
                    tickLine={false}
                    tickFormatter={(v: number) => `$${(v / 1000).toFixed(1)}k`}
                    domain={['dataMin - 200', 'dataMax + 200']}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#1e293b',
                      border: '1px solid #374151',
                      borderRadius: '8px',
                    }}
                    formatter={(value: number) => [formatCurrency(value), 'Equity']}
                    labelStyle={{ color: '#9ca3af' }}
                  />
                  <Area
                    type="monotone"
                    dataKey="equity"
                    stroke="#0ea5e9"
                    fill="url(#equityGradient)"
                    strokeWidth={2}
                  />
                  <defs>
                    <linearGradient id="equityGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#0ea5e9" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#0ea5e9" stopOpacity={0.05} />
                    </linearGradient>
                  </defs>
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </div>

        {/* Signal Weights */}
        <Card title="Signal Weights" icon={<BarChart3 className="w-4 h-4 text-purple-400" />}>
          <div className="space-y-3">
            {signalWeights.length === 0 ? (
              <p className="text-slate-400 text-sm">Loading weights...</p>
            ) : (
              signalWeights.map((sw) => (
                <div key={sw.signal_type}>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="text-slate-300 capitalize">
                      {sw.signal_type.replace('_', ' ')}
                    </span>
                    <span className="text-slate-400 font-mono">
                      {(sw.weight * 100).toFixed(0)}%
                    </span>
                  </div>
                  <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-purple-500 rounded-full transition-all"
                      style={{ width: `${Math.min(sw.weight * 100, 100)}%` }}
                    />
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>

        {/* Positions */}
        <div className="lg:col-span-2">
          <Card title="Open Positions" icon={<Activity className="w-4 h-4 text-green-400" />}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-slate-400 border-b border-slate-700">
                    <th className="pb-3 font-medium">Market</th>
                    <th className="pb-3 font-medium">Side</th>
                    <th className="pb-3 font-medium">Signal</th>
                    <th className="pb-3 font-medium text-right">Size</th>
                    <th className="pb-3 font-medium text-right">Entry</th>
                    <th className="pb-3 font-medium text-right">Current</th>
                    <th className="pb-3 font-medium text-right">P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-8 text-center text-slate-400">
                        No open positions — all capital available
                      </td>
                    </tr>
                  ) : (
                    positions.map((pos, i) => (
                      <tr key={`${pos.marketId}-${i}`} className="border-b border-slate-700/50">
                        <td className="py-3 font-mono text-xs truncate max-w-[120px]" title={pos.marketId}>
                          {pos.marketId.slice(0, 10)}...
                        </td>
                        <td className="py-3">
                          <span className={cn(
                            'px-2 py-0.5 rounded text-xs font-medium',
                            pos.outcome === 'YES' ? 'bg-green-900/50 text-green-400' : 'bg-red-900/50 text-red-400'
                          )}>
                            {pos.outcome}
                          </span>
                        </td>
                        <td className="py-3 text-xs text-slate-400 capitalize">
                          {(pos as Position & { signalType?: string }).signalType?.replace('_', ' ') || '—'}
                        </td>
                        <td className="py-3 text-right">{pos.size.toFixed(1)}</td>
                        <td className="py-3 text-right font-mono">{pos.avgEntryPrice.toFixed(3)}</td>
                        <td className="py-3 text-right font-mono">{pos.currentPrice.toFixed(3)}</td>
                        <td className={cn('py-3 text-right font-medium', pnlColor(pos.unrealizedPnl))}>
                          {formatCurrency(pos.unrealizedPnl)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </div>

        {/* Risk Metrics + Recent Trades */}
        <div className="space-y-6">
          <Card title="Risk Metrics" icon={<AlertTriangle className="w-4 h-4 text-yellow-400" />}>
            <div className="space-y-4">
              <div>
                <div className="flex justify-between text-sm mb-1">
                  <span className="text-slate-400">Max Drawdown</span>
                  <span className="text-red-400">{formatPercent(maxDrawdown)}</span>
                </div>
                <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-red-500 rounded-full"
                    style={{ width: `${Math.min(maxDrawdown * 100, 100)}%` }}
                  />
                </div>
                <p className="text-xs text-slate-500 mt-1">Max allowed: 15%</p>
              </div>
              <div>
                <div className="flex justify-between text-sm mb-1">
                  <span className="text-slate-400">Capital Utilization</span>
                  <span>
                    {paperAccount
                      ? formatPercent(1 - paperAccount.available_capital / paperAccount.current_capital)
                      : formatPercent(state?.exposure ?? 0)}
                  </span>
                </div>
                <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-500 rounded-full"
                    style={{
                      width: `${paperAccount
                        ? Math.min((1 - paperAccount.available_capital / paperAccount.current_capital) * 100, 100)
                        : Math.min((state?.exposure ?? 0) * 100, 100)}%`
                    }}
                  />
                </div>
              </div>
              {state?.isTradingHalted && (
                <div className="p-3 bg-red-900/30 border border-red-700 rounded-lg">
                  <div className="flex items-center gap-2 text-red-400">
                    <AlertTriangle className="w-4 h-4" />
                    <span className="text-sm font-medium">Trading Halted</span>
                  </div>
                </div>
              )}
            </div>
          </Card>

          {/* Recent Trades */}
          <Card title="Recent Trades">
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {recentTrades.length === 0 ? (
                <p className="text-slate-400 text-sm">No recent trades</p>
              ) : (
                recentTrades.slice(0, 8).map((trade, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between text-sm py-1.5 border-b border-slate-700/30 last:border-0"
                  >
                    <div className="flex items-center gap-2">
                      <span className={cn(
                        'px-1.5 py-0.5 rounded text-xs font-medium',
                        trade.side === 'buy' ? 'bg-green-900/50 text-green-400' : 'bg-red-900/50 text-red-400'
                      )}>
                        {trade.side.toUpperCase()}
                      </span>
                      <span className="text-slate-400 text-xs capitalize">
                        {trade.signal_type?.replace('_', ' ') || '—'}
                      </span>
                    </div>
                    <div className="text-right">
                      <span className="text-slate-300 font-mono">
                        {formatCurrency(trade.value_usd || (trade.executed_size * trade.executed_price))}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </Card>
        </div>
      </div>
        </>
      )}
    </div>
  );
}
