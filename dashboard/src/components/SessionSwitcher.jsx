import { useState, useEffect, useRef, useCallback } from 'react';
import { instances as instancesApi } from '../api';

/**
 * Session switcher dropdown for multi-session dashboard navigation.
 * Shows all active MCP instances and allows switching between them.
 */
export default function SessionSwitcher({ shortId }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const dropdownRef = useRef(null);
  const refreshRef = useRef(null);
  const requestControllerRef = useRef(null);

  const fetchInstances = useCallback(() => {
    if (requestControllerRef.current) requestControllerRef.current.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    setLoading(true);
    instancesApi.list({ signal: controller.signal })
      .then((nextData) => {
        if (requestControllerRef.current === controller && !controller.signal.aborted) {
          setData(nextData);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (requestControllerRef.current === controller && !controller.signal.aborted) {
          setLoading(false);
        }
      });
  }, []);

  // Fetch on open, refresh every 30s while open
  useEffect(() => {
    if (open) {
      fetchInstances();
      refreshRef.current = setInterval(fetchInstances, 30000);
    } else {
      if (refreshRef.current) clearInterval(refreshRef.current);
      if (requestControllerRef.current) requestControllerRef.current.abort();
    }
    return () => {
      if (refreshRef.current) clearInterval(refreshRef.current);
      if (requestControllerRef.current) requestControllerRef.current.abort();
    };
  }, [open, fetchInstances]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleKey(e) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open]);

  function navigateToInstance(inst) {
    if (inst.isCurrent || !inst.port) return;
    setNavigating(true);
    const currentPath = window.location.pathname;
    const currentSearch = window.location.search;
    const currentHash = window.location.hash;
    // eslint-disable-next-line react-hooks/immutability
    window.location.href = `${window.location.protocol}//${window.location.hostname}:${inst.port}${currentPath}${currentSearch}${currentHash}`;
  }

  const instances = data?.instances || [];
  const sessionCount = instances.length;

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-mono bg-slate-800 border border-slate-700 text-slate-300 hover:text-white hover:border-slate-600 transition-colors"
        title={`Session ${shortId || '...'} (${sessionCount > 1 ? sessionCount + ' sessions' : '1 session'})`}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
        <span>{shortId || '...'}</span>
        {sessionCount > 1 && (
          <span className="text-slate-500">+{sessionCount - 1}</span>
        )}
        <svg className={`w-3 h-3 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-72 bg-slate-800 border border-slate-700 rounded-lg shadow-xl z-50 overflow-hidden">
          <div className="px-3 py-2 border-b border-slate-700 flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-300">Active Sessions</span>
            {navigating ? (
              <span className="text-[10px] text-blue-400">navigating...</span>
            ) : loading && (
              <span className="text-[10px] text-slate-500">refreshing...</span>
            )}
          </div>
          <div className="max-h-60 overflow-y-auto">
            {instances.length === 0 && (
              <div className="px-3 py-4 text-xs text-slate-500 text-center">
                {loading ? 'Loading...' : 'No active sessions found'}
              </div>
            )}
            {instances.map((inst) => (
              <button
                key={inst.instanceId}
                onClick={() => navigateToInstance(inst)}
                disabled={inst.isCurrent}
                className={`w-full px-3 py-2.5 flex items-start gap-3 text-left transition-colors ${
                  inst.isCurrent
                    ? 'bg-blue-600/10 border-l-2 border-blue-500'
                    : 'hover:bg-slate-700/50 border-l-2 border-transparent cursor-pointer'
                }`}
              >
                <span className={`w-2 h-2 rounded-full mt-1 shrink-0 ${inst.isCurrent ? 'bg-blue-400' : 'bg-green-500'}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-white">{inst.shortId}</span>
                    {inst.isCurrent && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-600/30 text-blue-300 font-medium">current</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-0.5 text-[10px] text-slate-500">
                    <span>PID {inst.pid}</span>
                    {inst.port && <span>:{inst.port}</span>}
                    {inst.uptime && <span>{inst.uptime}</span>}
                  </div>
                </div>
                {!inst.isCurrent && inst.port && (
                  <svg className="w-3.5 h-3.5 text-slate-500 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
