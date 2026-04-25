import { useCallback, useEffect, useMemo, useState } from 'react';
import { concurrency as concurrencyApi } from '../api';
import { useToast } from '../components/Toast';
import LoadingSkeleton from '../components/LoadingSkeleton';

const EMPTY_FORM = { key_pattern: '', max_concurrent: '1' };

function normalizeLimits(payload) {
  return Array.isArray(payload?.limits)
    ? payload.limits
        .filter((row) => row?.key_pattern)
        .map((row) => ({
          ...row,
          key_pattern: String(row.key_pattern),
          max_concurrent: Number(row.max_concurrent) || 0,
        }))
    : [];
}

function normalizeActive(payload) {
  return Array.isArray(payload?.active)
    ? payload.active
        .filter((row) => row?.concurrency_key)
        .map((row) => ({
          concurrency_key: String(row.concurrency_key),
          active: Number(row.active) || 0,
        }))
    : [];
}

function keyMatchesPattern(key, pattern) {
  if (!key || !pattern) return false;
  if (pattern.endsWith('*')) {
    return key.startsWith(pattern.slice(0, -1));
  }
  return key === pattern;
}

function activeCountForPattern(pattern, activeRows) {
  return activeRows.reduce((total, row) => (
    keyMatchesPattern(row.concurrency_key, pattern) ? total + row.active : total
  ), 0);
}

function findMatchingLimit(key, limits) {
  const exact = limits.find((limit) => limit.key_pattern === key);
  if (exact) return exact.key_pattern;

  const wildcard = limits
    .filter((limit) => limit.key_pattern.endsWith('*') && keyMatchesPattern(key, limit.key_pattern))
    .sort((a, b) => b.key_pattern.length - a.key_pattern.length)[0];
  return wildcard?.key_pattern || null;
}

function parseLimitValue(value) {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

function usagePercent(active, max) {
  if (max <= 0) return active >= max ? 100 : 0;
  return Math.min(100, Math.round((active / max) * 100));
}

function formatUpdatedAt(value) {
  if (!value) return '-';
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return String(value);
  return timestamp.toLocaleString();
}

export default function Concurrency() {
  const [data, setData] = useState({ limits: [], active: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingValues, setEditingValues] = useState({});
  const [savingKey, setSavingKey] = useState('');
  const toast = useToast();

  const loadData = useCallback(async (options = {}) => {
    if (!options.silent) setLoading(true);
    try {
      const payload = await concurrencyApi.get();
      setData({
        limits: normalizeLimits(payload),
        active: normalizeActive(payload),
      });
      setError('');
    } catch (err) {
      console.error('Failed to load concurrency limits:', err);
      setError(err.message || 'Failed to load concurrency limits');
      toast.error('Failed to load concurrency limits');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadData();
    const intervalId = setInterval(() => {
      if (document.hidden) return;
      loadData({ silent: true });
    }, 30000);
    return () => clearInterval(intervalId);
  }, [loadData]);

  const limitRows = useMemo(() => {
    return data.limits.map((limit) => {
      const active = activeCountForPattern(limit.key_pattern, data.active);
      const percent = usagePercent(active, limit.max_concurrent);
      return {
        ...limit,
        active,
        percent,
        saturated: active >= limit.max_concurrent,
      };
    });
  }, [data.active, data.limits]);

  const activeRows = useMemo(() => {
    return data.active.map((row) => ({
      ...row,
      matched_limit: findMatchingLimit(row.concurrency_key, data.limits),
    }));
  }, [data.active, data.limits]);

  const saturatedCount = limitRows.filter((row) => row.saturated).length;

  async function saveLimit(keyPattern, rawValue) {
    const maxConcurrent = parseLimitValue(rawValue);
    if (maxConcurrent === null) {
      toast.error('Max concurrent must be a non-negative integer');
      return;
    }

    setSavingKey(keyPattern);
    try {
      await concurrencyApi.setLimit({
        key_pattern: keyPattern,
        max_concurrent: maxConcurrent,
      });
      setEditingValues((current) => {
        const next = { ...current };
        delete next[keyPattern];
        return next;
      });
      toast.success('Concurrency limit saved');
      await loadData({ silent: true });
    } catch (err) {
      toast.error(`Failed to save limit: ${err.message}`);
    } finally {
      setSavingKey('');
    }
  }

  async function handleAddLimit(event) {
    event.preventDefault();
    const keyPattern = form.key_pattern.trim();
    const maxConcurrent = parseLimitValue(form.max_concurrent);
    if (!keyPattern || maxConcurrent === null) {
      toast.error('Key pattern and numeric max concurrent are required');
      return;
    }

    setSavingKey('__new__');
    try {
      await concurrencyApi.setLimit({
        key_pattern: keyPattern,
        max_concurrent: maxConcurrent,
      });
      setForm(EMPTY_FORM);
      toast.success('Concurrency limit added');
      await loadData({ silent: true });
    } catch (err) {
      toast.error(`Failed to add limit: ${err.message}`);
    } finally {
      setSavingKey('');
    }
  }

  async function handleRemoveLimit(keyPattern) {
    setSavingKey(keyPattern);
    try {
      await concurrencyApi.removeLimit(keyPattern);
      toast.success('Concurrency limit removed');
      await loadData({ silent: true });
    } catch (err) {
      toast.error(`Failed to remove limit: ${err.message}`);
    } finally {
      setSavingKey('');
    }
  }

  if (loading) {
    return (
      <div className="p-6">
        <LoadingSkeleton lines={5} />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200" role="alert">
          {error}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <div className="glass-card p-4">
          <p className="text-xs uppercase tracking-wide text-slate-500">Limits</p>
          <p className="mt-1 text-2xl font-semibold text-white">{limitRows.length}</p>
        </div>
        <div className="glass-card p-4">
          <p className="text-xs uppercase tracking-wide text-slate-500">Active Keys</p>
          <p className="mt-1 text-2xl font-semibold text-white">{activeRows.length}</p>
        </div>
        <div className="glass-card p-4">
          <p className="text-xs uppercase tracking-wide text-slate-500">Saturated</p>
          <p className={`mt-1 text-2xl font-semibold ${saturatedCount > 0 ? 'text-amber-300' : 'text-white'}`}>
            {saturatedCount}
          </p>
        </div>
      </div>

      <form onSubmit={handleAddLimit} className="glass-card p-5">
        <h2 className="text-lg font-semibold text-white mb-4">Add Limit</h2>
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_160px_auto]">
          <label className="block">
            <span className="heading-sm text-slate-400">Key Pattern</span>
            <input
              type="text"
              value={form.key_pattern}
              onChange={(event) => setForm((current) => ({ ...current, key_pattern: event.target.value }))}
              placeholder="tenant:*"
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
            />
          </label>
          <label className="block">
            <span className="heading-sm text-slate-400">Max</span>
            <input
              type="number"
              min={0}
              step={1}
              value={form.max_concurrent}
              onChange={(event) => setForm((current) => ({ ...current, max_concurrent: event.target.value }))}
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
            />
          </label>
          <button
            type="submit"
            disabled={savingKey === '__new__'}
            className="self-end rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {savingKey === '__new__' ? 'Adding...' : 'Add'}
          </button>
        </div>
      </form>

      <div className="glass-card overflow-hidden">
        <div className="border-b border-slate-700 px-5 py-4">
          <h2 className="text-lg font-semibold text-white">Limits</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-700 bg-slate-900/60 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3 text-left">Key Pattern</th>
                <th className="px-4 py-3 text-left">Max</th>
                <th className="px-4 py-3 text-left">Active</th>
                <th className="px-4 py-3 text-left">Used</th>
                <th className="px-4 py-3 text-left">Updated</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {limitRows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-slate-500">
                    No concurrency limits configured.
                  </td>
                </tr>
              ) : limitRows.map((row) => {
                const value = editingValues[row.key_pattern] ?? String(row.max_concurrent);
                return (
                  <tr
                    key={row.key_pattern}
                    className={row.saturated ? 'bg-amber-500/10' : 'bg-transparent'}
                  >
                    <td className="px-4 py-3 font-mono text-slate-100">{row.key_pattern}</td>
                    <td className="px-4 py-3">
                      <input
                        type="number"
                        min={0}
                        step={1}
                        value={value}
                        onChange={(event) => setEditingValues((current) => ({
                          ...current,
                          [row.key_pattern]: event.target.value,
                        }))}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            saveLimit(row.key_pattern, value);
                          }
                        }}
                        className="w-24 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-white outline-none focus:border-blue-500"
                      />
                    </td>
                    <td className="px-4 py-3 text-slate-200">{row.active}</td>
                    <td className="px-4 py-3">
                      <div className="flex min-w-32 items-center gap-3">
                        <div className="h-2 flex-1 rounded-full bg-slate-800">
                          <div
                            className={`h-2 rounded-full ${row.saturated ? 'bg-amber-400' : 'bg-blue-500'}`}
                            style={{ width: `${row.percent}%` }}
                          />
                        </div>
                        <span className={row.saturated ? 'w-10 text-right text-amber-300' : 'w-10 text-right text-slate-300'}>
                          {row.percent}%
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-400">{formatUpdatedAt(row.updated_at)}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          disabled={savingKey === row.key_pattern}
                          onClick={() => saveLimit(row.key_pattern, value)}
                          className="rounded-lg border border-blue-500/40 px-3 py-1.5 text-xs font-medium text-blue-300 transition-colors hover:bg-blue-500/10 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          disabled={savingKey === row.key_pattern}
                          onClick={() => handleRemoveLimit(row.key_pattern)}
                          className="rounded-lg border border-red-500/40 px-3 py-1.5 text-xs font-medium text-red-300 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="glass-card overflow-hidden">
        <div className="border-b border-slate-700 px-5 py-4">
          <h2 className="text-lg font-semibold text-white">Active Keys</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-700 bg-slate-900/60 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3 text-left">Concurrency Key</th>
                <th className="px-4 py-3 text-left">Active</th>
                <th className="px-4 py-3 text-left">Matched Limit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {activeRows.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-4 py-6 text-center text-slate-500">
                    No active concurrency keys.
                  </td>
                </tr>
              ) : activeRows.map((row) => (
                <tr key={row.concurrency_key}>
                  <td className="px-4 py-3 font-mono text-slate-100">{row.concurrency_key}</td>
                  <td className="px-4 py-3 text-slate-200">{row.active}</td>
                  <td className="px-4 py-3 font-mono text-slate-400">{row.matched_limit || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
