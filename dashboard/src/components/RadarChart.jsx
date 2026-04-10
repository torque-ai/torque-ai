const DIMENSION_LABELS = {
  structural: 'Structural',
  test_coverage: 'Test Coverage',
  security: 'Security',
  user_facing: 'User-Facing',
  api_completeness: 'API',
  documentation: 'Documentation',
  dependency_health: 'Dependencies',
  build_ci: 'Build/CI',
  performance: 'Performance',
  debt_ratio: 'Debt Ratio',
};

function polarToCartesian(cx, cy, r, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

export default function RadarChart({ scores = {}, size = 280, showValues = false }) {
  const dimensions = Object.keys(scores);
  if (dimensions.length === 0) {
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Health radar chart (no data)">
        <text x={size / 2} y={size / 2} textAnchor="middle" fill="#64748b" fontSize={12}>No health data</text>
      </svg>
    );
  }

  const cx = size / 2;
  const cy = size / 2;
  const maxR = size * 0.38;
  const angleStep = 360 / dimensions.length;
  const rings = [25, 50, 75, 100];

  const dataPoints = dimensions.map((dim, i) => {
    const angle = i * angleStep;
    const r = (scores[dim] / 100) * maxR;
    return polarToCartesian(cx, cy, r, angle);
  });

  const axes = dimensions.map((dim, i) => {
    const angle = i * angleStep;
    const end = polarToCartesian(cx, cy, maxR, angle);
    const labelPos = polarToCartesian(cx, cy, maxR + 18, angle);
    return { dim, end, labelPos, angle };
  });

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Health radar chart">
      {rings.map(pct => {
        const r = (pct / 100) * maxR;
        const ringPoints = dimensions.map((_, i) => polarToCartesian(cx, cy, r, i * angleStep));
        const ringPath = ringPoints.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ') + 'Z';
        return <path key={pct} d={ringPath} fill="none" stroke="#334155" strokeWidth={0.5} />;
      })}

      {axes.map(({ dim, end }) => (
        <line key={dim} x1={cx} y1={cy} x2={end.x} y2={end.y} stroke="#334155" strokeWidth={0.5} />
      ))}

      <polygon points={dataPoints.map(p => `${p.x},${p.y}`).join(' ')} fill="rgba(59, 130, 246, 0.2)" stroke="#3b82f6" strokeWidth={2} />

      {dataPoints.map((p, i) => (
        <circle key={dimensions[i]} cx={p.x} cy={p.y} r={3} fill="#3b82f6" />
      ))}

      {axes.map(({ dim, labelPos, angle }) => {
        const label = DIMENSION_LABELS[dim] || dim.replace(/_/g, ' ');
        const textAnchor = angle > 90 && angle < 270 ? 'end' : angle === 0 || angle === 180 ? 'middle' : 'start';
        return (
          <text key={dim} x={labelPos.x} y={labelPos.y} textAnchor={textAnchor} dominantBaseline="middle" fill="#94a3b8" fontSize={10}>
            {label}
          </text>
        );
      })}

      {showValues && dataPoints.map((p, i) => (
        <text key={`val-${dimensions[i]}`} x={p.x} y={p.y - 8} textAnchor="middle" fill="#e2e8f0" fontSize={10} fontWeight="bold">
          {Math.round(scores[dimensions[i]])}
        </text>
      ))}
    </svg>
  );
}
