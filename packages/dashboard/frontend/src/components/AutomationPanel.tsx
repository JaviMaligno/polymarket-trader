/**
 * Automation Panel Component
 * Shows status and controls for automation services
 */

import { useState, useEffect } from 'react';
import {
  Play,
  Square,
  RefreshCw,
  Zap,
  TrendingUp,
  Database,
  Shield,
  Cpu,
} from 'lucide-react';
import { Card } from './Card';
import * as api from '../lib/api';
import { cn } from '../lib/utils';

interface AutomationStatus {
  isRunning: boolean;
  executor: {
    enabled: boolean;
    dailyTrades: number;
  };
  learning: {
    enabled: boolean;
    lastEvaluation: string | null;
  };
  collector: {
    enabled: boolean;
    recordCount: number;
  };
  risk: {
    enabled: boolean;
    isHalted: boolean;
    haltReason: string | null;
  };
}

interface SignalEngineStatus {
  isRunning: boolean;
  signalCount: number;
  marketCount: number;
  lastCompute: string | null;
  signalsGenerated: number;
}

interface PolymarketStatus {
  isRunning: boolean;
  marketCount: number;
  lastUpdate: string | null;
  errorCount: number;
}

export function AutomationPanel() {
  const [automation, setAutomation] = useState<AutomationStatus | null>(null);
  const [signalEngine, setSignalEngine] = useState<SignalEngineStatus | null>(null);
  const [polymarket, setPolymarket] = useState<PolymarketStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchStatus = async () => {
    try {
      const [autoStatus, signalStatus, polyStatus] = await Promise.all([
        api.getAutomationStatus().catch(() => null),
        api.getSignalEngineStatus().catch(() => null),
        api.getPolymarketStatus().catch(() => null),
      ]);
      setAutomation(autoStatus as AutomationStatus);
      setSignalEngine(signalStatus as SignalEngineStatus);
      setPolymarket(polyStatus as PolymarketStatus);
    } catch (e) {
      console.error('Failed to fetch status:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 10000);
    return () => clearInterval(interval);
  }, []);

  const handleAction = async (action: string, fn: () => Promise<unknown>) => {
    setActionLoading(action);
    try {
      await fn();
      await fetchStatus();
    } catch (e) {
      console.error(`Action ${action} failed:`, e);
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return (
      <Card title="Automation Services">
        <div className="flex items-center justify-center py-8">
          <RefreshCw className="w-6 h-6 animate-spin text-slate-400" />
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Main Automation Control */}
      <Card title="Automation Services" icon={<Cpu className="w-5 h-5" />}>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {/* Trading Automation */}
          <div className="bg-slate-800/50 rounded-lg p-4 border border-slate-700/50">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Zap className="w-4 h-4 text-yellow-400" />
                <span className="text-sm font-medium">Automation</span>
              </div>
              <div
                className={cn(
                  'w-2 h-2 rounded-full',
                  automation?.isRunning ? 'bg-green-500' : 'bg-slate-500'
                )}
              />
            </div>
            <p className="text-xs text-slate-400 mb-2">
              Trades today: {automation?.executor.dailyTrades ?? 0}
            </p>
            <button
              onClick={() =>
                handleAction(
                  'automation',
                  automation?.isRunning ? api.stopAutomation : api.startAutomation
                )
              }
              disabled={actionLoading === 'automation'}
              className={cn(
                'w-full py-1.5 px-3 rounded text-xs font-medium transition-colors flex items-center justify-center gap-1',
                automation?.isRunning
                  ? 'bg-red-600 hover:bg-red-700'
                  : 'bg-green-600 hover:bg-green-700',
                actionLoading === 'automation' && 'opacity-50'
              )}
            >
              {actionLoading === 'automation' ? (
                <RefreshCw className="w-3 h-3 animate-spin" />
              ) : automation?.isRunning ? (
                <>
                  <Square className="w-3 h-3" /> Stop
                </>
              ) : (
                <>
                  <Play className="w-3 h-3" /> Start
                </>
              )}
            </button>
          </div>

          {/* Signal Engine */}
          <div className="bg-slate-800/50 rounded-lg p-4 border border-slate-700/50">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-blue-400" />
                <span className="text-sm font-medium">Signals</span>
              </div>
              <div
                className={cn(
                  'w-2 h-2 rounded-full',
                  signalEngine?.isRunning ? 'bg-green-500' : 'bg-slate-500'
                )}
              />
            </div>
            <p className="text-xs text-slate-400 mb-2">
              Markets: {signalEngine?.marketCount ?? 0} | Generated: {signalEngine?.signalsGenerated ?? 0}
            </p>
            <button
              onClick={() =>
                handleAction(
                  'signals',
                  signalEngine?.isRunning ? api.stopSignalEngine : api.startSignalEngine
                )
              }
              disabled={actionLoading === 'signals'}
              className={cn(
                'w-full py-1.5 px-3 rounded text-xs font-medium transition-colors flex items-center justify-center gap-1',
                signalEngine?.isRunning
                  ? 'bg-red-600 hover:bg-red-700'
                  : 'bg-green-600 hover:bg-green-700',
                actionLoading === 'signals' && 'opacity-50'
              )}
            >
              {actionLoading === 'signals' ? (
                <RefreshCw className="w-3 h-3 animate-spin" />
              ) : signalEngine?.isRunning ? (
                <>
                  <Square className="w-3 h-3" /> Stop
                </>
              ) : (
                <>
                  <Play className="w-3 h-3" /> Start
                </>
              )}
            </button>
          </div>

          {/* Polymarket */}
          <div className="bg-slate-800/50 rounded-lg p-4 border border-slate-700/50">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Database className="w-4 h-4 text-purple-400" />
                <span className="text-sm font-medium">Polymarket</span>
              </div>
              <div
                className={cn(
                  'w-2 h-2 rounded-full',
                  polymarket?.isRunning ? 'bg-green-500' : 'bg-slate-500'
                )}
              />
            </div>
            <p className="text-xs text-slate-400 mb-2">
              Markets: {polymarket?.marketCount ?? 0}
            </p>
            <button
              onClick={() =>
                handleAction(
                  'polymarket',
                  polymarket?.isRunning ? api.stopPolymarket : api.startPolymarket
                )
              }
              disabled={actionLoading === 'polymarket'}
              className={cn(
                'w-full py-1.5 px-3 rounded text-xs font-medium transition-colors flex items-center justify-center gap-1',
                polymarket?.isRunning
                  ? 'bg-red-600 hover:bg-red-700'
                  : 'bg-green-600 hover:bg-green-700',
                actionLoading === 'polymarket' && 'opacity-50'
              )}
            >
              {actionLoading === 'polymarket' ? (
                <RefreshCw className="w-3 h-3 animate-spin" />
              ) : polymarket?.isRunning ? (
                <>
                  <Square className="w-3 h-3" /> Stop
                </>
              ) : (
                <>
                  <Play className="w-3 h-3" /> Start
                </>
              )}
            </button>
          </div>

          {/* Risk Manager */}
          <div className="bg-slate-800/50 rounded-lg p-4 border border-slate-700/50">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Shield className="w-4 h-4 text-emerald-400" />
                <span className="text-sm font-medium">Risk</span>
              </div>
              <div
                className={cn(
                  'w-2 h-2 rounded-full',
                  automation?.risk.isHalted ? 'bg-red-500' : 'bg-green-500'
                )}
              />
            </div>
            <p className="text-xs text-slate-400 mb-2">
              {automation?.risk.isHalted
                ? automation.risk.haltReason || 'Trading halted'
                : 'Active'}
            </p>
            <div className="text-xs text-slate-500">
              Data: {automation?.collector.recordCount ?? 0} records
            </div>
          </div>
        </div>

        {/* Quick Actions */}
        <div className="mt-4 flex gap-2">
          <button
            onClick={() => handleAction('compute', api.computeSignals)}
            disabled={actionLoading === 'compute' || !signalEngine?.isRunning}
            className={cn(
              'px-3 py-1.5 rounded text-xs font-medium transition-colors',
              'bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed',
              'flex items-center gap-1'
            )}
          >
            {actionLoading === 'compute' ? (
              <RefreshCw className="w-3 h-3 animate-spin" />
            ) : (
              <Zap className="w-3 h-3" />
            )}
            Compute Signals
          </button>
          <button
            onClick={() => handleAction('discover', api.discoverMarkets)}
            disabled={actionLoading === 'discover' || !polymarket?.isRunning}
            className={cn(
              'px-3 py-1.5 rounded text-xs font-medium transition-colors',
              'bg-purple-600 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed',
              'flex items-center gap-1'
            )}
          >
            {actionLoading === 'discover' ? (
              <RefreshCw className="w-3 h-3 animate-spin" />
            ) : (
              <Database className="w-3 h-3" />
            )}
            Discover Markets
          </button>
          <button
            onClick={fetchStatus}
            className="px-3 py-1.5 rounded text-xs font-medium transition-colors bg-slate-600 hover:bg-slate-700 flex items-center gap-1"
          >
            <RefreshCw className="w-3 h-3" />
            Refresh
          </button>
        </div>
      </Card>
    </div>
  );
}
