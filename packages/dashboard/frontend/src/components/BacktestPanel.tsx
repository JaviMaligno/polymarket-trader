/**
 * Backtest Panel Component
 * Run and view backtests
 */

import { useState, useEffect } from 'react';
import {
  Play,
  RefreshCw,
  TrendingUp,
  History,
  Calendar,
  DollarSign,
  BarChart3,
} from 'lucide-react';
import { Card } from './Card';
import * as api from '../lib/api';
import { cn, formatCurrency, formatPercent } from '../lib/utils';

interface BacktestResult {
  id: string;
  status: string;
  summary?: {
    startDate: string;
    endDate: string;
    initialCapital: number;
    finalCapital: number;
    totalReturn: number;
    totalTrades: number;
    winRate: number;
  };
  metrics?: {
    sharpeRatio: number;
    maxDrawdown: number;
    profitFactor: number;
    avgTradeReturn: number;
    winRate: number;
  };
}

export function BacktestPanel() {
  const [startDate, setStartDate] = useState('2025-12-01');
  const [endDate, setEndDate] = useState('2025-12-31');
  const [initialCapital, setInitialCapital] = useState(10000);
  const [signalTypes, setSignalTypes] = useState(['momentum', 'mean_reversion']);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [history, setHistory] = useState<BacktestResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getBacktestHistory()
      .then((data) => setHistory(data as BacktestResult[]))
      .catch(() => {});
  }, []);

  const handleRunBacktest = async () => {
    setRunning(true);
    setError(null);
    setResult(null);

    try {
      const res = await api.runBacktest({
        startDate,
        endDate,
        initialCapital,
        signalTypes,
      });
      setResult(res as BacktestResult);
      // Refresh history
      const newHistory = await api.getBacktestHistory();
      setHistory(newHistory as BacktestResult[]);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  const toggleSignalType = (type: string) => {
    setSignalTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]
    );
  };

  return (
    <div className="space-y-4">
      <Card title="Run Backtest" icon={<BarChart3 className="w-5 h-5" />}>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          {/* Date Range */}
          <div>
            <label className="block text-xs text-slate-400 mb-1">Start Date</label>
            <div className="relative">
              <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full pl-10 pr-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">End Date</label>
            <div className="relative">
              <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full pl-10 pr-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Initial Capital</label>
            <div className="relative">
              <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="number"
                value={initialCapital}
                onChange={(e) => setInitialCapital(Number(e.target.value))}
                className="w-full pl-10 pr-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>
        </div>

        {/* Signal Types */}
        <div className="mb-4">
          <label className="block text-xs text-slate-400 mb-2">Signal Types</label>
          <div className="flex flex-wrap gap-2">
            {['momentum', 'mean_reversion', 'wallet_tracking'].map((type) => (
              <button
                key={type}
                onClick={() => toggleSignalType(type)}
                className={cn(
                  'px-3 py-1.5 rounded-full text-xs font-medium transition-colors',
                  signalTypes.includes(type)
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                )}
              >
                {type.replace('_', ' ')}
              </button>
            ))}
          </div>
        </div>

        {/* Run Button */}
        <button
          onClick={handleRunBacktest}
          disabled={running || signalTypes.length === 0}
          className={cn(
            'w-full py-2 rounded-lg font-medium transition-colors flex items-center justify-center gap-2',
            'bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed'
          )}
        >
          {running ? (
            <>
              <RefreshCw className="w-4 h-4 animate-spin" />
              Running Backtest...
            </>
          ) : (
            <>
              <Play className="w-4 h-4" />
              Run Backtest
            </>
          )}
        </button>

        {error && (
          <div className="mt-4 p-3 bg-red-900/30 border border-red-700 rounded-lg text-red-300 text-sm">
            {error}
          </div>
        )}
      </Card>

      {/* Results */}
      {result && result.status === 'completed' && result.summary && result.metrics && (
        <Card title="Backtest Results" icon={<TrendingUp className="w-5 h-5" />}>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
            <div className="bg-slate-800/50 rounded-lg p-3">
              <p className="text-xs text-slate-400">Final Capital</p>
              <p className="text-lg font-semibold">
                {formatCurrency(result.summary.finalCapital)}
              </p>
            </div>
            <div className="bg-slate-800/50 rounded-lg p-3">
              <p className="text-xs text-slate-400">Total Return</p>
              <p
                className={cn(
                  'text-lg font-semibold',
                  result.summary.totalReturn >= 0 ? 'text-green-400' : 'text-red-400'
                )}
              >
                {formatPercent(result.summary.totalReturn)}
              </p>
            </div>
            <div className="bg-slate-800/50 rounded-lg p-3">
              <p className="text-xs text-slate-400">Total Trades</p>
              <p className="text-lg font-semibold">{result.summary.totalTrades}</p>
            </div>
            <div className="bg-slate-800/50 rounded-lg p-3">
              <p className="text-xs text-slate-400">Win Rate</p>
              <p className="text-lg font-semibold">{formatPercent(result.metrics.winRate)}</p>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-slate-800/50 rounded-lg p-3">
              <p className="text-xs text-slate-400">Sharpe Ratio</p>
              <p className="text-lg font-semibold">{result.metrics.sharpeRatio.toFixed(2)}</p>
            </div>
            <div className="bg-slate-800/50 rounded-lg p-3">
              <p className="text-xs text-slate-400">Max Drawdown</p>
              <p className="text-lg font-semibold text-red-400">
                {formatPercent(result.metrics.maxDrawdown)}
              </p>
            </div>
            <div className="bg-slate-800/50 rounded-lg p-3">
              <p className="text-xs text-slate-400">Profit Factor</p>
              <p className="text-lg font-semibold">{result.metrics.profitFactor.toFixed(2)}</p>
            </div>
            <div className="bg-slate-800/50 rounded-lg p-3">
              <p className="text-xs text-slate-400">Avg Trade Return</p>
              <p className="text-lg font-semibold">
                {formatPercent(result.metrics.avgTradeReturn)}
              </p>
            </div>
          </div>
        </Card>
      )}

      {/* History */}
      {history.length > 0 && (
        <Card title="Backtest History" icon={<History className="w-5 h-5" />}>
          <div className="space-y-2 max-h-60 overflow-y-auto">
            {history.slice(0, 10).map((bt) => (
              <div
                key={bt.id}
                className="flex items-center justify-between p-3 bg-slate-800/50 rounded-lg"
              >
                <div>
                  <p className="text-sm font-medium">{bt.id}</p>
                  <p className="text-xs text-slate-400">
                    {bt.summary?.startDate?.slice(0, 10)} - {bt.summary?.endDate?.slice(0, 10)}
                  </p>
                </div>
                <div className="text-right">
                  <p
                    className={cn(
                      'text-sm font-medium',
                      (bt.summary?.totalReturn ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'
                    )}
                  >
                    {formatPercent(bt.summary?.totalReturn ?? 0)}
                  </p>
                  <p className="text-xs text-slate-400">
                    {bt.summary?.totalTrades ?? 0} trades
                  </p>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
