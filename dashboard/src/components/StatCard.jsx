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
    ? `${gradientClass} rounded-xl p-4 shadow-md card-hover`
    : 'bg-slate-800 border border-slate-700/50 rounded-xl p-4 card-hover';

  return (
    <div className={base}>
      <div className="flex items-start justify-between mb-1">
        <p className={`text-sm font-medium ${gradient ? 'text-white/80' : 'text-slate-400'}`}>
          {label}
        </p>
        {icon && <span className="text-lg opacity-80">{icon}</span>}
      </div>
      <div className="flex items-baseline gap-2">
        <p className="text-2xl font-bold text-white">{value}</p>
        {trend !== undefined && trend !== null && (
          <span className={`text-sm font-medium ${
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
        <p className={`text-xs mt-1 ${gradient ? 'text-white/60' : 'text-slate-500'}`}>
          {subtext}
        </p>
      )}
    </div>
  );
}
