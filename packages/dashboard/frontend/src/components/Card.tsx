/**
 * Card Component
 */

import { cn } from '../lib/utils';

interface CardProps {
  children: React.ReactNode;
  className?: string;
  title?: string;
  action?: React.ReactNode;
}

export function Card({ children, className, title, action }: CardProps) {
  return (
    <div className={cn('bg-slate-800/50 rounded-lg border border-slate-700/50', className)}>
      {(title || action) && (
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700/50">
          {title && <h3 className="font-semibold text-white">{title}</h3>}
          {action}
        </div>
      )}
      <div className="p-4">{children}</div>
    </div>
  );
}

interface StatCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  trend?: 'up' | 'down' | 'neutral';
  icon?: React.ReactNode;
}

export function StatCard({ title, value, subtitle, trend, icon }: StatCardProps) {
  const trendColor = trend === 'up' ? 'text-green-500' : trend === 'down' ? 'text-red-500' : 'text-gray-400';

  return (
    <div className="bg-slate-800/50 rounded-lg border border-slate-700/50 p-4">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-slate-400">{title}</p>
          <p className={cn('text-2xl font-bold mt-1', trendColor)}>{value}</p>
          {subtitle && <p className="text-xs text-slate-500 mt-1">{subtitle}</p>}
        </div>
        {icon && <div className="text-slate-400">{icon}</div>}
      </div>
    </div>
  );
}
