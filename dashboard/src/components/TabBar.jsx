import { useEffect, useRef, useState } from 'react';

function hasTab(tabs, id) {
  return tabs.some((tab) => tab.id === id);
}

function resolveTabId(tabs, preferredTab, defaultTab) {
  if (preferredTab && hasTab(tabs, preferredTab)) {
    return preferredTab;
  }

  if (defaultTab && hasTab(tabs, defaultTab)) {
    return defaultTab;
  }

  return tabs[0]?.id ?? null;
}

export default function TabBar({ tabs = [], defaultTab, onTabChange }) {
  const [active, setActive] = useState(() => {
    if (typeof window === 'undefined') {
      return resolveTabId(tabs, defaultTab, defaultTab);
    }

    return resolveTabId(tabs, window.location.hash.slice(1), defaultTab);
  });

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }

    function handleHashChange() {
      const nextTab = resolveTabId(tabs, window.location.hash.slice(1), defaultTab);
      setActive((current) => (current === nextTab ? current : nextTab));
    }

    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, [tabs, defaultTab]);

  useEffect(() => {
    if (!active || typeof window === 'undefined') {
      return;
    }

    const currentHash = window.location.hash.slice(1);
    if (currentHash && currentHash !== active && !hasTab(tabs, currentHash)) {
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${window.location.search}#${active}`,
      );
    }
  }, [active, tabs]);

  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      // Fire on mount if hash resolved to a non-default tab
      if (active && active !== defaultTab && onTabChange) onTabChange(active);
      return;
    }
    if (active && onTabChange) onTabChange(active);
  }, [active, onTabChange, defaultTab]);

  if (tabs.length === 0) {
    return null;
  }

  function handleClick(tabId) {
    setActive(tabId);
  }

  return (
    <div className="flex flex-wrap gap-1 border-b border-slate-700 mb-6">
      {tabs.map((tab) => (
        <a
          key={tab.id}
          href={`#${tab.id}`}
          onClick={() => handleClick(tab.id)}
          className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors border-b-2 ${
            active === tab.id
              ? 'bg-slate-700 text-white border-blue-500'
              : 'text-slate-400 border-transparent hover:text-white hover:bg-slate-700/50'
          }`}
        >
          {tab.label}
        </a>
      ))}
    </div>
  );
}
