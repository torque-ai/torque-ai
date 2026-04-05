import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

const SHORTCUTS = [
  { key: '?', description: 'Show keyboard shortcuts' },
  { key: '/', description: 'Focus search field' },
  { key: 'Escape', description: 'Close drawer / modal' },
  { key: '1', description: 'Go to Kanban' },
  { key: '2', description: 'Go to Projects' },
  { key: '3', description: 'Go to History' },
  { key: '4', description: 'Go to Batches' },
  { key: '5', description: 'Go to Providers' },
  { key: '6', description: 'Go to Hosts' },
  { key: '7', description: 'Go to Budget' },
  { key: 'g then k', description: 'Kanban (g prefix)' },
  { key: 'g then h', description: 'History (g prefix)' },
  { key: 'g then p', description: 'Providers (g prefix)' },
  { key: 'g then o', description: 'Hosts (g prefix)' },
  { key: 'g then b', description: 'Budget (g prefix)' },
  { key: 'g then j', description: 'Projects (g prefix)' },
  { key: 'r', description: 'Refresh current view' },
];

const NUMBER_ROUTES = ['/', '/projects', '/history', '/batches', '/providers', '/hosts', '/budget'];

const NAV_KEYS = {
  k: '/',
  h: '/history',
  p: '/providers',
  o: '/hosts',
  b: '/budget',
  j: '/projects',
};

// eslint-disable-next-line react-refresh/only-export-components
export function useKeyboardShortcuts({ onRefresh } = {}) {
  const [showHelp, setShowHelp] = useState(false);
  const [pendingG, setPendingG] = useState(false);
  const pendingGTimerRef = useRef(null);
  const navigate = useNavigate();

  const handleKeyDown = useCallback((e) => {
    // Ignore when typing in inputs
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }

    // ? — toggle help overlay
    // Note: e.key === '?' already implies shiftKey on QWERTY; the second check covers non-QWERTY layouts
    if (e.key === '?' || (e.shiftKey && e.key === '/')) {
      e.preventDefault();
      setShowHelp((v) => !v);
      return;
    }

    // Escape — close help
    if (e.key === 'Escape') {
      if (showHelp) { setShowHelp(false); e.preventDefault(); }
      return;
    }

    // / — focus search
    if (e.key === '/') {
      e.preventDefault();
      const input = document.querySelector('input[type="text"][placeholder*="earch"]');
      if (input) input.focus();
      return;
    }

    // r — refresh
    if (e.key === 'r' && !pendingG) {
      onRefresh?.();
      return;
    }

    // 1-7 — navigate to numbered route
    if (!pendingG) {
      const num = parseInt(e.key, 10);
      if (num >= 1 && num <= NUMBER_ROUTES.length) {
        e.preventDefault();
        navigate(NUMBER_ROUTES[num - 1]);
        return;
      }
    }

    // g prefix for navigation
    if (e.key === 'g' && !pendingG) {
      setPendingG(true);
      pendingGTimerRef.current = setTimeout(() => setPendingG(false), 1000);
      return;
    }

    if (pendingG && NAV_KEYS[e.key]) {
      e.preventDefault();
      clearTimeout(pendingGTimerRef.current);
      navigate(NAV_KEYS[e.key]);
      setPendingG(false);
      return;
    }

    setPendingG(false);
  }, [showHelp, pendingG, navigate, onRefresh]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  useEffect(() => () => { if (pendingGTimerRef.current) clearTimeout(pendingGTimerRef.current); }, []);

  return { showHelp, setShowHelp, pendingG };
}

export function ShortcutHelpOverlay({ onClose }) {
  const modalRef = useRef(null);

  useEffect(() => {
    const modal = modalRef.current;
    if (!modal) return;
    const focusable = modal.querySelectorAll('button, [tabindex]:not([tabindex="-1"])');
    if (focusable.length) focusable[0].focus();
    function trap(e) {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key !== 'Tab' || !focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    modal.addEventListener('keydown', trap);
    return () => modal.removeEventListener('keydown', trap);
  }, [onClose]);

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
      <div ref={modalRef} className="bg-slate-800 border border-slate-700 rounded-xl p-6 w-full max-w-md shadow-2xl" role="dialog" aria-modal="true" aria-label="Keyboard Shortcuts" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-white">Keyboard Shortcuts</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-xl">&times;</button>
        </div>
        <div className="space-y-2">
          {SHORTCUTS.map(({ key, description }) => (
            <div key={key} className="flex items-center justify-between py-1.5">
              <span className="text-slate-300 text-sm">{description}</span>
              <div className="flex gap-1">
                {key.split(' then ').map((k, i) => (
                  <span key={i} className="flex items-center gap-1">
                    {i > 0 && <span className="text-slate-500 text-xs mx-0.5">then</span>}
                    <kbd className="px-2 py-0.5 bg-slate-700 border border-slate-600 rounded text-xs text-slate-300 font-mono">
                      {k}
                    </kbd>
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
        <p className="text-xs text-slate-500 mt-4 text-center">
          Press <kbd className="px-1.5 py-0.5 bg-slate-700 border border-slate-600 rounded text-[10px] font-mono">?</kbd> or <kbd className="px-1.5 py-0.5 bg-slate-700 border border-slate-600 rounded text-[10px] font-mono">Esc</kbd> to close
        </p>
      </div>
    </div>
  );
}
