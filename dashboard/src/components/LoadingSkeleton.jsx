/**
 * LoadingSkeleton — shimmer/pulse placeholder component for loading states.
 *
 * Props:
 *   lines  — number of skeleton bars to render (default: 3)
 *   height — optional explicit height for each bar in pixels (default: 16)
 */
export default function LoadingSkeleton({ lines = 3, height = 16 }) {
  // Vary widths to look realistic
  const widths = ['w-full', 'w-3/4', 'w-5/6', 'w-2/3', 'w-4/5'];

  return (
    <div className="space-y-3 animate-pulse" data-testid="loading-skeleton">
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          className={`bg-slate-700 rounded ${widths[i % widths.length]}`}
          style={{ height: `${height}px` }}
        />
      ))}
    </div>
  );
}
