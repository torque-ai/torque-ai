const GRADIENTS = {
  blue: 'stat-gradient-blue',
  purple: 'stat-gradient-purple',
  green: 'stat-gradient-green',
  red: 'stat-gradient-red',
  orange: 'stat-gradient-orange',
  cyan: 'stat-gradient-cyan',
};

export default function StatCard({ label, value, subtext, trend, icon, gradient }) {
  const gradientClass = gradient ? GRADIENTS[gradient] || '' : '';
  const base = gradient
    ? `${gradientClass} rounded-lg px-3 py-2 shadow-md card-hover`
    : 'bg-slate-800 border border-slate-700/50 rounded-lg px-3 py-2 card-hover';

  return (
    <div className={base}>
      <div className="mb-0.5 flex items-start justify-between gap-2">
        <p className={`truncate text-xs font-medium ${gradient ? 'text-white/80' : 'text-slate-400'}`}>
          {label}
        </p>
        {icon && <span className="text-sm opacity-80">{icon}</span>}
      </div>
      <div className="flex min-w-0 items-baseline gap-2">
        <p className="truncate text-xl font-bold text-white" title={String(value)}>{value}</p>
        {trend !== undefined && trend !== null && (
          <span className={`shrink-0 text-xs font-medium ${
            gradient
              ? 'text-white/90'
              : trend >= 0 ? 'text-green-400' : 'text-red-400'
          }`}>
            {trend > 0 ? '\u2191' : trend < 0 ? '\u2193' : '\u2192'}{' '}
            {Math.abs(trend)}%
          </span>
        )}
      </div>
      {subtext && (
        <p className={`mt-0.5 truncate text-xs ${gradient ? 'text-white/60' : 'text-slate-500'}`} title={String(subtext)}>
          {subtext}
        </p>
      )}
    </div>
  );
}
