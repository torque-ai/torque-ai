# Dashboard Fallback Chain Editor Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add fallback chain display and editing to the Routing Templates dashboard page so users can see, create, and modify provider+model fallback chains.

**Architecture:** Extend `RoutingTemplates.jsx` with 3 new inline components: `ModelInput` (text input with suggestion dropdown), `ChainSummary` (inline chain preview), and `ChainEditor` (expanded chain editing panel). Auto-detect string vs array format per category — legacy single-provider rules keep existing dropdown, chain arrays get the new UI.

**Tech Stack:** React (Vite), Tailwind CSS

**Spec:** `docs/superpowers/specs/2026-03-18-dashboard-chain-editor-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `dashboard/src/views/RoutingTemplates.jsx` | Modify — add MODEL_SUGGESTIONS, ModelInput, ChainSummary, ChainEditor components; update category row rendering to auto-detect format; add chain mutation functions |

Single file, following the existing pattern (ProviderSelect is already inline at line 31).

---

### Task 1: Add MODEL_SUGGESTIONS and ModelInput Component

**Files:**
- Modify: `dashboard/src/views/RoutingTemplates.jsx`

- [x] **Step 1: Add MODEL_SUGGESTIONS constant**

Add after `KNOWN_PROVIDERS` (line 27), before the ProviderSelect component:

```jsx
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
```

- [x] **Step 2: Add ModelInput component**

Add after ProviderSelect (line 50):

```jsx
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
```

- [x] **Step 3: Verify build**

Run: `cd /path/to/torque/dashboard && npm run build`
Expected: builds without errors.

- [x] **Step 4: Commit**

```bash
cd /path/to/torque
git add dashboard/src/views/RoutingTemplates.jsx
git commit -m "feat(dashboard): add MODEL_SUGGESTIONS and ModelInput component for chain editing"
```

---

### Task 2: Add ChainSummary and ChainEditor Components

**Files:**
- Modify: `dashboard/src/views/RoutingTemplates.jsx`

- [x] **Step 1: Add ChainSummary component**

Add after ModelInput:

```jsx
function ChainSummary({ chain }) {
  if (!Array.isArray(chain) || chain.length === 0) return null;
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      {chain.map((entry, i) => (
        <span key={i} className="flex items-center gap-1 shrink-0">
          {i > 0 && <span className="text-slate-600 text-xs">→</span>}
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{ backgroundColor: PROVIDER_COLORS[entry.provider] || '#6b7280' }}
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
```

- [x] **Step 2: Add ChainEditor component**

Add after ChainSummary:

```jsx
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
```

- [x] **Step 3: Verify build**

Run: `cd /path/to/torque/dashboard && npm run build`
Expected: builds without errors.

- [x] **Step 4: Commit**

```bash
cd /path/to/torque
git add dashboard/src/views/RoutingTemplates.jsx
git commit -m "feat(dashboard): add ChainSummary and ChainEditor components"
```

---

### Task 3: Update Category Row Rendering

Replace the main category row to auto-detect string vs chain format.

**Files:**
- Modify: `dashboard/src/views/RoutingTemplates.jsx`

- [ ] **Step 1: Add chain mutation functions**

Add after the existing `toggleExpand` function (line 156):

```jsx
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
```

- [ ] **Step 2: Replace the category main row rendering**

Replace lines 385-388 (the `<ProviderSelect>` in the main row) with auto-detecting logic:

```jsx
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
```

- [ ] **Step 3: Replace the expanded panel rendering**

Replace lines 392-405 (the complexity overrides section) with a full expanded panel that includes chain editor when applicable:

```jsx
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
```

- [ ] **Step 4: Build and verify**

Run: `cd /path/to/torque/dashboard && npm run build`
Expected: builds without errors.

- [ ] **Step 5: Visual verification**

Open `http://localhost:3456` in a browser. Navigate to Routing Templates:
- Select "Free Agentic" preset — should show chain summaries (provider → provider → provider) for each category
- Select "System Default" — should show single provider dropdowns with [+ Chain] buttons
- Expand a category on Free Agentic — should show full chain editor with provider dropdowns, model inputs, reorder buttons
- Select a non-preset template — verify [+ Chain] converts to chain editor

- [ ] **Step 6: Commit**

```bash
cd /path/to/torque
git add dashboard/src/views/RoutingTemplates.jsx
git commit -m "feat(dashboard): auto-detecting chain editor in routing templates — display and edit fallback chains"
```

---

### Task 4: Build, Push, and Restart

- [ ] **Step 1: Full dashboard build**

Run: `cd /path/to/torque/dashboard && npm run build`

- [ ] **Step 2: Push**

```bash
cd /path/to/torque
git push
```

- [ ] **Step 3: Restart TORQUE**

```bash
bash /path/to/torque/stop-torque.sh
sleep 2
TORQUE_DATA_DIR="/path/to/torque-data" nohup bash -c 'export TORQUE_DATA_DIR="/path/to/torque-data" && tail -f /dev/null | node /path/to/torque/server/index.js' > /dev/null 2>&1 &
```
