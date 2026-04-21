import React from 'react';

export default function StarvationBanner({ project }) {
  if (!project || project.loop_state !== 'STARVED') return null;
  const cycles = project.consecutive_empty_cycles ?? 0;
  return (
    <div
      role="alert"
      className="rounded-2xl border border-amber-500/40 bg-amber-500/10 px-5 py-4 text-sm text-amber-100"
      data-testid={`starvation-banner-${project.id || 'unknown'}`}
    >
      <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
        <div>
          <strong className="text-amber-50">{project.name} is starved</strong>
          <span className="ml-2 text-amber-200">
            — {cycles} empty cycles, no open work items.
          </span>
        </div>
        <div className="text-amber-200">
          Suggested actions: re-run scouts, create a work item, or configure <code className="rounded bg-amber-500/20 px-1 py-0.5 text-amber-50">plans_dir</code>.
        </div>
      </div>
    </div>
  );
}

export { StarvationBanner };
