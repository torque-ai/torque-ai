import { useState, useEffect, useCallback } from 'react';
import { routingTemplates as api } from '../api';
import { useToast } from '../components/Toast';

// ─── Provider Colors (hex for colored dots) ─────────────────────────────────

const PROVIDER_COLORS = {
  codex: '#3b82f6',
  'claude-cli': '#8b5cf6',
  ollama: '#22c55e',
  'aider-ollama': '#10b981',
  'hashline-ollama': '#14b8a6',
  anthropic: '#f59e0b',
  groq: '#ec4899',
  deepinfra: '#f97316',
  hyperbolic: '#a855f7',
  cerebras: '#06b6d4',
  'google-ai': '#4ade80',
  openrouter: '#fb923c',
  'ollama-cloud': '#34d399',
};

const KNOWN_PROVIDERS = [
  'ollama', 'hashline-ollama', 'aider-ollama', 'codex', 'claude-cli',
  'anthropic', 'deepinfra', 'hyperbolic', 'groq', 'cerebras',
  'google-ai', 'openrouter', 'ollama-cloud',
];

// ─── Provider Dropdown ──────────────────────────────────────────────────────

function ProviderSelect({ value, onChange, allowInherit = false }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className="w-2.5 h-2.5 rounded-full shrink-0"
        style={{ backgroundColor: (!allowInherit || value !== '__inherit__') ? (PROVIDER_COLORS[value] || '#6b7280') : '#475569' }}
      />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-blue-500 min-w-[160px]"
      >
        {allowInherit && <option value="__inherit__">(inherit)</option>}
        {KNOWN_PROVIDERS.map((p) => (
          <option key={p} value={p}>{p}</option>
        ))}
      </select>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export default function RoutingTemplates() {
  const [templates, setTemplates] = useState([]);
  const [categories, setCategories] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [editingRules, setEditingRules] = useState({});
  const [editingOverrides, setEditingOverrides] = useState({});
  const [expandedRows, setExpandedRows] = useState(new Set());
  const [hasChanges, setHasChanges] = useState(false);
  const [activeTemplateId, setActiveTemplateId] = useState(null);
  const [loading, setLoading] = useState(true);
  const toast = useToast();

  // ─── Data Loading ───────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    try {
      const [templateData, activeData, categoryData] = await Promise.all([
        api.list(),
        api.getActive(),
        api.categories(),
      ]);

      const templateList = Array.isArray(templateData) ? templateData : (templateData?.items || []);
      const categoryList = Array.isArray(categoryData) ? categoryData : (categoryData?.items || []);

      setTemplates(templateList);
      setCategories(categoryList);

      // Track which template is actively used for routing
      const activeId = activeData?.template?.id || null;
      setActiveTemplateId(activeData?.explicit ? activeId : null);

      // Select the active template or first available
      const firstId = templateList[0]?.id;
      const selectId = activeId || firstId || null;

      if (selectId) {
        const tpl = templateList.find((t) => t.id === selectId);
        if (tpl) {
          setSelectedId(selectId);
          setEditingRules({ ...tpl.rules });
          setEditingOverrides({ ...(tpl.complexity_overrides || {}) });
          setEditingName(tpl.name);
        }
      }
    } catch (err) {
      toast.error(`Failed to load templates: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // ─── Helpers ────────────────────────────────────────────────────────

  const selectedTemplate = templates.find((t) => t.id === selectedId);
  const [editingName, setEditingName] = useState('');

  function selectTemplate(id) {
    const tpl = templates.find((t) => t.id === id);
    if (!tpl) return;
    setSelectedId(id);
    setEditingRules({ ...tpl.rules });
    setEditingOverrides({ ...(tpl.complexity_overrides || {}) });
    setEditingName(tpl.name);
    setHasChanges(false);
    setExpandedRows(new Set());
  }

  function setRule(categoryKey, provider) {
    setEditingRules((prev) => ({ ...prev, [categoryKey]: provider }));
    setHasChanges(true);
  }

  function setOverride(categoryKey, complexity, provider) {
    setEditingOverrides((prev) => {
      const catOverrides = { ...(prev[categoryKey] || {}) };
      if (provider === '__inherit__') {
        delete catOverrides[complexity];
      } else {
        catOverrides[complexity] = provider;
      }
      return { ...prev, [categoryKey]: catOverrides };
    });
    setHasChanges(true);
  }

  function toggleExpand(key) {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  // ─── Actions ────────────────────────────────────────────────────────

  async function handleNew() {
    try {
      const defaultRules = {};
      for (const cat of categories) {
        defaultRules[cat.key] = 'ollama';
      }
      const result = await api.create({ name: 'New Template', rules: defaultRules, complexity_overrides: {} });
      const newTpl = result?.id ? result : result?.data || result;
      toast.success('Template created');
      await loadData();
      if (newTpl?.id) selectTemplate(newTpl.id);
    } catch (err) {
      toast.error(`Create failed: ${err.message}`);
    }
  }

  async function handleDuplicate() {
    if (!selectedTemplate) return;
    try {
      const result = await api.create({
        name: `${selectedTemplate.name} (copy)`,
        rules: { ...editingRules },
        complexity_overrides: { ...editingOverrides },
      });
      const newTpl = result?.id ? result : result?.data || result;
      toast.success('Template duplicated');
      await loadData();
      if (newTpl?.id) selectTemplate(newTpl.id);
    } catch (err) {
      toast.error(`Duplicate failed: ${err.message}`);
    }
  }

  async function handleSave() {
    if (!selectedTemplate || selectedTemplate.preset) return;
    try {
      await api.update(selectedId, {
        name: editingName,
        rules: editingRules,
        complexity_overrides: editingOverrides,
      });
      toast.success('Template saved');
      setHasChanges(false);
      await loadData();
    } catch (err) {
      toast.error(`Save failed: ${err.message}`);
    }
  }

  async function handleActivate() {
    if (!selectedTemplate) return;
    try {
      const isCurrentlyActive = activeTemplateId === selectedId;
      if (isCurrentlyActive) {
        // Deactivate — revert to hardcoded routing
        await api.setActive({ template_id: null });
        setActiveTemplateId(null);
        toast.success('Template deactivated — using built-in routing');
      } else {
        await api.setActive({ template_id: selectedId });
        setActiveTemplateId(selectedId);
        toast.success(`Activated template '${selectedTemplate.name}' for routing`);
      }
    } catch (err) {
      toast.error(`Activate failed: ${err.message}`);
    }
  }

  async function handleDelete() {
    if (!selectedTemplate || selectedTemplate.preset) return;
    try {
      await api.remove(selectedId);
      toast.success('Template deleted');
      await loadData();
    } catch (err) {
      toast.error(`Delete failed: ${err.message}`);
    }
  }

  // ─── Render ─────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-slate-400">Loading routing templates...</p>
      </div>
    );
  }

  const activeTemplateName = activeTemplateId
    ? templates.find((t) => t.id === activeTemplateId)?.name
    : null;

  return (
    <div className="space-y-4">
      {/* Active Status */}
      <div className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border ${
        activeTemplateName
          ? 'bg-green-500/10 border-green-500/30'
          : 'bg-slate-800/50 border-slate-700/50'
      }`}>
        <span className={`w-2.5 h-2.5 rounded-full ${activeTemplateName ? 'bg-green-400 animate-pulse' : 'bg-slate-500'}`} />
        <span className="text-sm text-slate-300">
          {activeTemplateName
            ? <>Routing via template: <span className="font-medium text-green-300">{activeTemplateName}</span></>
            : 'No template active — using built-in routing logic'
          }
        </span>
      </div>

      {/* Template Selector Bar */}
      <div className="glass-card p-4">
        <div className="flex items-center gap-3 flex-wrap">
          <label className="text-sm text-slate-400 shrink-0">Template:</label>
          <select
            value={selectedId || ''}
            onChange={(e) => selectTemplate(e.target.value)}
            className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500 min-w-[200px]"
          >
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}{t.preset ? ' (preset)' : ''}
              </option>
            ))}
          </select>

          <div className="flex items-center gap-2 ml-auto">
            <button
              onClick={handleActivate}
              disabled={!selectedTemplate}
              className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
                activeTemplateId === selectedId
                  ? 'bg-green-600/30 border border-green-500/50 text-green-300 hover:bg-red-600/20 hover:border-red-500/30 hover:text-red-300'
                  : 'bg-cyan-600/20 border border-cyan-500/30 text-cyan-300 hover:bg-cyan-600/40'
              } disabled:opacity-40 disabled:cursor-not-allowed`}
            >
              {activeTemplateId === selectedId ? 'Deactivate' : 'Activate'}
            </button>
            <span className="w-px h-5 bg-slate-700" />
            <button
              onClick={handleNew}
              className="px-3 py-1.5 text-sm bg-emerald-600/20 border border-emerald-500/30 text-emerald-300 rounded-lg hover:bg-emerald-600/40 transition-colors"
            >
              New
            </button>
            <button
              onClick={handleDuplicate}
              disabled={!selectedTemplate}
              className="px-3 py-1.5 text-sm bg-blue-600/20 border border-blue-500/30 text-blue-300 rounded-lg hover:bg-blue-600/40 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Duplicate
            </button>
            <button
              onClick={handleSave}
              disabled={!selectedTemplate || selectedTemplate.preset || !hasChanges}
              className="px-3 py-1.5 text-sm bg-indigo-600/20 border border-indigo-500/30 text-indigo-300 rounded-lg hover:bg-indigo-600/40 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Save
            </button>
            <button
              onClick={handleDelete}
              disabled={!selectedTemplate || selectedTemplate.preset}
              className="px-3 py-1.5 text-sm bg-red-600/20 border border-red-500/30 text-red-300 rounded-lg hover:bg-red-600/40 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Delete
            </button>
          </div>
        </div>
        {selectedTemplate?.preset && (
          <p className="text-xs text-slate-500 mt-2">
            Preset templates are read-only. Duplicate to create an editable copy.
          </p>
        )}
        {selectedTemplate && !selectedTemplate.preset && (
          <div className="flex items-center gap-3 mt-3 pt-3 border-t border-slate-700/50">
            <label className="text-sm text-slate-400 shrink-0">Name:</label>
            <input
              type="text"
              value={editingName}
              onChange={(e) => { setEditingName(e.target.value); setHasChanges(true); }}
              className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500 flex-1"
              placeholder="Template name"
              maxLength={100}
            />
          </div>
        )}
      </div>

      {/* Category Mapping Table */}
      <div className="glass-card p-4">
        <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-3">
          Category Routing Rules
        </h3>
        {categories.length === 0 ? (
          <p className="text-slate-500 text-sm">No categories available.</p>
        ) : (
          <div className="space-y-1">
            {categories.map((cat) => {
              const isExpanded = expandedRows.has(cat.key);
              const catOverrides = editingOverrides[cat.key] || {};

              return (
                <div key={cat.key} className="border border-slate-700/50 rounded-lg overflow-hidden">
                  {/* Main row */}
                  <div className="flex items-center gap-3 px-4 py-2.5 bg-slate-800/30 hover:bg-slate-800/60 transition-colors">
                    <button
                      onClick={() => toggleExpand(cat.key)}
                      className="text-slate-500 hover:text-white transition-colors text-xs w-4 text-center"
                      title={isExpanded ? 'Collapse complexity overrides' : 'Expand complexity overrides'}
                    >
                      {isExpanded ? '\u25BC' : '\u25B6'}
                    </button>
                    <div className="flex-1 min-w-0">
                      <span className="text-sm text-white font-medium capitalize">
                        {cat.displayName || cat.key}
                      </span>
                      {cat.keywords && (
                        <span className="text-[11px] text-slate-500 ml-2">
                          {cat.keywords}
                        </span>
                      )}
                    </div>
                    <ProviderSelect
                      value={editingRules[cat.key] || 'ollama'}
                      onChange={(val) => setRule(cat.key, val)}
                    />
                  </div>

                  {/* Complexity overrides */}
                  {isExpanded && (
                    <div className="border-t border-slate-700/30 bg-slate-900/30 px-4 py-2 space-y-2">
                      <p className="text-[11px] text-slate-500 mb-1">Complexity overrides:</p>
                      {['simple', 'normal', 'complex'].map((complexity) => (
                        <div key={complexity} className="flex items-center gap-3 pl-7">
                          <span className="text-xs text-slate-400 w-16 capitalize">{complexity}</span>
                          <ProviderSelect
                            value={catOverrides[complexity] || '__inherit__'}
                            onChange={(val) => setOverride(cat.key, complexity, val)}
                            allowInherit
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Unsaved Changes Banner */}
      {hasChanges && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 flex items-center justify-between">
          <span className="text-sm text-amber-300">You have unsaved changes.</span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                if (selectedTemplate) {
                  setEditingRules({ ...selectedTemplate.rules });
                  setEditingOverrides({ ...(selectedTemplate.complexity_overrides || {}) });
                  setHasChanges(false);
                }
              }}
              className="px-3 py-1 text-xs text-slate-300 hover:text-white transition-colors"
            >
              Discard
            </button>
            <button
              onClick={handleSave}
              disabled={selectedTemplate?.preset}
              className="px-3 py-1 text-xs bg-amber-600 hover:bg-amber-500 text-white rounded transition-colors disabled:opacity-40"
            >
              Save Changes
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
