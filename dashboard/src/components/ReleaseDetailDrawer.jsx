import { memo, useEffect, useRef } from 'react';
import { format } from 'date-fns';

const BUMP_TYPE_STYLES = {
  minor: 'bg-green-600/20 text-green-300 border border-green-500/30',
  patch: 'bg-yellow-600/20 text-yellow-300 border border-yellow-500/30',
  major: 'bg-red-600/20 text-red-300 border border-red-500/30',
  unknown: 'bg-slate-700 text-slate-300 border border-slate-600',
};

const CHANGELOG_SECTION_STYLES = {
  added: {
    header: 'text-green-300',
    bullet: 'text-green-400',
  },
  fixed: {
    header: 'text-red-300',
    bullet: 'text-red-400',
  },
  changed: {
    header: 'text-blue-300',
    bullet: 'text-blue-400',
  },
  documentation: {
    header: 'text-purple-300',
    bullet: 'text-purple-400',
  },
  testing: {
    header: 'text-amber-300',
    bullet: 'text-amber-400',
  },
  maintenance: {
    header: 'text-slate-300',
    bullet: 'text-slate-400',
  },
  default: {
    header: 'text-slate-200',
    bullet: 'text-slate-400',
  },
};

function formatReleaseDate(value) {
  if (!value) return 'Unknown date';
  try {
    return format(new Date(value), 'MMM d, yyyy h:mm a');
  } catch {
    return String(value);
  }
}

function normalizeCount(value, fallback = 0) {
  const count = Number(value);
  return Number.isFinite(count) ? count : fallback;
}

function getWorkflowCount(release) {
  const explicitCount = normalizeCount(release?.workflow_count ?? release?.workflowCount, NaN);
  if (Number.isFinite(explicitCount)) {
    return explicitCount;
  }

  if (Array.isArray(release?.workflow_ids)) {
    return release.workflow_ids.filter(Boolean).length;
  }

  return release?.workflow_id ? 1 : 0;
}

function getTriggerLabel(release) {
  const trigger = String(release?.trigger || '').toLowerCase();
  if (trigger === 'workflow' || release?.workflow_id) return 'via workflow';
  if (trigger === 'task' || release?.task_id) return 'via task';
  if (trigger === 'governance') return 'via governance';
  if (trigger === 'manual') return 'manual release';
  return 'release event';
}

function getSectionStyle(title) {
  const normalized = String(title || '').trim().toLowerCase();
  return CHANGELOG_SECTION_STYLES[normalized] || CHANGELOG_SECTION_STYLES.default;
}

function extractChangelogItems(body) {
  const items = [];

  for (const rawLine of String(body || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const bulletMatch = line.match(/^[-*+]\s+(.+)$/) || line.match(/^\d+\.\s+(.+)$/);
    if (bulletMatch) {
      items.push(bulletMatch[1].trim());
      continue;
    }

    if (items.length > 0) {
      items[items.length - 1] = `${items[items.length - 1]} ${line}`.trim();
      continue;
    }

    items.push(line);
  }

  return items.filter(Boolean);
}

function parseChangelogSections(changelog) {
  const markdown = String(changelog || '').trim();
  if (!markdown) {
    return [];
  }

  const matches = [...markdown.matchAll(/(?:^|\n)###\s+([^\n]+)\n([\s\S]*?)(?=(?:\n###\s+)|$)/g)];
  if (matches.length === 0) {
    const items = extractChangelogItems(markdown);
    return items.length > 0 ? [{ title: 'Changes', items }] : [];
  }

  return matches
    .map((match) => ({
      title: match[1].trim(),
      items: extractChangelogItems(match[2]),
    }))
    .filter((section) => section.title && section.items.length > 0);
}

function getCommitHash(commit) {
  return String(commit?.commit_hash || commit?.id || 'Unknown hash');
}

export default memo(function ReleaseDetailDrawer({ release, onClose }) {
  const drawerRef = useRef(null);
  const previouslyFocusedRef = useRef(null);

  useEffect(() => {
    const drawer = drawerRef.current;
    if (!drawer) return undefined;

    previouslyFocusedRef.current = document.activeElement;
    const focusableSelector = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
    const focusable = drawer.querySelectorAll(focusableSelector);
    if (focusable.length) focusable[0].focus();

    function handleKeyDown(event) {
      if (event.key === 'Tab') {
        const focusableElements = drawer.querySelectorAll(focusableSelector);
        if (!focusableElements.length) return;

        const first = focusableElements[0];
        const last = focusableElements[focusableElements.length - 1];

        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
        return;
      }

      if (event.key !== 'Escape') return;

      if (
        event.target instanceof Element
        && event.target.closest('input, textarea, select, [contenteditable="true"]')
      ) {
        return;
      }

      onClose?.();
    }

    drawer.addEventListener('keydown', handleKeyDown);
    return () => {
      drawer.removeEventListener('keydown', handleKeyDown);
      if (
        previouslyFocusedRef.current
        && document.contains(previouslyFocusedRef.current)
        && typeof previouslyFocusedRef.current.focus === 'function'
      ) {
        previouslyFocusedRef.current.focus();
      }
    };
  }, [onClose]);

  if (!release) {
    return null;
  }

  const commits = Array.isArray(release.commits) ? release.commits : [];
  const changelogSections = parseChangelogSections(release.changelog);
  const versionLabel = release.version || release.tag || 'Unknown release';
  const tagLabel = release.tag || 'Tag unavailable';
  const bumpType = String(release.bump_type || release.bumpType || 'unknown').toLowerCase();
  const bumpStyle = BUMP_TYPE_STYLES[bumpType] || BUMP_TYPE_STYLES.unknown;
  const commitCount = normalizeCount(release.commit_count ?? release.commitCount, commits.length);
  const filesChanged = normalizeCount(release.files_changed ?? release.filesChanged, 0);
  const workflowCount = getWorkflowCount(release);

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-40" onClick={onClose} />

      <div ref={drawerRef} className="fixed top-0 right-0 h-full w-[400px] bg-slate-900 border-l-2 border-blue-500 z-50 overflow-y-auto shadow-2xl" role="dialog" aria-modal="true" aria-label="Release details">
        <div className="p-5 space-y-4">
          <div className="flex justify-between items-start gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-2xl font-bold text-white">{versionLabel}</h2>
                <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium capitalize ${bumpStyle}`}>
                  {bumpType}
                </span>
              </div>
              <p className="text-sm text-slate-500 mt-1">{tagLabel}</p>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-3 text-xs text-slate-400">
                <span>{formatReleaseDate(release.created_at || release.released_at)}</span>
                <span className="text-slate-600">{getTriggerLabel(release)}</span>
              </div>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="text-slate-500 hover:text-white text-xl p-1 transition-colors"
              aria-label="Close release details"
            >
              &times;
            </button>
          </div>

          <div className="bg-slate-800/60 rounded-lg p-3">
            <div className="text-slate-500 text-[10px] uppercase tracking-wider mb-3 font-medium">Release Stats</div>
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-slate-950/40 rounded-lg px-3 py-2">
                <div className="text-slate-500 text-[10px] uppercase tracking-wider font-medium">Commits</div>
                <div className="text-lg font-semibold text-white mt-1">{commitCount.toLocaleString()}</div>
              </div>
              <div className="bg-slate-950/40 rounded-lg px-3 py-2">
                <div className="text-slate-500 text-[10px] uppercase tracking-wider font-medium">Files</div>
                <div className="text-lg font-semibold text-white mt-1">{filesChanged.toLocaleString()}</div>
              </div>
              <div className="bg-slate-950/40 rounded-lg px-3 py-2">
                <div className="text-slate-500 text-[10px] uppercase tracking-wider font-medium">Workflows</div>
                <div className="text-lg font-semibold text-white mt-1">{workflowCount.toLocaleString()}</div>
              </div>
            </div>
          </div>

          <div className="bg-slate-800/60 rounded-lg p-3">
            <div className="text-slate-500 text-[10px] uppercase tracking-wider mb-3 font-medium">Changelog</div>
            {changelogSections.length === 0 ? (
              <p className="text-sm text-slate-500">No changelog generated</p>
            ) : (
              <div className="space-y-4">
                {changelogSections.map((section) => {
                  const sectionStyle = getSectionStyle(section.title);
                  return (
                    <div key={section.title}>
                      <h3 className={`text-sm font-semibold ${sectionStyle.header}`}>{section.title}</h3>
                      <ul className="mt-2 space-y-1.5">
                        {section.items.map((item, index) => (
                          <li key={`${section.title}-${index}`} className="flex items-start gap-2 text-sm text-slate-200">
                            <span className={`mt-0.5 ${sectionStyle.bullet}`}>&bull;</span>
                            <span>{item}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="bg-slate-800/60 rounded-lg p-3">
            <div className="text-slate-500 text-[10px] uppercase tracking-wider mb-3 font-medium">Commits</div>
            {commits.length === 0 ? (
              <p className="text-sm text-slate-500">No commits recorded for this release</p>
            ) : (
              <div className="space-y-2">
                {commits.map((commit, index) => (
                  <div key={commit.id || commit.commit_hash || index} className="bg-slate-950/40 rounded-lg px-3 py-2">
                    <div className="flex justify-between items-start gap-3">
                      <p className="text-sm text-slate-200 leading-relaxed">
                        {commit?.message || 'Commit message unavailable'}
                      </p>
                      {commit?.task_id ? (
                        <span className="shrink-0 px-2 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider bg-blue-600/20 text-blue-300">
                          task
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-2 text-xs font-mono text-slate-600 break-all">{getCommitHash(commit)}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="bg-slate-800/60 rounded-lg p-3">
            <div className="text-slate-500 text-[10px] uppercase tracking-wider mb-3 font-medium">Actions</div>
            <div className="flex gap-2">
              <button
                type="button"
                disabled
                className="flex-1 py-2 rounded-lg text-sm font-medium bg-slate-700/50 text-slate-500 cursor-not-allowed"
              >
                View Diff
              </button>
              <button
                type="button"
                disabled
                className="flex-1 py-2 rounded-lg text-sm font-medium bg-red-600/30 text-red-300/70 cursor-not-allowed"
              >
                Rollback
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
});
