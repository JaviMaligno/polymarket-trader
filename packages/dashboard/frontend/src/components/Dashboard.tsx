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
import { useWebSocket } from '../hooks/useWebSocket';
import { formatCurrency, formatPercent, formatTime, cn, pnlColor } from '../lib/utils';
import * as api from '../lib/api';
import type { DashboardState, Position, Alert, PerformanceMetrics } from '../types/api';

export function Dashboard() {
  const [state, setState] = useState<DashboardState | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [performance, setPerformance] = useState<PerformanceMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Handle WebSocket messages
  const handleMessage = useCallback((message: { type: string; payload: unknown }) => {
    switch (message.type) {
      case 'state_update':
        setState(message.payload as DashboardState);
        break;
      case 'position_update':
        // Refresh positions
        api.getPositions().then((data) => setPositions(data as Position[]));
        break;
      case 'alert':
        setAlerts((prev) => [message.payload as Alert, ...prev].slice(0, 10));
        break;
    }
  }, []);

  const { isConnected } = useWebSocket({
    onMessage: handleMessage,
  });

  // Initial data fetch
  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        const [statusData, positionsData, alertsData, perfData] = await Promise.all([
          api.getStatus(),
          api.getPositions().catch(() => []),
          api.getAlerts(10).catch(() => []),
          api.getPerformance().catch(() => null),
        ]);
        setState(statusData as DashboardState);
        setPositions(positionsData as Position[]);
        setAlerts(alertsData as Alert[]);
        setPerformance(perfData as PerformanceMetrics);
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
      <div className="flex items-center justify-center h-screen">
        <RefreshCw className="w-8 h-8 animate-spin text-primary-500" />
      </div>
    );
  }

  const pnl = state?.totalPnl ?? 0;
  const pnlTrend = pnl > 0 ? 'up' : pnl < 0 ? 'down' : 'neutral';

  return (
    <div className="min-h-screen bg-slate-900 text-white p-6">
      {/* Header */}
      <header className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">Polymarket Trader</h1>
          <p className="text-slate-400 text-sm">Paper Trading Dashboard</p>
        </div>
        <div className="flex items-center gap-4">
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

      {/* Stats Row */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard
          title="Total Equity"
          value={formatCurrency(state?.equity ?? 0)}
          icon={<DollarSign className="w-5 h-5" />}
        />
        <StatCard
          title="Total P&L"
          value={formatCurrency(pnl)}
          trend={pnlTrend}
          icon={pnl >= 0 ? <TrendingUp className="w-5 h-5" /> : <TrendingDown className="w-5 h-5" />}
        />
        <StatCard
          title="Today's P&L"
          value={formatCurrency(state?.todayPnl ?? 0)}
          trend={(state?.todayPnl ?? 0) >= 0 ? 'up' : 'down'}
        />
        <StatCard
          title="Open Positions"
          value={state?.openPositions ?? 0}
          subtitle={`${state?.openOrders ?? 0} orders pending`}
          icon={<Activity className="w-5 h-5" />}
        />
      </div>

      {/* Performance Metrics */}
      {performance && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4 mb-6">
          <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-700/50">
            <p className="text-xs text-slate-400">Sharpe Ratio</p>
            <p className="text-lg font-semibold">{performance.sharpeRatio.toFixed(2)}</p>
          </div>
          <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-700/50">
            <p className="text-xs text-slate-400">Max Drawdown</p>
            <p className="text-lg font-semibold text-red-400">
              {formatPercent(performance.maxDrawdown)}
            </p>
          </div>
          <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-700/50">
            <p className="text-xs text-slate-400">Win Rate</p>
            <p className="text-lg font-semibold">{formatPercent(performance.winRate)}</p>
          </div>
          <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-700/50">
            <p className="text-xs text-slate-400">Profit Factor</p>
            <p className="text-lg font-semibold">{performance.profitFactor.toFixed(2)}</p>
          </div>
          <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-700/50">
            <p className="text-xs text-slate-400">Total Trades</p>
            <p className="text-lg font-semibold">{performance.totalTrades}</p>
          </div>
          <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-700/50">
            <p className="text-xs text-slate-400">Volatility</p>
            <p className="text-lg font-semibold">{formatPercent(performance.volatility)}</p>
          </div>
        </div>
      )}

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Equity Chart */}
        <div className="lg:col-span-2">
          <Card title="Equity Curve">
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={[
                    { time: '00:00', equity: 10000 },
                    { time: '04:00', equity: 10050 },
                    { time: '08:00', equity: 10120 },
                    { time: '12:00', equity: 10080 },
                    { time: '16:00', equity: 10200 },
                    { time: '20:00', equity: state?.equity ?? 10000 },
                  ]}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                  <XAxis dataKey="time" stroke="#9ca3af" fontSize={12} />
                  <YAxis stroke="#9ca3af" fontSize={12} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#1e293b',
                      border: '1px solid #374151',
                      borderRadius: '8px',
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="equity"
                    stroke="#0ea5e9"
                    fill="#0ea5e9"
                    fillOpacity={0.2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </div>

        {/* Alerts */}
        <Card title="Recent Alerts">
          <div className="space-y-3 max-h-64 overflow-y-auto">
            {alerts.length === 0 ? (
              <p className="text-slate-400 text-sm">No alerts</p>
            ) : (
              alerts.map((alert) => (
                <div
                  key={alert.id}
                  className={cn(
                    'p-3 rounded-lg border',
                    alert.severity === 'CRITICAL'
                      ? 'bg-red-900/30 border-red-700'
                      : alert.severity === 'ERROR'
                        ? 'bg-red-900/20 border-red-800'
                        : alert.severity === 'WARNING'
                          ? 'bg-yellow-900/20 border-yellow-800'
                          : 'bg-slate-800 border-slate-700'
                  )}
                >
                  <div className="flex items-start gap-2">
                    <AlertTriangle
                      className={cn(
                        'w-4 h-4 mt-0.5',
                        alert.severity === 'CRITICAL' || alert.severity === 'ERROR'
                          ? 'text-red-400'
                          : alert.severity === 'WARNING'
                            ? 'text-yellow-400'
                            : 'text-blue-400'
                      )}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{alert.title}</p>
                      <p className="text-xs text-slate-400 truncate">{alert.message}</p>
                    </div>
                    <span className="text-xs text-slate-500">
                      {formatTime(alert.timestamp)}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>

        {/* Positions */}
        <div className="lg:col-span-2">
          <Card title="Open Positions">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-slate-400 border-b border-slate-700">
                    <th className="pb-3 font-medium">Market</th>
                    <th className="pb-3 font-medium">Outcome</th>
                    <th className="pb-3 font-medium text-right">Size</th>
                    <th className="pb-3 font-medium text-right">Entry</th>
                    <th className="pb-3 font-medium text-right">Current</th>
                    <th className="pb-3 font-medium text-right">P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-slate-400">
                        No open positions
                      </td>
                    </tr>
                  ) : (
                    positions.map((pos) => (
                      <tr key={`${pos.marketId}-${pos.outcome}`} className="border-b border-slate-700/50">
                        <td className="py-3 font-mono text-xs truncate max-w-[150px]">
                          {pos.marketId.slice(0, 16)}...
                        </td>
                        <td className="py-3">{pos.outcome}</td>
                        <td className="py-3 text-right">{pos.size.toFixed(2)}</td>
                        <td className="py-3 text-right">{pos.avgEntryPrice.toFixed(4)}</td>
                        <td className="py-3 text-right">{pos.currentPrice.toFixed(4)}</td>
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

        {/* Risk Metrics */}
        <Card title="Risk Metrics">
          <div className="space-y-4">
            <div>
              <div className="flex justify-between text-sm mb-1">
                <span className="text-slate-400">Exposure</span>
                <span>{formatPercent(state?.exposure ?? 0)}</span>
              </div>
              <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary-500 rounded-full"
                  style={{ width: `${Math.min((state?.exposure ?? 0) * 100, 100)}%` }}
                />
              </div>
            </div>
            <div>
              <div className="flex justify-between text-sm mb-1">
                <span className="text-slate-400">Drawdown</span>
                <span className="text-red-400">{formatPercent(state?.drawdown ?? 0)}</span>
              </div>
              <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-red-500 rounded-full"
                  style={{ width: `${Math.min((state?.drawdown ?? 0) * 100, 100)}%` }}
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
      </div>
    </div>
  );
}
