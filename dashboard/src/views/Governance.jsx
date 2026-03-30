import { useEffect, useState } from 'react';
import { governance as governanceApi } from '../api';
import { useToast } from '../components/Toast';
import StatCard from '../components/StatCard';
import LoadingSkeleton from '../components/LoadingSkeleton';

const MODE_OPTIONS = [
  { value: 'block', label: 'Block' },
  { value: 'warn', label: 'Warn' },
  { value: 'shadow', label: 'Shadow' },
  { value: 'off', label: 'Off' },
];

const JUDGMENT_POLICIES = [
  'Never manually implement what TORQUE should produce — plan, submit, verify, integrate',
  'On TORQUE failure: diagnose root cause, fix, resubmit — do not bypass by writing code manually',
  'Investigate before deleting unknown files — untracked files may be work products from other sessions',
  'Always Read before Edit — never guess at indentation, whitespace, or surrounding context',
  'Separate harness failures from code failures — "did the edit apply?" vs "is the code correct?"',
  'Avoid retry loops — if an approach fails twice, change strategy instead of retrying',
  'TORQUE is shared infrastructure — never restart or shutdown TORQUE to solve a task-level problem',
  'When in doubt, ASK the user — cancellation is irreversible, a task\'s work is lost',
  'Always await after run_workflow or submit_task — monitor progress, don\'t ask first',
];

function normalizeRules(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.rules)) return payload.rules;
  return [];
}

function formatStage(stage) {
  if (!stage) return '-';
  return String(stage)
    .split('_')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function ToggleSwitch({ checked, disabled, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-10 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${checked ? 'bg-blue-600' : 'bg-slate-600'}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform ${checked ? 'translate-x-5' : ''}`}
      />
    </button>
  );
}

export default function Governance() {
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [updatingRuleIds, setUpdatingRuleIds] = useState({});
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;

    async function loadRules() {
      try {
        const response = await governanceApi.getRules();
        if (cancelled) return;
        setRules(normalizeRules(response));
        setError('');
      } catch (err) {
        if (cancelled) return;
        console.error('Failed to load governance rules:', err);
        setError(err.message || 'Failed to load governance rules');
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadRules();
    return () => {
      cancelled = true;
    };
  }, []);

  function setRuleBusy(ruleId, busy) {
    setUpdatingRuleIds((current) => {
      if (!busy) {
        const next = { ...current };
        delete next[ruleId];
        return next;
      }
      return { ...current, [ruleId]: true };
    });
  }

  function patchRule(ruleId, patch) {
    setRules((current) => current.map((rule) => (
      rule.id === ruleId ? { ...rule, ...patch } : rule
    )));
  }

  async function handleModeChange(rule, mode) {
    const previousMode = rule.mode;
    patchRule(rule.id, { mode });
    setRuleBusy(rule.id, true);
    setError('');

    try {
      const response = await governanceApi.updateRule(rule.id, { mode });
      if (response?.rule) {
        patchRule(rule.id, response.rule);
      }
      toast.success(`Rule mode updated to ${mode}`);
    } catch (err) {
      console.error('Failed to update governance rule mode:', err);
      patchRule(rule.id, { mode: previousMode });
      setError(err.message || 'Failed to update governance rule mode');
      toast.error(`Failed to update mode: ${err.message}`);
    } finally {
      setRuleBusy(rule.id, false);
    }
  }

  async function handleEnabledChange(rule, enabled) {
    const previousEnabled = rule.enabled;
    patchRule(rule.id, { enabled });
    setRuleBusy(rule.id, true);
    setError('');

    try {
      const response = await governanceApi.updateRule(rule.id, { enabled });
      if (response?.rule) {
        patchRule(rule.id, response.rule);
      }
    } catch (err) {
      console.error('Failed to update governance rule enabled state:', err);
      patchRule(rule.id, { enabled: previousEnabled });
      setError(err.message || 'Failed to update governance rule enabled state');
      toast.error(`Failed to update rule: ${err.message}`);
    } finally {
      setRuleBusy(rule.id, false);
    }
  }

  if (loading) {
    return (
      <div className="p-6">
        <LoadingSkeleton lines={8} />
      </div>
    );
  }

  const activeRules = rules.filter(rule => rule.enabled).length;
  const blockingRules = rules.filter(rule => rule.enabled && rule.mode === 'block').length;
  const warningRules = rules.filter(rule => rule.enabled && rule.mode === 'warn').length;
  const violations24h = rules.reduce((sum, rule) => sum + Number(rule.violation_count || 0), 0);

  return (
    <div className="p-6">
      <div className="mb-6">
        <h2 className="heading-lg text-white">Governance</h2>
        <p className="text-slate-400 text-sm mt-1">
          Manage enforceable operational rules and the judgment policies that stay advisory.
        </p>
      </div>

      {error ? (
        <div className="mb-6 rounded-lg border border-red-500/30 bg-red-950/30 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
        <StatCard label="Active Rules" value={activeRules} gradient="blue" />
        <StatCard label="Blocking" value={blockingRules} gradient="red" />
        <StatCard label="Warning" value={warningRules} gradient="orange" />
        <StatCard label="Violations (24h)" value={violations24h} gradient="purple" />
      </div>

      <div className="glass-card overflow-hidden mb-6">
        <div className="px-6 py-4 border-b border-slate-700/50">
          <h3 className="text-white font-semibold">Enforceable Rules</h3>
          <p className="text-slate-400 text-sm mt-1">
            Rule mode and enabled state take effect through the governance engine immediately.
          </p>
        </div>

        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-700/50">
              <th className="text-left p-4 heading-sm">Rule</th>
              <th className="text-left p-4 heading-sm">Stage</th>
              <th className="text-left p-4 heading-sm">Mode</th>
              <th className="text-left p-4 heading-sm">Violations</th>
              <th className="text-left p-4 heading-sm">Enabled</th>
            </tr>
          </thead>
          <tbody>
            {rules.length === 0 ? (
              <tr>
                <td colSpan={5} className="p-8 text-center text-slate-500">
                  No governance rules found
                </td>
              </tr>
            ) : (
              rules.map((rule) => {
                const isUpdating = Boolean(updatingRuleIds[rule.id]);

                return (
                  <tr
                    key={rule.id}
                    className="border-b border-slate-700/30 hover:bg-slate-700/20 transition-colors"
                  >
                    <td className="p-4 align-top">
                      <div className="space-y-1">
                        <p className="text-sm font-medium text-white">{rule.name || rule.id}</p>
                        <p className="text-sm text-slate-400 max-w-2xl">
                          {rule.description || 'No description available'}
                        </p>
                      </div>
                    </td>
                    <td className="p-4 align-top">
                      <span className="inline-flex items-center rounded-full bg-slate-800 px-2.5 py-1 text-xs font-medium text-slate-300">
                        {formatStage(rule.stage)}
                      </span>
                    </td>
                    <td className="p-4 align-top">
                      <select
                        value={rule.mode || 'off'}
                        onChange={(e) => handleModeChange(rule, e.target.value)}
                        disabled={isUpdating}
                        aria-label={`Mode for ${rule.name || rule.id}`}
                        className="w-full min-w-32 bg-slate-800/60 border border-slate-700/50 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 disabled:opacity-50"
                      >
                        {MODE_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="p-4 align-top text-slate-300 text-sm">
                      {Number(rule.violation_count || 0)}
                    </td>
                    <td className="p-4 align-top">
                      <div className="flex items-center gap-3">
                        <ToggleSwitch
                          checked={Boolean(rule.enabled)}
                          disabled={isUpdating}
                          label={`Toggle ${rule.name || rule.id}`}
                          onChange={(enabled) => handleEnabledChange(rule, enabled)}
                        />
                        <span className={`text-xs font-medium ${rule.enabled ? 'text-emerald-400' : 'text-slate-500'}`}>
                          {rule.enabled ? 'Enabled' : 'Disabled'}
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="glass-card p-6">
        <div className="mb-4">
          <h3 className="text-white font-semibold">Judgment Policies</h3>
          <p className="text-slate-400 text-sm mt-1">
            These remain read-only guidance and are not enforced as automated rule checks.
          </p>
        </div>

        <div className="space-y-3">
          {JUDGMENT_POLICIES.map((policy) => (
            <div
              key={policy}
              className="border-l-2 border-blue-500/60 bg-slate-900 rounded-r-lg px-4 py-3"
            >
              <p className="text-sm text-slate-400">{policy}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
