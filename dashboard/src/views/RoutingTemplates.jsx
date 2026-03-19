import { useState, useEffect, useCallback } from 'react';
import { routingTemplates as api } from '../api';
import { useToast } from '../components/Toast';
import { PROVIDER_HEX_COLORS } from '../constants';
import LoadingSkeleton from '../components/LoadingSkeleton';

// ─── Provider Colors (hex for colored dots) ─────────────────────────────────

const KNOWN_PROVIDERS = [
  'ollama', 'hashline-ollama', 'aider-ollama', 'codex', 'claude-cli',
  'anthropic', 'deepinfra', 'hyperbolic', 'groq', 'cerebras',
  'google-ai', 'openrouter', 'ollama-cloud',
];

const MODEL_SUGGESTIONS = {
  cerebras: ['qwen-3-235b-a22b-instruct-2507'],
  groq: ['qwen/qwen3-32b', 'openai/gpt-oss-120b', 'llama-3.3-70b-versatile',
         'moonshotai/kimi-k2-instruct', 'meta-llama/llama-4-scout-17b-16e-instruct',
         'llama-3.1-8b-instant'],
  'google-ai': ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'],
  'ollama-cloud': ['kimi-k2:1t', 'mistral-large-3:675b', 'qwen3-coder:480b',
                   'deepseek-v3.2', 'devstral-2:123b', 'gpt-oss:120b'],
  openrouter: ['nvidia/nemotron-3-nano-30b-a3b:free', 'google/gemma-3-27b-it:free'],
  ollama: ['qwen2.5-coder:32b', 'codestral:22b'],
  'hashline-ollama': ['qwen2.5-coder:32b'],
  'aider-ollama': ['qwen2.5-coder:32b'],
};

const PROVIDER_DEFAULT_MODELS = {
  cerebras: 'qwen-3-235b-a22b-instruct-2507',
  groq: 'qwen/qwen3-32b',
  'google-ai': 'gemini-2.5-flash',
  'ollama-cloud': 'kimi-k2:1t',
  openrouter: 'nvidia/nemotron-3-nano-30b-a3b:free',
  ollama: 'qwen2.5-coder:32b',
};

// ─── Provider Dropdown ──────────────────────────────────────────────────────

function ProviderSelect({ value, onChange, allowInherit = false }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className="w-2.5 h-2.5 rounded-full shrink-0"
        style={{ backgroundColor: (!allowInherit || value !== '__inherit__') ? (PROVIDER_HEX_COLORS[value] || '#6b7280') : '#475569' }}
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

// ─── Model Input with Suggestions ───────────────────────────────────────────

function ModelInput({ provider, value, onChange }) {
  const [open, setOpen] = useState(false);
  const suggestions = MODEL_SUGGESTIONS[provider] || [];
  const filtered = value
    ? suggestions.filter((s) => s.toLowerCase().includes(value.toLowerCase()))
    : suggestions;
  const placeholder = PROVIDER_DEFAULT_MODELS[provider] || 'default';

  return (
    <div className="relative">
      <input
        type="text"
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder}
        className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-blue-500 w-[220px] placeholder:text-slate-600"
      />
      {open && filtered.length > 0 && (
        <div className="absolute z-20 top-full left-0 mt-1 bg-slate-800 border border-slate-600 rounded shadow-lg max-h-40 overflow-y-auto w-full">
          {filtered.map((s) => (
            <button
              key={s}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); onChange(s); setOpen(false); }}
              className="block w-full text-left px-2 py-1 text-sm text-slate-300 hover:bg-slate-700 hover:text-white"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Chain Summary (inline read-only preview) ────────────────────────────────

function ChainSummary({ chain }) {
  if (!Array.isArray(chain) || chain.length === 0) return null;
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      {chain.map((entry, i) => (
        <span key={i} className="flex items-center gap-1 shrink-0">
          {i > 0 && <span className="text-slate-600 text-xs">→</span>}
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{ backgroundColor: PROVIDER_HEX_COLORS[entry.provider] || '#6b7280' }}
          />
          <span className="text-xs text-slate-300">{entry.provider}</span>
        </span>
      ))}
      <span className="text-[10px] text-slate-500 bg-slate-700/50 px-1.5 py-0.5 rounded-full ml-1">
        {chain.length}
      </span>
    </div>
  );
}

// ─── Chain Editor (expanded chain editing panel) ─────────────────────────────

function ChainEditor({ chain, onChange, readOnly = false }) {
  const maxEntries = 7;

  function updateEntry(index, field, value) {
    const next = chain.map((e, i) => i === index ? { ...e, [field]: value } : e);
    // Clear model when provider changes
    if (field === 'provider') next[index] = { provider: value };
    onChange(next);
  }

  function addEntry() {
    if (chain.length >= maxEntries) return;
    // Pick first provider not already in chain
    const used = new Set(chain.map((e) => e.provider));
    const next = KNOWN_PROVIDERS.find((p) => !used.has(p)) || 'ollama';
    onChange([...chain, { provider: next }]);
  }

  function removeEntry(index) {
    if (chain.length <= 1) return;
    onChange(chain.filter((_, i) => i !== index));
  }

  function moveEntry(index, direction) {
    const target = index + direction;
    if (target < 0 || target >= chain.length) return;
    const next = [...chain];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  return (
    <div className="space-y-1.5">
      {chain.map((entry, i) => (
        <div key={i} className="flex items-center gap-2 pl-7">
          <span className="text-[11px] text-slate-500 w-4 text-right shrink-0">{i + 1}.</span>
          <ProviderSelect
            value={entry.provider}
            onChange={(val) => updateEntry(i, 'provider', val)}
          />
          <span className="text-slate-600 text-xs">/</span>
          <ModelInput
            provider={entry.provider}
            value={entry.model || ''}
            onChange={(val) => updateEntry(i, 'model', val || undefined)}
          />
          {!readOnly && (
            <div className="flex items-center gap-0.5 ml-1">
              <button
                onClick={() => moveEntry(i, -1)}
                disabled={i === 0}
                className="text-slate-500 hover:text-white disabled:opacity-20 text-xs px-1"
                title="Move up"
              >↑</button>
              <button
                onClick={() => moveEntry(i, 1)}
                disabled={i === chain.length - 1}
                className="text-slate-500 hover:text-white disabled:opacity-20 text-xs px-1"
                title="Move down"
              >↓</button>
              <button
                onClick={() => removeEntry(i)}
                disabled={chain.length <= 1}
                className="text-red-400/60 hover:text-red-400 disabled:opacity-20 text-xs px-1 ml-1"
                title="Remove"
              >✕</button>
            </div>
          )}
        </div>
      ))}
      {!readOnly && chain.length < maxEntries && (
        <button
          onClick={addEntry}
          className="text-xs text-cyan-400/70 hover:text-cyan-400 pl-11 py-1 transition-colors"
        >
          + Add fallback
        </button>
      )}
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
  const [editingName, setEditingName] = useState('');
  const [expandedRows, setExpandedRows] = useState(new Set());
  const [hasChanges, setHasChanges] = useState(false);
  const [activeTemplateId, setActiveTemplateId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
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
      setLoadError(err.message);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // ─── Helpers ────────────────────────────────────────────────────────

  const selectedTemplate = templates.find((t) => t.id === selectedId);

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

  function convertToChain(categoryKey) {
    const current = editingRules[categoryKey] || 'ollama';
    const chain = typeof current === 'string' ? [{ provider: current }] : current;
    setEditingRules((prev) => ({ ...prev, [categoryKey]: chain }));
    setHasChanges(true);
  }

  function updateChain(categoryKey, newChain) {
    setEditingRules((prev) => ({ ...prev, [categoryKey]: newChain }));
    setHasChanges(true);
  }

  function updateOverrideChain(categoryKey, complexity, newChain) {
    setEditingOverrides((prev) => {
      const catOverrides = { ...(prev[categoryKey] || {}) };
      catOverrides[complexity] = newChain;
      return { ...prev, [categoryKey]: catOverrides };
    });
    setHasChanges(true);
  }

  function convertOverrideToChain(categoryKey, complexity) {
    const current = editingOverrides[categoryKey]?.[complexity] || '__inherit__';
    if (current === '__inherit__') {
      // Start with a single entry using the main rule's first provider
      const mainRule = editingRules[categoryKey];
      const provider = Array.isArray(mainRule) ? mainRule[0]?.provider : (mainRule || 'ollama');
      updateOverrideChain(categoryKey, complexity, [{ provider }]);
    } else {
      updateOverrideChain(categoryKey, complexity, [{ provider: current }]);
    }
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
      <div className="py-12 px-6">
        <LoadingSkeleton lines={5} />
      </div>
    );
  }

  const activeTemplateName = activeTemplateId
    ? templates.find((t) => t.id === activeTemplateId)?.name
    : null;

  return (
    <div className="space-y-4">
      {loadError && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-red-300 text-sm">{loadError}</div>
      )}
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
                    {/* Rule display — auto-detect string vs chain */}
                    {Array.isArray(editingRules[cat.key]) ? (
                      <ChainSummary chain={editingRules[cat.key]} />
                    ) : (
                      <div className="flex items-center gap-2">
                        <ProviderSelect
                          value={editingRules[cat.key] || 'ollama'}
                          onChange={(val) => setRule(cat.key, val)}
                        />
                        {!selectedTemplate?.preset && (
                          <button
                            onClick={() => convertToChain(cat.key)}
                            className="text-[10px] text-cyan-400/50 hover:text-cyan-400 border border-cyan-500/20 hover:border-cyan-500/40 rounded px-1.5 py-0.5 transition-colors"
                            title="Convert to fallback chain"
                          >
                            + Chain
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Expanded panel */}
                  {isExpanded && (
                    <div className="border-t border-slate-700/30 bg-slate-900/30 px-4 py-2 space-y-3">
                      {/* Chain editor (when rule is an array) */}
                      {Array.isArray(editingRules[cat.key]) && (
                        <div>
                          <p className="text-[11px] text-slate-500 mb-1.5">Fallback chain:</p>
                          <ChainEditor
                            chain={editingRules[cat.key]}
                            onChange={(c) => updateChain(cat.key, c)}
                            readOnly={!!selectedTemplate?.preset}
                          />
                        </div>
                      )}

                      {/* Complexity overrides */}
                      <div>
                        <p className="text-[11px] text-slate-500 mb-1">Complexity overrides:</p>
                        {['simple', 'normal', 'complex'].map((complexity) => {
                          const overrideVal = catOverrides[complexity];
                          const isChainOverride = Array.isArray(overrideVal);

                          return (
                            <div key={complexity} className="py-1">
                              <div className="flex items-center gap-3 pl-7">
                                <span className="text-xs text-slate-400 w-16 capitalize">{complexity}</span>
                                {isChainOverride ? (
                                  <ChainSummary chain={overrideVal} />
                                ) : (
                                  <div className="flex items-center gap-2">
                                    <ProviderSelect
                                      value={overrideVal || '__inherit__'}
                                      onChange={(val) => setOverride(cat.key, complexity, val)}
                                      allowInherit
                                    />
                                    {!selectedTemplate?.preset && overrideVal && overrideVal !== '__inherit__' && (
                                      <button
                                        onClick={() => convertOverrideToChain(cat.key, complexity)}
                                        className="text-[10px] text-cyan-400/50 hover:text-cyan-400 border border-cyan-500/20 rounded px-1.5 py-0.5"
                                        title="Convert to chain"
                                      >
                                        + Chain
                                      </button>
                                    )}
                                  </div>
                                )}
                              </div>
                              {isChainOverride && expandedRows.has(cat.key) && (
                                <div className="mt-1">
                                  <ChainEditor
                                    chain={overrideVal}
                                    onChange={(c) => updateOverrideChain(cat.key, complexity, c)}
                                    readOnly={!!selectedTemplate?.preset}
                                  />
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
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
