export function StarvationBanner({ project }) {
  const loopState = String(project?.loop_state || '').toUpperCase();
  if (loopState !== 'STARVED') {
    return null;
  }

  const emptyCycles = Number(project?.consecutive_empty_cycles) || 0;
  const cycleText = emptyCycles === 1 ? '1 empty cycle' : `${emptyCycles} empty cycles`;

  return (
    <div
      role="status"
      aria-label={`${project?.name || 'Project'} factory loop starved`}
      className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-rose-100"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-semibold">Factory loop starved</p>
          <p className="mt-1 text-xs text-rose-100/80">
            PRIORITIZE found no open work for {cycleText}. Recovery scout is queued by the factory tick.
          </p>
        </div>
        <span className="inline-flex w-fit items-center rounded-md border border-rose-300/30 bg-slate-950/30 px-2.5 py-1 font-mono text-xs text-rose-100">
          STARVED
        </span>
      </div>
    </div>
  );
}

export default StarvationBanner;
