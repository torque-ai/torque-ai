import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { requestV2 } from '../api';

const STATE_STYLES = {
  off: { dot: 'bg-green-400', label: 'Economy Off' },
  auto: { dot: 'bg-amber-400 animate-pulse', label: 'Economy (Auto)' },
  manual: { dot: 'bg-blue-400', label: 'Economy (Manual)' },
};

function normalizeEconomyResponse(raw) {
  return raw && typeof raw === 'object' ? (raw.data || raw) : {};
}

function normalizeMode(status) {
  if (!status || !status.enabled) return 'off';
  return status.trigger === 'auto' ? 'auto' : 'manual';
}

function parseThreshold(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export default function EconomyIndicator() {
  const [status, setStatus] = useState(null);
  const [showPanel, setShowPanel] = useState(false);
  const [threshold, setThreshold] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const panelRef = useRef(null);

  const loadStatus = useCallback(() => {
    requestV2('/economy/status')
      .then((payload) => {
        const nextStatus = normalizeEconomyResponse(payload);
        setStatus(nextStatus);
        if (nextStatus.auto_trigger_threshold !== undefined && nextStatus.auto_trigger_threshold !== null) {
          setThreshold(String(nextStatus.auto_trigger_threshold));
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    function handleOutsideClick(event) {
      if (!showPanel) return;
      if (panelRef.current && !panelRef.current.contains(event.target)) {
        setShowPanel(false);
      }
    }
    function handleEscape(event) {
      if (event.key === 'Escape') {
        setShowPanel(false);
      }
    }
    document.addEventListener('mousedown', handleOutsideClick);
    window.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [showPanel]);

  const mode = useMemo(() => normalizeMode(status), [status]);
  const style = STATE_STYLES[mode] || STATE_STYLES.off;
  const isEnabled = Boolean(status?.enabled);
  const thresholdNumber = parseThreshold(threshold);

  function setEconomy(nextEnabled) {
    const normalizedThreshold = parseThreshold(threshold);
    const body = { scope: 'global', enabled: nextEnabled };
    if (nextEnabled && normalizedThreshold !== null) {
      body.auto_trigger_threshold = normalizedThreshold;
    }
    setIsSaving(true);
    requestV2('/economy/set', { method: 'POST', body: JSON.stringify(body) })
      .then(() => loadStatus())
      .catch(() => {})
      .finally(() => setIsSaving(false));
  }

  function saveThreshold() {
    if (thresholdNumber === null) return;
    const body = { scope: 'global', enabled: isEnabled, auto_trigger_threshold: thresholdNumber };
    setIsSaving(true);
    requestV2('/economy/set', { method: 'POST', body: JSON.stringify(body) })
      .then(() => loadStatus())
      .catch(() => {})
      .finally(() => setIsSaving(false));
  }

  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        onClick={() => setShowPanel((prev) => !prev)}
        className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs bg-slate-800 border border-slate-700 text-slate-300 hover:text-white hover:border-slate-600 transition-colors"
        title={style.label}
      >
        <span className={`w-2 h-2 rounded-full ${style.dot}`} />
        <span className="hidden lg:inline">{style.label}</span>
      </button>

      {showPanel && (
        <div className="absolute right-0 top-full mt-1 w-72 glass-card p-3 bg-slate-800/95 border border-slate-700 rounded-lg shadow-xl z-50">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-semibold text-white">Economy Mode</div>
            <button
              type="button"
              onClick={() => setShowPanel(false)}
              className="text-slate-500 hover:text-white"
              aria-label="Close panel"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setEconomy(!isEnabled)}
              disabled={isSaving}
              className="w-full px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
            >
              {isEnabled ? 'Disable Economy' : 'Enable Economy'}
            </button>
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-slate-300">Auto trigger threshold (%)</label>
              <div className="flex gap-2">
                <input
                  type="number"
                  min="1"
                  max="100"
                  step="1"
                  value={threshold}
                  onChange={(e) => setThreshold(e.target.value)}
                  className="w-full bg-slate-800/60 border border-slate-700/50 rounded-md px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
                  placeholder="85"
                />
                <button
                  type="button"
                  onClick={saveThreshold}
                  disabled={isSaving || thresholdNumber === null}
                  className="px-3 py-1.5 rounded-md bg-slate-700 hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs transition-colors"
                >
                  Save
                </button>
              </div>
              {!isEnabled && (
                <p className="text-[10px] text-slate-500">
                  Save updates take effect while economy is enabled.
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
