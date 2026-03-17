import { useState, useEffect, useCallback } from 'react';
import { strategic as api } from '../api';
import { useToast } from '../components/Toast';

// ─── Constants ──────────────────────────────────────────────

const KNOWN_PROVIDERS = [
  null, 'deepinfra', 'hyperbolic', 'ollama', 'ollama-cloud',
];

const PROVIDER_LABELS = {
  null: '(none)',
  deepinfra: 'deepinfra',
  hyperbolic: 'hyperbolic',
  ollama: 'ollama',
  'ollama-cloud': 'ollama-cloud',
};

const DECOMPOSE_VARIABLES = [
  '{{task_description}}', '{{project_context}}', '{{coding_standards}}',
  '{{step_list}}', '{{provider_hints}}',
];

const DIAGNOSE_VARIABLES = [
  '{{task_description}}', '{{error_output}}', '{{recovery_actions}}',
  '{{custom_patterns}}', '{{escalation_threshold}}',
];

const REVIEW_VARIABLES = [
  '{{task_description}}', '{{diff_content}}', '{{criteria}}',
  '{{auto_approve_threshold}}', '{{strict_mode}}',
];

// ─── Pill Tag Component ─────────────────────────────────────

function PillTag({ label, onRemove }) {
  return (
    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-slate-700 text-slate-200 text-xs font-medium">
      {label}
      {onRemove && (
        <button
          onClick={onRemove}
          className="ml-0.5 text-slate-400 hover:text-red-400 transition-colors"
          aria-label={`Remove ${label}`}
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
    </span>
  );
}

// ─── Inline Add Input ────────────────────────────────────────

function InlineAddInput({ placeholder, onAdd }) {
  const [value, setValue] = useState('');

  function handleAdd() {
    const trimmed = value.trim();
    if (trimmed) {
      onAdd(trimmed);
      setValue('');
    }
  }

  return (
    <span className="inline-flex items-center gap-1">
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAdd(); } }}
        placeholder={placeholder}
        className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-xs text-white w-32 focus:outline-none focus:border-blue-500"
      />
      <button
        onClick={handleAdd}
        className="px-2 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white text-xs transition-colors"
      >
        +
      </button>
    </span>
  );
}

// ─── Toggle Switch ───────────────────────────────────────────

function Toggle({ checked, onChange, label }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <div
        className={`relative w-10 h-5 rounded-full transition-colors ${checked ? 'bg-blue-600' : 'bg-slate-600'}`}
        onClick={() => onChange(!checked)}
      >
        <div
          className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${checked ? 'translate-x-5' : ''}`}
        />
      </div>
      {label && <span className="text-sm text-slate-300">{label}</span>}
    </label>
  );
}

// ─── Summary Cards ───────────────────────────────────────────

function SummaryCard({ title, icon, children, onClick }) {
  return (
    <button
      onClick={onClick}
      className="glass-card p-5 text-left hover:border-blue-500/40 hover:bg-slate-800/80 transition-all group w-full"
    >
      <div className="flex items-center gap-2 mb-3">
        <span className="text-lg">{icon}</span>
        <h3 className="text-sm font-semibold text-white group-hover:text-blue-400 transition-colors">{title}</h3>
      </div>
      {children}
    </button>
  );
}

// ─── Drawer Editor ───────────────────────────────────────────

function DrawerEditor({ title, isOpen, onClose, onSave, onReset, children, advancedContent }) {
  const [tab, setTab] = useState('form');

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div className="flex-1 bg-black/40 backdrop-blur-sm" onClick={onClose} />

      {/* Drawer */}
      <div className="w-full max-w-xl bg-slate-900 border-l border-slate-700 flex flex-col animate-slide-in-right overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700">
          <h2 className="text-lg font-semibold text-white">{title}</h2>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white transition-colors"
            aria-label="Close drawer"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex border-b border-slate-700">
          <button
            onClick={() => setTab('form')}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === 'form' ? 'border-blue-500 text-white' : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Form
          </button>
          <button
            onClick={() => setTab('advanced')}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === 'advanced' ? 'border-blue-500 text-white' : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Advanced
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {tab === 'form' ? children : advancedContent}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-slate-700 bg-slate-900/80">
          <button
            onClick={onReset}
            className="px-4 py-2 text-sm text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-lg transition-colors"
          >
            Reset to Defaults
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-slate-400 hover:text-white rounded-lg transition-colors"
            >
              Close
            </button>
            <button
              onClick={onSave}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Advanced Tab Content ────────────────────────────────────

function AdvancedPromptEditor({ customPrompt, onChange, variables }) {
  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-slate-300 mb-2">Custom Prompt</label>
        <textarea
          value={customPrompt || ''}
          onChange={(e) => onChange(e.target.value || null)}
          placeholder="Leave empty to use auto-generated prompt..."
          rows={12}
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-blue-500 resize-y"
        />
      </div>
      <div>
        <p className="text-xs font-medium text-slate-400 mb-2">Available variables:</p>
        <div className="flex flex-wrap gap-1.5">
          {variables.map((v) => (
            <span key={v} className="px-2 py-0.5 rounded bg-slate-800 text-slate-400 text-xs font-mono border border-slate-700">
              {v}
            </span>
          ))}
        </div>
      </div>
      <button
        onClick={() => onChange(null)}
        className="text-xs text-slate-500 hover:text-slate-300 transition-colors underline"
      >
        Reset to generated
      </button>
    </div>
  );
}

// ─── Pattern List Editor ─────────────────────────────────────

function PatternList({ patterns, onChange }) {
  function addPattern() {
    onChange([...(patterns || []), { match: '', action: 'retry', reason: '' }]);
  }

  function removePattern(index) {
    onChange(patterns.filter((_, i) => i !== index));
  }

  function updatePattern(index, field, value) {
    const updated = patterns.map((p, i) => i === index ? { ...p, [field]: value } : p);
    onChange(updated);
  }

  return (
    <div className="space-y-2">
      {(patterns || []).map((p, i) => (
        <div key={i} className="flex items-start gap-2 bg-slate-800/50 rounded-lg p-3 border border-slate-700/50">
          <div className="flex-1 space-y-2">
            <input
              type="text"
              value={p.match || ''}
              onChange={(e) => updatePattern(i, 'match', e.target.value)}
              placeholder="Match pattern..."
              className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1 text-xs text-white font-mono focus:outline-none focus:border-blue-500"
            />
            <div className="flex gap-2">
              <select
                value={p.action || 'retry'}
                onChange={(e) => updatePattern(i, 'action', e.target.value)}
                className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"
              >
                <option value="retry">retry</option>
                <option value="fallback">fallback</option>
                <option value="escalate">escalate</option>
                <option value="skip">skip</option>
              </select>
              <input
                type="text"
                value={p.reason || ''}
                onChange={(e) => updatePattern(i, 'reason', e.target.value)}
                placeholder="Reason..."
                className="flex-1 bg-slate-800 border border-slate-600 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>
          <button
            onClick={() => removePattern(i)}
            className="text-slate-400 hover:text-red-400 mt-1 transition-colors"
            aria-label="Remove pattern"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      ))}
      <button
        onClick={addPattern}
        className="px-3 py-1.5 text-xs text-blue-400 hover:text-blue-300 border border-dashed border-slate-600 hover:border-blue-500/50 rounded-lg transition-colors w-full"
      >
        + Add Pattern
      </button>
    </div>
  );
}

// ─── Criteria List Editor ────────────────────────────────────

function CriteriaList({ criteria, onChange }) {
  function addCriterion() {
    onChange([...(criteria || []), '']);
  }

  function removeCriterion(index) {
    onChange(criteria.filter((_, i) => i !== index));
  }

  function updateCriterion(index, value) {
    onChange(criteria.map((c, i) => i === index ? value : c));
  }

  return (
    <div className="space-y-2">
      {(criteria || []).map((c, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            type="text"
            value={c}
            onChange={(e) => updateCriterion(i, e.target.value)}
            placeholder="Review criterion..."
            className="flex-1 bg-slate-800 border border-slate-600 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"
          />
          <button
            onClick={() => removeCriterion(i)}
            className="text-slate-400 hover:text-red-400 transition-colors"
            aria-label="Remove criterion"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      ))}
      <button
        onClick={addCriterion}
        className="px-3 py-1.5 text-xs text-blue-400 hover:text-blue-300 border border-dashed border-slate-600 hover:border-blue-500/50 rounded-lg transition-colors w-full"
      >
        + Add Criterion
      </button>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────

export default function StrategicConfig() {
  const [config, setConfig] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [activeDrawer, setActiveDrawer] = useState(null);
  const [editingConfig, setEditingConfig] = useState(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [loading, setLoading] = useState(true);
  const toast = useToast();

  // ─── Data Loading ────────────────────────────────────────

  const loadData = useCallback(async () => {
    try {
      const [configData, templateData] = await Promise.all([
        api.getConfig(),
        api.listConfigTemplates().catch(() => []),
      ]);
      setConfig(configData);
      setEditingConfig(structuredClone(configData));
      const tList = Array.isArray(templateData) ? templateData : (templateData?.items || []);
      setTemplates(tList);
    } catch (err) {
      toast.error(`Failed to load config: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // ─── Helpers ─────────────────────────────────────────────

  function markChanged(updater) {
    setEditingConfig((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      return next;
    });
    setHasChanges(true);
  }

  function getCapabilityConfig(capability) {
    return editingConfig?.[capability] || {};
  }

  function setCapabilityField(capability, field, value) {
    markChanged((prev) => ({
      ...prev,
      [capability]: { ...(prev?.[capability] || {}), [field]: value },
    }));
  }

  // ─── Template Application ────────────────────────────────

  function applyTemplate() {
    const tpl = templates.find((t) => t.name === selectedTemplate || t.id === selectedTemplate);
    if (!tpl) return;
    const merged = { ...editingConfig, ...(tpl.config || tpl) };
    setEditingConfig(merged);
    setHasChanges(true);
    toast.info(`Applied template: ${tpl.name || selectedTemplate}`);
  }

  // ─── Save / Reset ────────────────────────────────────────

  async function saveConfig() {
    try {
      const saved = await api.setConfig(editingConfig);
      setConfig(saved || editingConfig);
      setEditingConfig(structuredClone(saved || editingConfig));
      setHasChanges(false);
      toast.success('Configuration saved');
    } catch (err) {
      toast.error(`Save failed: ${err.message}`);
    }
  }

  async function resetConfig() {
    try {
      const fresh = await api.resetConfig();
      setConfig(fresh);
      setEditingConfig(structuredClone(fresh));
      setHasChanges(false);
      toast.success('Configuration reset to defaults');
    } catch (err) {
      toast.error(`Reset failed: ${err.message}`);
    }
  }

  async function saveDrawer() {
    await saveConfig();
    setActiveDrawer(null);
  }

  async function resetDrawer() {
    await resetConfig();
    setActiveDrawer(null);
  }

  // ─── Derived values ──────────────────────────────────────

  const decompose = getCapabilityConfig('decompose');
  const diagnose = getCapabilityConfig('diagnose');
  const review = getCapabilityConfig('review');

  const decomposeSteps = decompose.steps || [];
  const diagnoseActions = diagnose.recovery_actions || [];
  const reviewCriteria = review.criteria || [];

  // ─── Loading state ───────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-slate-400">Loading configuration...</p>
      </div>
    );
  }

  if (!editingConfig) {
    return (
      <div className="glass-card p-6 text-center">
        <p className="text-slate-400">No configuration data available.</p>
        <p className="text-slate-500 text-sm mt-1">The Strategic Brain config endpoint may not be running.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ── Summary Cards ──────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <SummaryCard title="Decompose" icon={'\u2702\uFE0F'} onClick={() => setActiveDrawer('decompose')}>
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1">
              {decomposeSteps.length > 0
                ? decomposeSteps.map((s) => <PillTag key={s} label={s} />)
                : <span className="text-xs text-slate-500">No steps configured</span>
              }
            </div>
            <p className="text-xs text-slate-500">
              {decomposeSteps.length} step{decomposeSteps.length !== 1 ? 's' : ''}
              {decompose.template && <span> &middot; template: <span className="text-slate-400">{decompose.template}</span></span>}
            </p>
          </div>
        </SummaryCard>

        <SummaryCard title="Diagnose" icon={'\uD83D\uDD0D'} onClick={() => setActiveDrawer('diagnose')}>
          <div className="space-y-2">
            <p className="text-sm text-slate-300">
              {diagnoseActions.length} recovery action{diagnoseActions.length !== 1 ? 's' : ''}
            </p>
            <p className="text-xs text-slate-500">
              Escalation threshold: <span className="text-slate-400">{diagnose.escalation_threshold ?? 3}</span>
            </p>
          </div>
        </SummaryCard>

        <SummaryCard title="Review" icon={'\u2705'} onClick={() => setActiveDrawer('review')}>
          <div className="space-y-2">
            <p className="text-sm text-slate-300">
              {reviewCriteria.length} criteri{reviewCriteria.length !== 1 ? 'a' : 'on'}
            </p>
            <div className="flex items-center gap-2">
              <p className="text-xs text-slate-500">
                Auto-approve: <span className="text-slate-400">{review.auto_approve_threshold ?? 80}%</span>
              </p>
              {review.strict_mode && (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-500/20 text-red-400">
                  strict
                </span>
              )}
            </div>
          </div>
        </SummaryCard>
      </div>

      {/* ── Template Selector ──────────────────────────── */}
      {templates.length > 0 && (
        <div className="glass-card p-4">
          <div className="flex items-center gap-3">
            <label className="text-sm text-slate-400 shrink-0">Template:</label>
            <select
              value={selectedTemplate}
              onChange={(e) => setSelectedTemplate(e.target.value)}
              className="bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500 flex-1 max-w-xs"
            >
              <option value="">Select a template...</option>
              {templates.map((t) => (
                <option key={t.name || t.id} value={t.name || t.id}>
                  {t.name || t.id}
                </option>
              ))}
            </select>
            <button
              onClick={applyTemplate}
              disabled={!selectedTemplate}
              className="px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-lg transition-colors"
            >
              Apply
            </button>
          </div>
        </div>
      )}

      {/* ── Global Settings ────────────────────────────── */}
      <div className="glass-card p-5">
        <h3 className="text-sm font-semibold text-white mb-4">Global Settings</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Provider */}
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">Provider</label>
            <select
              value={editingConfig.provider ?? ''}
              onChange={(e) => markChanged((prev) => ({ ...prev, provider: e.target.value || null }))}
              className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
            >
              {KNOWN_PROVIDERS.map((p) => (
                <option key={p ?? '__none__'} value={p ?? ''}>
                  {PROVIDER_LABELS[p] || p}
                </option>
              ))}
            </select>
          </div>

          {/* Model */}
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">Model</label>
            <input
              type="text"
              value={editingConfig.model || ''}
              onChange={(e) => markChanged((prev) => ({ ...prev, model: e.target.value || null }))}
              placeholder="e.g. Qwen/Qwen2.5-72B-Instruct"
              className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
            />
          </div>

          {/* Confidence Threshold */}
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">
              Confidence Threshold: <span className="text-white">{(editingConfig.confidence_threshold ?? 0.7).toFixed(2)}</span>
            </label>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={editingConfig.confidence_threshold ?? 0.7}
              onChange={(e) => markChanged((prev) => ({ ...prev, confidence_threshold: parseFloat(e.target.value) }))}
              className="w-full accent-blue-500"
            />
          </div>

          {/* Temperature */}
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">
              Temperature: <span className="text-white">{(editingConfig.temperature ?? 0.3).toFixed(2)}</span>
            </label>
            <input
              type="range"
              min="0"
              max="2"
              step="0.01"
              value={editingConfig.temperature ?? 0.3}
              onChange={(e) => markChanged((prev) => ({ ...prev, temperature: parseFloat(e.target.value) }))}
              className="w-full accent-blue-500"
            />
          </div>
        </div>

        {/* Save / Reset bar */}
        {hasChanges && (
          <div className="flex items-center justify-end gap-2 mt-4 pt-4 border-t border-slate-700/50">
            <button
              onClick={() => { setEditingConfig(structuredClone(config)); setHasChanges(false); }}
              className="px-4 py-2 text-sm text-slate-400 hover:text-white rounded-lg transition-colors"
            >
              Discard
            </button>
            <button
              onClick={saveConfig}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
            >
              Save Changes
            </button>
          </div>
        )}
      </div>

      {/* ── Decompose Drawer ───────────────────────────── */}
      <DrawerEditor
        title="Decompose Configuration"
        isOpen={activeDrawer === 'decompose'}
        onClose={() => setActiveDrawer(null)}
        onSave={saveDrawer}
        onReset={resetDrawer}
        advancedContent={
          <AdvancedPromptEditor
            customPrompt={decompose.custom_prompt}
            onChange={(v) => setCapabilityField('decompose', 'custom_prompt', v)}
            variables={DECOMPOSE_VARIABLES}
          />
        }
      >
        <div className="space-y-5">
          {/* Steps */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">Steps</label>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {decomposeSteps.map((step) => (
                <PillTag
                  key={step}
                  label={step}
                  onRemove={() => setCapabilityField('decompose', 'steps', decomposeSteps.filter((s) => s !== step))}
                />
              ))}
              <InlineAddInput
                placeholder="Add step..."
                onAdd={(name) => {
                  if (!decomposeSteps.includes(name)) {
                    setCapabilityField('decompose', 'steps', [...decomposeSteps, name]);
                  }
                }}
              />
            </div>
          </div>

          {/* Provider hints */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">Provider Hints per Step</label>
            <div className="space-y-2">
              {decomposeSteps.map((step) => (
                <div key={step} className="flex items-center gap-3">
                  <span className="text-xs text-slate-400 w-20 truncate" title={step}>{step}</span>
                  <select
                    value={(decompose.provider_hints || {})[step] || 'auto'}
                    onChange={(e) => {
                      const hints = { ...(decompose.provider_hints || {}) };
                      if (e.target.value === 'auto') {
                        delete hints[step];
                      } else {
                        hints[step] = e.target.value;
                      }
                      setCapabilityField('decompose', 'provider_hints', hints);
                    }}
                    className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"
                  >
                    <option value="auto">auto</option>
                    <option value="ollama">ollama</option>
                    <option value="deepinfra">deepinfra</option>
                    <option value="hyperbolic">hyperbolic</option>
                    <option value="codex">codex</option>
                    <option value="ollama-cloud">ollama-cloud</option>
                  </select>
                </div>
              ))}
              {decomposeSteps.length === 0 && (
                <p className="text-xs text-slate-500">Add steps above to configure provider hints.</p>
              )}
            </div>
          </div>

          {/* Project context */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">Project Context</label>
            <textarea
              value={decompose.project_context || ''}
              onChange={(e) => setCapabilityField('decompose', 'project_context', e.target.value)}
              placeholder="Describe project structure, conventions, etc."
              rows={4}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 resize-y"
            />
          </div>

          {/* Coding standards */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">Coding Standards</label>
            <textarea
              value={decompose.coding_standards || ''}
              onChange={(e) => setCapabilityField('decompose', 'coding_standards', e.target.value)}
              placeholder="Key coding rules, naming conventions, etc."
              rows={4}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 resize-y"
            />
          </div>
        </div>
      </DrawerEditor>

      {/* ── Diagnose Drawer ────────────────────────────── */}
      <DrawerEditor
        title="Diagnose Configuration"
        isOpen={activeDrawer === 'diagnose'}
        onClose={() => setActiveDrawer(null)}
        onSave={saveDrawer}
        onReset={resetDrawer}
        advancedContent={
          <AdvancedPromptEditor
            customPrompt={diagnose.custom_prompt}
            onChange={(v) => setCapabilityField('diagnose', 'custom_prompt', v)}
            variables={DIAGNOSE_VARIABLES}
          />
        }
      >
        <div className="space-y-5">
          {/* Recovery actions */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">Recovery Actions</label>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {diagnoseActions.map((action) => (
                <PillTag
                  key={action}
                  label={action}
                  onRemove={() => setCapabilityField('diagnose', 'recovery_actions', diagnoseActions.filter((a) => a !== action))}
                />
              ))}
              <InlineAddInput
                placeholder="Add action..."
                onAdd={(name) => {
                  if (!diagnoseActions.includes(name)) {
                    setCapabilityField('diagnose', 'recovery_actions', [...diagnoseActions, name]);
                  }
                }}
              />
            </div>
          </div>

          {/* Custom patterns */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">Custom Patterns</label>
            <PatternList
              patterns={diagnose.custom_patterns || []}
              onChange={(patterns) => setCapabilityField('diagnose', 'custom_patterns', patterns)}
            />
          </div>

          {/* Escalation threshold */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">Escalation Threshold</label>
            <input
              type="number"
              min={1}
              max={10}
              value={diagnose.escalation_threshold ?? 3}
              onChange={(e) => setCapabilityField('diagnose', 'escalation_threshold', parseInt(e.target.value, 10) || 3)}
              className="bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-white w-24 focus:outline-none focus:border-blue-500"
            />
            <p className="text-xs text-slate-500 mt-1">
              Number of failed recovery attempts before escalating to a human or higher-tier provider.
            </p>
          </div>
        </div>
      </DrawerEditor>

      {/* ── Review Drawer ──────────────────────────────── */}
      <DrawerEditor
        title="Review Configuration"
        isOpen={activeDrawer === 'review'}
        onClose={() => setActiveDrawer(null)}
        onSave={saveDrawer}
        onReset={resetDrawer}
        advancedContent={
          <AdvancedPromptEditor
            customPrompt={review.custom_prompt}
            onChange={(v) => setCapabilityField('review', 'custom_prompt', v)}
            variables={REVIEW_VARIABLES}
          />
        }
      >
        <div className="space-y-5">
          {/* Criteria */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">Review Criteria</label>
            <CriteriaList
              criteria={reviewCriteria}
              onChange={(c) => setCapabilityField('review', 'criteria', c)}
            />
          </div>

          {/* Auto-approve threshold */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Auto-Approve Threshold: <span className="text-white">{review.auto_approve_threshold ?? 80}%</span>
            </label>
            <input
              type="range"
              min="0"
              max="100"
              step="1"
              value={review.auto_approve_threshold ?? 80}
              onChange={(e) => setCapabilityField('review', 'auto_approve_threshold', parseInt(e.target.value, 10))}
              className="w-full accent-blue-500"
            />
            <div className="flex justify-between text-[10px] text-slate-500 mt-0.5">
              <span>0% (manual)</span>
              <span>100% (auto)</span>
            </div>
          </div>

          {/* Strict mode */}
          <div>
            <Toggle
              checked={!!review.strict_mode}
              onChange={(v) => setCapabilityField('review', 'strict_mode', v)}
              label="Strict Mode"
            />
            <p className="text-xs text-slate-500 mt-1">
              When enabled, all review criteria must pass. When disabled, a majority is sufficient.
            </p>
          </div>
        </div>
      </DrawerEditor>
    </div>
  );
}
