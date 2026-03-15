import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';

const SHORTCUTS = [
  { key: '?', description: 'Show keyboard shortcuts' },
  { key: '/', description: 'Focus search field' },
  { key: 'Escape', description: 'Close drawer / modal' },
  { key: 'g then k', description: 'Go to Kanban' },
  { key: 'g then h', description: 'Go to History' },
  { key: 'g then p', description: 'Go to Providers' },
  { key: 'g then o', description: 'Go to Hosts' },
  { key: 'g then b', description: 'Go to Budget' },
  { key: 'g then j', description: 'Go to Projects' },
  { key: 'r', description: 'Refresh current view' },
];

const NAV_KEYS = {
  k: '/',
  h: '/history',
  p: '/providers',
  o: '/hosts',
  b: '/budget',
  j: '/projects',
};

export function useKeyboardShortcuts({ onRefresh } = {}) {
  const [showHelp, setShowHelp] = useState(false);
  const [pendingG, setPendingG] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const handleKeyDown = useCallback((e) => {
    // Ignore when typing in inputs
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }

    // ? — toggle help overlay
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

    // g prefix for navigation
    if (e.key === 'g' && !pendingG) {
      setPendingG(true);
      setTimeout(() => setPendingG(false), 1000);
      return;
    }

    if (pendingG && NAV_KEYS[e.key]) {
      e.preventDefault();
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

  return { showHelp, setShowHelp, pendingG };
}

export function ShortcutHelpOverlay({ onClose }) {
  useEffect(() => {
    function handleEsc(e) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 w-full max-w-md shadow-2xl" onClick={(e) => e.stopPropagation()}>
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
