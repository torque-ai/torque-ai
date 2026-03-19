import { useEffect, useMemo, useState } from 'react';

const DEFAULT_STYLE = {
  color: 'text-slate-400',
  iconBg: 'bg-slate-400/10',
  itemBg: 'bg-slate-800/50',
  itemBorder: 'border-slate-800',
  Icon: InfoIcon,
};

const SEVERITY_STYLES = {
  success: {
    color: 'text-green-400',
    iconBg: 'bg-green-400/10',
    itemBg: 'bg-green-950/20',
    itemBorder: 'border-green-500/20',
    Icon: CheckIcon,
  },
  error: {
    color: 'text-red-400',
    iconBg: 'bg-red-400/10',
    itemBg: 'bg-red-950/20',
    itemBorder: 'border-red-500/20',
    Icon: XCircleIcon,
  },
  warning: {
    color: 'text-yellow-400',
    iconBg: 'bg-yellow-400/10',
    itemBg: 'bg-yellow-950/20',
    itemBorder: 'border-yellow-500/20',
    Icon: WarningIcon,
  },
  info: {
    color: 'text-blue-400',
    iconBg: 'bg-blue-400/10',
    itemBg: 'bg-blue-950/20',
    itemBorder: 'border-blue-500/20',
    Icon: InfoIcon,
  },
};

const EVENT_TYPE_STYLES = {
  task_complete: {
    color: 'text-green-400',
    iconBg: 'bg-green-400/10',
    itemBg: 'bg-green-950/20',
    itemBorder: 'border-green-500/20',
    Icon: CheckIcon,
  },
  task_fail: {
    color: 'text-red-400',
    iconBg: 'bg-red-400/10',
    itemBg: 'bg-red-950/20',
    itemBorder: 'border-red-500/20',
    Icon: XCircleIcon,
  },
  rate_limit: {
    color: 'text-yellow-400',
    iconBg: 'bg-yellow-400/10',
    itemBg: 'bg-yellow-950/20',
    itemBorder: 'border-yellow-500/20',
    Icon: ClockIcon,
  },
  workflow_complete: {
    color: 'text-blue-400',
    iconBg: 'bg-blue-400/10',
    itemBg: 'bg-blue-950/20',
    itemBorder: 'border-blue-500/20',
    Icon: WorkflowIcon,
  },
  stall_warning: {
    color: 'text-orange-400',
    iconBg: 'bg-orange-400/10',
    itemBg: 'bg-orange-950/20',
    itemBorder: 'border-orange-500/20',
    Icon: WarningIcon,
  },
  host_down: {
    color: 'text-red-400',
    iconBg: 'bg-red-400/10',
    itemBg: 'bg-red-950/20',
    itemBorder: 'border-red-500/20',
    Icon: HostDownIcon,
  },
};

function parseTimestampMs(timestamp) {
  const value = new Date(timestamp).getTime();
  return Number.isFinite(value) ? value : 0;
}

function formatRelativeTime(timestamp, now) {
  const eventTime = new Date(timestamp).getTime();
  if (!Number.isFinite(eventTime)) return 'now';

  const diffSeconds = Math.max(0, Math.floor((now - eventTime) / 1000));
  if (diffSeconds < 60) return `${diffSeconds}s ago`;

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function getEventStyle(type, severity) {
  return EVENT_TYPE_STYLES[type] || SEVERITY_STYLES[severity] || DEFAULT_STYLE;
}

function normalizeEvents(events) {
  if (!Array.isArray(events)) return [];

  return events
    .filter((event) => event && typeof event === 'object')
    .map((event, index) => ({
      ...event,
      _index: index,
      _timestampMs: parseTimestampMs(event.timestamp),
    }));
}

export default function ActivityPanel({ events, isOpen, onToggle }) {
  const [clearAfter, setClearAfter] = useState(null);
  const [now, setNow] = useState(() => Date.now());

  const normalizedEvents = useMemo(() => normalizeEvents(events), [events]);
  const visibleEvents = useMemo(() => normalizedEvents
    .filter((event) => clearAfter == null || event._timestampMs > clearAfter)
    .sort((left, right) => {
      if (right._timestampMs !== left._timestampMs) {
        return right._timestampMs - left._timestampMs;
      }
      return right._index - left._index;
    })
    .slice(0, 100), [normalizedEvents, clearAfter]);

  useEffect(() => {
    if (!isOpen) return undefined;

    const frameId = window.requestAnimationFrame(() => {
      setNow(Date.now());
    });
    const intervalId = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.clearInterval(intervalId);
    };
  }, [isOpen]);

  function handleClear() {
    setClearAfter(Date.now());
  }

  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={onToggle}
        className="fixed right-0 top-1/2 z-30 flex h-24 w-8 -translate-y-1/2 items-center justify-center rounded-l-lg border border-r-0 border-slate-700 bg-slate-800 text-slate-200 shadow-lg transition-colors hover:bg-slate-700"
        aria-label="Open activity panel"
        aria-expanded="false"
        aria-controls="activity-panel"
        title="Open activity panel"
      >
        <span className="relative flex items-center justify-center">
          <BellIcon className="h-4 w-4" />
          {visibleEvents.length > 0 && (
            <span className="absolute -right-2 -top-2 h-2 w-2 rounded-full bg-blue-400" aria-hidden="true" />
          )}
        </span>
      </button>
    );
  }

  return (
    <aside
      id="activity-panel"
      className="fixed right-0 top-0 z-30 flex h-full w-[300px] flex-col border-l border-slate-700 bg-slate-900 shadow-2xl"
      aria-label="Activity"
    >
      <div className="flex items-center justify-between gap-3 border-b border-slate-700 px-4 py-3">
        <h2 className="text-sm font-semibold text-white">Activity</h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleClear}
            disabled={visibleEvents.length === 0}
            className="text-xs text-slate-400 transition-colors hover:text-white disabled:cursor-not-allowed disabled:text-slate-600"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={onToggle}
            className="rounded p-1 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
            aria-label="Collapse activity panel"
            aria-expanded="true"
            aria-controls="activity-panel"
            title="Collapse activity panel"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {visibleEvents.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-xs text-slate-500">No recent activity</p>
          </div>
        ) : (
          <ul className="space-y-2">
            {visibleEvents.map((event) => (
              <ActivityEvent
                key={`${event.type || 'event'}-${event.timestamp || 'unknown'}-${event.message || 'message'}-${event._index}`}
                event={event}
                now={now}
              />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

function ActivityEvent({ event, now }) {
  const style = getEventStyle(event.type, event.severity);
  const Icon = style.Icon;

  return (
    <li className={`rounded-lg border p-3 ${style.itemBg} ${style.itemBorder}`}>
      <div className="flex items-start gap-3">
        <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${style.iconBg} ${style.color}`}>
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2">
            <span className={`text-xs font-medium ${style.color}`}>
              {formatRelativeTime(event.timestamp, now)}
            </span>
          </div>
          <p className="break-words text-xs leading-relaxed text-slate-200">
            {event.message || 'Event received'}
          </p>
        </div>
      </div>
    </li>
  );
}

function BellIcon({ className = 'h-5 w-5' }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
    </svg>
  );
}

function CheckIcon({ className = 'h-4 w-4' }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
    </svg>
  );
}

function XCircleIcon({ className = 'h-4 w-4' }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 9l6 6m0-6l-6 6" />
      <circle cx="12" cy="12" r="9" strokeWidth={2} />
    </svg>
  );
}

function ClockIcon({ className = 'h-4 w-4' }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" strokeWidth={2} />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 7v5l3 2" />
    </svg>
  );
}

function WorkflowIcon({ className = 'h-4 w-4' }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 7h4m6 0h4M7 7v10m10-10v10m-5-5h5m-10 5h10" />
      <circle cx="7" cy="7" r="2" strokeWidth={2} />
      <circle cx="17" cy="7" r="2" strokeWidth={2} />
      <circle cx="17" cy="17" r="2" strokeWidth={2} />
    </svg>
  );
}

function WarningIcon({ className = 'h-4 w-4' }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v4m0 4h.01m-7.938 1h15.876c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L2.33 15c-.77 1.333.192 3 1.732 3z" />
    </svg>
  );
}

function HostDownIcon({ className = 'h-4 w-4' }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7h16v4H4zm0 6h16v4H4z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9h.01M8 15h.01M6 6l12 12" />
    </svg>
  );
}

function InfoIcon({ className = 'h-4 w-4' }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" strokeWidth={2} />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 11v5m0-8h.01" />
    </svg>
  );
}

function XIcon({ className = 'h-4 w-4' }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}
