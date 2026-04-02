import { memo } from 'react';

export default memo(function SVGTooltip({ x, y, content, visible }) {
  if (!visible || !content) return null;
  return (
    <div
      className="absolute pointer-events-none bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-xs text-white shadow-lg z-10"
      style={{ left: x + 12, top: y - 10, whiteSpace: 'nowrap' }}
    >
      {content}
    </div>
  );
});
