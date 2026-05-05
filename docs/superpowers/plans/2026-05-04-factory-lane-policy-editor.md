# Factory Lane Policy Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the read-only `FactoryLanePolicyPanel` in
`dashboard/src/views/ProjectSettings.jsx` fully editable so operators can
adjust per-kind providers, the expected provider, the enforce-handoffs
toggle, and the allowed/fallback provider lists from the dashboard with
inline auto-save.

**Architecture:** Replace `FactoryLanePolicyPanel` in place with an
editable component plus a new in-file `MultiSelectDropdown` helper.
The parent `ProjectSettings` view fetches the live provider list from
`/api/v2/providers`, captures the project's current `trust_level` from
the factory project record, and exposes a save callback that fires
`PUT /api/v2/factory/projects/{id}/trust` with
`{trust_level, config: {provider_lane_policy}}`. Saves are optimistic,
debounce-and-collapse on overlap, and revert on error.

**Tech Stack:** React 19 + Tailwind v4 (dashboard), Vitest 4 +
testing-library + jsdom (tests), existing `requestV2` helper +
`providers.list()` API client + `useToast` hook.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `dashboard/src/views/ProjectSettings.jsx` | Modify | Replace `FactoryLanePolicyPanel` (lines 70-159), add `MultiSelectDropdown` helper near other helper components, add `providers` and `trustLevel` state to the parent, wire `onLanePolicyChange` callback that fires the PUT, loosen the `lanePolicy ? <Panel /> : null` render guard at line 823. |
| `dashboard/src/views/ProjectSettings.test.jsx` | Modify | Append a new `describe('FactoryLanePolicyPanel', ...)` block with the seven test cases below. The file already exists with the existing-pattern fetch mocks (`createResponse`, `globalThis.fetch = vi.fn(...)`, `renderWithProviders`). Mirror that style. |

No new files. The panel grows from ~90 lines to ~250 lines and stays
self-contained inside the existing view file. No server-side changes.

---

## Background the implementer must read first

Open these and skim them once before starting:

1. **`server/factory/provider-lane-policy.js`** — the policy normalizer.
   Notable fact: the policy stored in
   `factory_projects.config_json.provider_lane_policy` is
   `{expected_provider: string|null, allowed_providers: string[],
   allowed_fallback_providers: string[], by_kind: Record<string,string>,
   enforce_handoffs: boolean}`.
2. **`server/handlers/factory-handlers.js:1221-1241`** — the
   `set_factory_trust_level` handler. Crucially, line 1223 sets
   `updates.trust_level = args.trust_level` unconditionally, and the
   downstream `updateProject` validator
   (`server/db/factory/health.js:159`) throws `Invalid trust_level:
   undefined` if it is not provided. The schema in
   `server/tool-defs/factory-defs.js:92` lists
   `required: ['project', 'trust_level']`. **You must echo the
   project's current `trust_level` on every save.**
3. **`dashboard/src/views/ProjectSettings.jsx:444-459`** — where the
   factory project record is loaded. The match record exposes
   `trust_level`. You will capture it alongside the existing
   `setFactoryProjectId` / `setLanePolicy` calls.
4. **`dashboard/src/api.js:240-251`** — `providers.list()` already
   exists and returns an array of provider objects. Each object has at
   least `name` (a string like `"codex"` or `"ollama"`).
5. **The design spec:**
   `docs/superpowers/specs/2026-05-04-factory-lane-policy-editor-design.md`.

---

### Task 1: Capture trust_level + fetch provider list

**Files:**
- Modify: `dashboard/src/views/ProjectSettings.jsx` (parent state — add `trustLevel`, `providers`; wire fetch and capture site)
- Modify: `dashboard/src/views/ProjectSettings.test.jsx` (new test in the existing `describe('ProjectSettings', ...)` block)

The panel is still read-only after this task. We are only laying the
plumbing the editor needs.

- [ ] **Step 1: Write the failing test**

Append to `dashboard/src/views/ProjectSettings.test.jsx`, inside the
existing `describe('ProjectSettings', () => { ... })` block:

```jsx
it('fetches provider list and captures factory trust_level on load', async () => {
  let providersFetched = false;
  let factoryFetched = false;

  globalThis.fetch = vi.fn((url) => {
    if (url === '/api/v2/tasks/list-projects') {
      return createResponse({ data: [{ name: 'alpha', task_count: 1, last_active: '2026-01-15T10:30:00Z' }] });
    }
    if (url === '/api/v2/tasks/list-project-configs') {
      return createResponse({ data: [{ project: 'alpha' }] });
    }
    if (url === '/api/v2/project-config?project=alpha') {
      return createResponse({
        data: {
          default_provider: 'ollama', default_model: 'qwen3-coder:30b',
          verify_command: '', routing_template_id: null,
          auto_fix_enabled: 0, default_timeout: 30,
        },
      });
    }
    if (url === '/api/v2/routing/templates') return createResponse({ data: [] });
    if (url === '/api/v2/provider-scores') return createResponse([]);
    if (url === '/api/v2/cost-budgets') return createResponse([]);
    if (url === '/api/v2/factory/projects') {
      factoryFetched = true;
      return createResponse({
        data: {
          projects: [{
            id: 'fp-1', name: 'alpha', trust_level: 'guided',
            config_json: JSON.stringify({
              provider_lane_policy: {
                expected_provider: 'ollama',
                allowed_providers: ['ollama'],
                allowed_fallback_providers: [],
                by_kind: { architect_cycle: 'codex' },
                enforce_handoffs: true,
              },
            }),
          }],
        },
      });
    }
    if (url === '/api/v2/providers') {
      providersFetched = true;
      return createResponse({
        data: { items: [{ name: 'ollama' }, { name: 'codex' }, { name: 'codex-spark' }] },
      });
    }
    throw new Error(`Unhandled fetch: ${url}`);
  });

  renderWithProviders(<ProjectSettings />, { route: '/settings?project=alpha' });

  await screen.findByText('Factory Lane Policy');
  await waitFor(() => expect(providersFetched).toBe(true));
  await waitFor(() => expect(factoryFetched).toBe(true));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from the dashboard directory:

```bash
cd dashboard && npx vitest run src/views/ProjectSettings.test.jsx -t "fetches provider list"
```

Expected: FAIL with `Unhandled fetch: /api/v2/providers` (the
component does not fetch providers yet).

- [ ] **Step 3: Add `providers` state + fetch and `trustLevel` state + capture**

In `ProjectSettings.jsx`, near the existing `lanePolicy` /
`factoryProjectId` state declarations (around lines 350-351), add:

```jsx
const [trustLevel, setTrustLevel] = useState('');
const [providers, setProviders] = useState([]);
```

At the top of the file, add `providers as providersApi` to the imports
from `../api`:

```jsx
import { budget as budgetApi, factory as factoryApi, providers as providersApi, requestV2, routingTemplates } from '../api';
```

(The existing import already destructures from `../api`; add the new
binding inline. Avoid renaming if the existing import order differs —
adjust to whatever keeps the line tidy.)

In the existing factory-project resolver
(`ProjectSettings.jsx:444-459`), capture the trust level inside the
`if (match)` branch and clear it on the `else` paths:

```jsx
if (match) {
  setFactoryProjectId(match.id || '');
  setTrustLevel(match.trust_level || '');
  const lane = match.config?.provider_lane_policy
    || (match.config_json ? safeParseJson(match.config_json)?.provider_lane_policy : null);
  setLanePolicy(lane || null);
} else {
  setFactoryProjectId('');
  setTrustLevel('');
  setLanePolicy(null);
}
```

(And mirror the `setTrustLevel('')` reset in the outer `else` branch
that fires when the factory request is rejected.)

Add a one-shot provider list fetch. Place it as a new `useEffect` near
the other mount-time effects (after `loadConfiguredProjects` is set
up — around line 374):

```jsx
useEffect(() => {
  let cancelled = false;
  providersApi.list()
    .then((items) => {
      if (cancelled || !mountedRef.current) return;
      const names = Array.isArray(items)
        ? items.map((p) => (typeof p === 'string' ? p : p?.name)).filter(Boolean)
        : [];
      setProviders(names);
    })
    .catch(() => {
      // Fallback handled in Task 7. For now, leave the list empty;
      // dropdowns built in later tasks will gracefully render no options.
      if (cancelled || !mountedRef.current) return;
      setProviders([]);
    });
  return () => { cancelled = true; };
}, []);
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd dashboard && npx vitest run src/views/ProjectSettings.test.jsx -t "fetches provider list"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/views/ProjectSettings.jsx dashboard/src/views/ProjectSettings.test.jsx
git commit -m "feat(dashboard): plumb provider list and trust_level into ProjectSettings

Adds parent-level state for the live provider list (from
GET /api/v2/providers) and the project's current factory trust_level
(captured from the factory project record). These are prerequisites
for the editable FactoryLanePolicyPanel; no UI behavior changes yet."
```

---

### Task 2: Editable panel scaffolding (no save wiring yet)

**Files:**
- Modify: `dashboard/src/views/ProjectSettings.jsx` (replace `FactoryLanePolicyPanel`, add `MultiSelectDropdown`)
- Modify: `dashboard/src/views/ProjectSettings.test.jsx` (new tests)

After this task, the panel renders editable controls. They update local
React state but do not yet PUT to the server.

- [ ] **Step 1: Write the failing test**

Append a new `describe` block at the bottom of `ProjectSettings.test.jsx`:

```jsx
describe('FactoryLanePolicyPanel — editor controls', () => {
  let originalFetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  function mountWithLanePolicy({ lanePolicy, providers = ['ollama', 'codex', 'codex-spark'] } = {}) {
    globalThis.fetch = vi.fn((url) => {
      if (url === '/api/v2/tasks/list-projects') {
        return createResponse({ data: [{ name: 'alpha', task_count: 1, last_active: '2026-01-15T10:30:00Z' }] });
      }
      if (url === '/api/v2/tasks/list-project-configs') return createResponse({ data: [{ project: 'alpha' }] });
      if (url === '/api/v2/project-config?project=alpha') {
        return createResponse({ data: { default_provider: 'ollama', default_model: '', verify_command: '', routing_template_id: null, auto_fix_enabled: 0, default_timeout: 30 } });
      }
      if (url === '/api/v2/routing/templates') return createResponse({ data: [] });
      if (url === '/api/v2/provider-scores') return createResponse([]);
      if (url === '/api/v2/cost-budgets') return createResponse([]);
      if (url === '/api/v2/factory/projects') {
        return createResponse({
          data: { projects: [{
            id: 'fp-1', name: 'alpha', trust_level: 'guided',
            config_json: JSON.stringify({ provider_lane_policy: lanePolicy }),
          }] },
        });
      }
      if (url === '/api/v2/providers') {
        return createResponse({ data: { items: providers.map((n) => ({ name: n })) } });
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });

    renderWithProviders(<ProjectSettings />, { route: '/settings?project=alpha' });
  }

  it('renders editable per-kind dropdowns with sentinel option', async () => {
    mountWithLanePolicy({
      lanePolicy: {
        expected_provider: 'ollama',
        allowed_providers: ['ollama'],
        allowed_fallback_providers: [],
        by_kind: { architect_cycle: 'codex' },
        enforce_handoffs: true,
      },
    });

    await screen.findByText('Factory Lane Policy');

    // Per-kind row for architect_cycle should be a select with codex selected
    const architectSelect = await screen.findByLabelText('Provider for architect_cycle');
    expect(architectSelect.tagName).toBe('SELECT');
    expect(architectSelect.value).toBe('codex');

    // Sentinel option must exist
    expect(architectSelect.querySelector('option[value=""]')).not.toBeNull();
    expect(architectSelect.querySelector('option[value=""]').textContent).toContain('use default');

    // Real provider options exist
    expect(architectSelect.querySelector('option[value="codex"]')).not.toBeNull();
    expect(architectSelect.querySelector('option[value="ollama"]')).not.toBeNull();

    // A row without a by_kind override (e.g. execute) shows empty value
    const executeSelect = await screen.findByLabelText('Provider for execute');
    expect(executeSelect.value).toBe('');
  });

  it('renders editable expected_provider with — none — sentinel', async () => {
    mountWithLanePolicy({
      lanePolicy: {
        expected_provider: 'ollama',
        allowed_providers: [],
        allowed_fallback_providers: [],
        by_kind: {},
        enforce_handoffs: false,
      },
    });

    await screen.findByText('Factory Lane Policy');
    const expectedSelect = await screen.findByLabelText('Expected provider');
    expect(expectedSelect.tagName).toBe('SELECT');
    expect(expectedSelect.value).toBe('ollama');
    expect(expectedSelect.querySelector('option[value=""]').textContent).toContain('none');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd dashboard && npx vitest run src/views/ProjectSettings.test.jsx -t "FactoryLanePolicyPanel"
```

Expected: FAIL — `Unable to find a label with the text of: Provider for
architect_cycle` (the read-only panel renders text, not labelled
selects).

- [ ] **Step 3: Add `MultiSelectDropdown` helper**

In `ProjectSettings.jsx`, add this component near the existing
`ToggleSwitch` and `FormField` helpers (around line 25). It is used in
Task 4 for `allowed_providers` and `allowed_fallback_providers`. We
introduce it now so the file structure is stable.

```jsx
function MultiSelectDropdown({ label, options, selected, onChange, disabled }) {
  const [open, setOpen] = useState(false);
  const selectedSet = new Set(selected);

  function toggle(value) {
    const next = new Set(selectedSet);
    if (next.has(value)) next.delete(value); else next.add(value);
    onChange(Array.from(next));
  }

  const summary = selected.length === 0
    ? '(none)'
    : selected.length <= 3
      ? selected.join(', ')
      : `${selected.length} selected`;

  return (
    <div className="relative">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-left text-sm text-white focus:outline-none focus:border-blue-500 disabled:opacity-50"
      >
        {summary}
      </button>
      {open ? (
        <div
          role="listbox"
          aria-label={label}
          className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-slate-700 bg-slate-900 p-2 shadow-lg"
        >
          {options.length === 0 ? (
            <div className="px-2 py-1 text-xs text-slate-500">No providers available</div>
          ) : options.map((opt) => (
            <label key={opt} className="flex cursor-pointer items-center gap-2 px-2 py-1 text-sm text-slate-200 hover:bg-slate-800">
              <input
                type="checkbox"
                checked={selectedSet.has(opt)}
                onChange={() => toggle(opt)}
              />
              <span className="font-mono">{opt}</span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Replace `FactoryLanePolicyPanel` with editable version**

Replace the entire `FactoryLanePolicyPanel` body (lines 70-159) with:

```jsx
const FACTORY_KINDS = ['scout', 'architect_cycle', 'plan_generation', 'verify_review', 'execute'];

function FactoryLanePolicyPanel({
  lanePolicy,
  factoryProjectId,
  providers,
  onLanePolicyChange,   // (nextPolicy) => void   — Task 3 wires this
  saveStatus,           // 'idle' | 'saving' | 'saved' | 'error'  — Task 5 wires this
  disabled,
}) {
  const policy = lanePolicy || {
    expected_provider: null,
    allowed_providers: [],
    allowed_fallback_providers: [],
    by_kind: {},
    enforce_handoffs: false,
  };

  const byKind = isObject(policy.by_kind) ? policy.by_kind : {};
  const allowedProviders = Array.isArray(policy.allowed_providers) ? policy.allowed_providers : [];
  const allowedFallback = Array.isArray(policy.allowed_fallback_providers) ? policy.allowed_fallback_providers : [];

  function handleByKindChange(kind, value) {
    const nextByKind = { ...byKind };
    if (!value) {
      delete nextByKind[kind];
    } else {
      nextByKind[kind] = value;
    }
    onLanePolicyChange?.({ ...policy, by_kind: nextByKind });
  }

  function handleExpectedChange(value) {
    onLanePolicyChange?.({ ...policy, expected_provider: value || null });
  }

  function handleEnforceChange(value) {
    onLanePolicyChange?.({ ...policy, enforce_handoffs: Boolean(value) });
  }

  function handleAllowedChange(next) {
    onLanePolicyChange?.({ ...policy, allowed_providers: next });
  }

  function handleFallbackChange(next) {
    onLanePolicyChange?.({ ...policy, allowed_fallback_providers: next });
  }

  return (
    <div className="glass-card p-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-white">Factory Lane Policy</h2>
          <p className="mt-1 text-sm text-slate-500">
            Per-project provider routing. Per-kind overrides shadow the active routing template.
          </p>
        </div>
        <SaveStatusIndicator status={saveStatus} />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 mb-5">
        <FormField label="Expected provider" id="lane-expected">
          <select
            id="lane-expected"
            aria-label="Expected provider"
            disabled={disabled}
            value={policy.expected_provider || ''}
            onChange={(e) => handleExpectedChange(e.target.value)}
            className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 disabled:opacity-50"
          >
            <option value="">— none —</option>
            {providers.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </FormField>

        <FormField label="Enforce handoffs" id="lane-enforce">
          <ToggleSwitch
            checked={Boolean(policy.enforce_handoffs)}
            onChange={handleEnforceChange}
            label="Enforce handoffs"
          />
        </FormField>

        <FormField label="Allowed providers" id="lane-allowed">
          <MultiSelectDropdown
            label="Allowed providers"
            options={providers}
            selected={allowedProviders}
            onChange={handleAllowedChange}
            disabled={disabled}
          />
        </FormField>

        <FormField label="Allowed fallback providers" id="lane-fallback">
          <MultiSelectDropdown
            label="Allowed fallback providers"
            options={providers}
            selected={allowedFallback}
            onChange={handleFallbackChange}
            disabled={disabled}
          />
        </FormField>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-white mb-2">Per-kind overrides</h3>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700 text-left text-xs uppercase tracking-wider text-slate-500">
                <th scope="col" className="px-3 py-2 font-medium">Task kind</th>
                <th scope="col" className="px-3 py-2 font-medium">Provider</th>
                <th scope="col" className="px-3 py-2 font-medium">Source</th>
              </tr>
            </thead>
            <tbody>
              {FACTORY_KINDS.map((kind) => (
                <tr key={kind} className="border-b border-slate-800/80 text-slate-300 last:border-0">
                  <td className="px-3 py-2 font-mono text-slate-200">{kind}</td>
                  <td className="px-3 py-2">
                    <select
                      aria-label={`Provider for ${kind}`}
                      disabled={disabled}
                      value={byKind[kind] || ''}
                      onChange={(e) => handleByKindChange(kind, e.target.value)}
                      className="rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500 disabled:opacity-50"
                    >
                      <option value="">— use default —</option>
                      {providers.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500">
                    {byKind[kind] ? 'Project override (shadows template)' : 'Active routing template'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-slate-500">
          A project override silently bypasses the active routing template for that kind.
          Use it sparingly — for example, to pin plan_generation to a stronger model than execute.
        </p>
        {!factoryProjectId ? (
          <p className="mt-3 text-xs text-amber-400">
            Project not registered with the factory — register it to enable editing.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function SaveStatusIndicator({ status }) {
  if (status === 'saving') return <span className="text-xs text-slate-400">Saving…</span>;
  if (status === 'saved') return <span className="text-xs text-green-400">Saved ✓</span>;
  if (status === 'error') return <span className="text-xs text-red-400">Save failed — retry</span>;
  return null;
}
```

Update the render site at line 823 to pass the new props and render
even when `lanePolicy === null` as long as the project itself is loaded
(but only edit-enable when `factoryProjectId` is set):

```jsx
{factoryProjectId || lanePolicy ? (
  <FactoryLanePolicyPanel
    lanePolicy={lanePolicy}
    factoryProjectId={factoryProjectId}
    providers={providers}
    onLanePolicyChange={() => {}}     // wired in Task 3
    saveStatus="idle"                 // wired in Task 5
    disabled={!factoryProjectId}
  />
) : null}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd dashboard && npx vitest run src/views/ProjectSettings.test.jsx -t "FactoryLanePolicyPanel"
```

Expected: PASS for both new cases.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/views/ProjectSettings.jsx dashboard/src/views/ProjectSettings.test.jsx
git commit -m "feat(dashboard): editable controls for FactoryLanePolicyPanel

Replaces the read-only panel body with selects + multi-select chips +
toggle. No save wiring yet; controls update local state via
onLanePolicyChange (a no-op stub here, wired in the next task)."
```

---

### Task 3: Wire optimistic save with full-policy PUT

**Files:**
- Modify: `dashboard/src/views/ProjectSettings.jsx` (add `onLanePolicyChange` callback in parent, fire `PUT /trust`)
- Modify: `dashboard/src/views/ProjectSettings.test.jsx` (new tests)

After this task, every change saves immediately. Save status is still
hardcoded `idle`; status indicator is wired in Task 5.

- [ ] **Step 1: Write the failing test**

Append to the `describe('FactoryLanePolicyPanel — editor controls', ...)`
block:

```jsx
function captureSaveBody() {
  let posted = null;
  const baseFetch = globalThis.fetch;
  globalThis.fetch = vi.fn((url, options = {}) => {
    if (url === '/api/v2/factory/projects/fp-1/trust' && String(options.method).toUpperCase() === 'PUT') {
      posted = JSON.parse(options.body);
      return createResponse({ data: { ok: true } });
    }
    return baseFetch(url, options);
  });
  return () => posted;
}

it('saves a per-kind dropdown change as a full-policy PUT', async () => {
  mountWithLanePolicy({
    lanePolicy: {
      expected_provider: 'ollama',
      allowed_providers: ['ollama'],
      allowed_fallback_providers: [],
      by_kind: { architect_cycle: 'codex' },
      enforce_handoffs: true,
    },
  });
  await screen.findByText('Factory Lane Policy');
  const getPosted = captureSaveBody();

  fireEvent.change(screen.getByLabelText('Provider for plan_generation'), { target: { value: 'codex' } });

  await waitFor(() => expect(getPosted()).not.toBeNull());

  expect(getPosted()).toEqual({
    trust_level: 'guided',
    config: {
      provider_lane_policy: {
        expected_provider: 'ollama',
        allowed_providers: ['ollama'],
        allowed_fallback_providers: [],
        by_kind: { architect_cycle: 'codex', plan_generation: 'codex' },
        enforce_handoffs: true,
      },
    },
  });
});

it('selecting — use default — deletes the by_kind key', async () => {
  mountWithLanePolicy({
    lanePolicy: {
      expected_provider: 'ollama',
      allowed_providers: ['ollama'],
      allowed_fallback_providers: [],
      by_kind: { architect_cycle: 'codex' },
      enforce_handoffs: false,
    },
  });
  await screen.findByText('Factory Lane Policy');
  const getPosted = captureSaveBody();

  fireEvent.change(screen.getByLabelText('Provider for architect_cycle'), { target: { value: '' } });

  await waitFor(() => expect(getPosted()).not.toBeNull());
  expect(getPosted().config.provider_lane_policy.by_kind).toEqual({});
});

it('toggling allowed_providers checkbox round-trips the PUT', async () => {
  mountWithLanePolicy({
    lanePolicy: {
      expected_provider: 'ollama',
      allowed_providers: ['ollama'],
      allowed_fallback_providers: [],
      by_kind: {},
      enforce_handoffs: false,
    },
  });
  await screen.findByText('Factory Lane Policy');
  const getPosted = captureSaveBody();

  // Open the multi-select
  fireEvent.click(screen.getAllByLabelText('Allowed providers')[0]); // button

  // Click the codex checkbox inside the popped listbox
  const listbox = await screen.findByRole('listbox', { name: 'Allowed providers' });
  const codexBox = listbox.querySelector('input[type="checkbox"][value="codex"]')
    ?? Array.from(listbox.querySelectorAll('label'))
       .find((l) => l.textContent.includes('codex'))
       .querySelector('input[type="checkbox"]');
  fireEvent.click(codexBox);

  await waitFor(() => expect(getPosted()).not.toBeNull());
  expect(getPosted().config.provider_lane_policy.allowed_providers).toEqual(['ollama', 'codex']);
});

it('reverts optimistic state when the PUT fails', async () => {
  mountWithLanePolicy({
    lanePolicy: {
      expected_provider: 'ollama',
      allowed_providers: ['ollama'],
      allowed_fallback_providers: [],
      by_kind: {},
      enforce_handoffs: false,
    },
  });
  await screen.findByText('Factory Lane Policy');

  const baseFetch = globalThis.fetch;
  globalThis.fetch = vi.fn((url, options = {}) => {
    if (url === '/api/v2/factory/projects/fp-1/trust' && String(options.method).toUpperCase() === 'PUT') {
      return createResponse({ error: { message: 'boom' } }, { status: 500 });
    }
    return baseFetch(url, options);
  });

  fireEvent.change(screen.getByLabelText('Expected provider'), { target: { value: 'codex' } });

  // Wait until select reverts to ollama (revert path) — give microtasks time.
  await waitFor(() => {
    expect(screen.getByLabelText('Expected provider').value).toBe('ollama');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd dashboard && npx vitest run src/views/ProjectSettings.test.jsx -t "saves a per-kind|deletes the by_kind|toggling allowed|reverts optimistic"
```

Expected: all four FAIL — no PUT is fired (callback is a no-op).

- [ ] **Step 3: Wire `onLanePolicyChange` in the parent**

In `ProjectSettings.jsx`, add a save callback above the JSX (somewhere
near the other handler functions; pick a spot that keeps related
handlers grouped):

```jsx
const handleLanePolicyChange = useCallback(async (nextPolicy) => {
  if (!factoryProjectId) return;
  const previous = lanePolicy;
  setLanePolicy(nextPolicy);
  try {
    await requestV2(`/factory/projects/${encodeURIComponent(factoryProjectId)}/trust`, {
      method: 'PUT',
      body: JSON.stringify({
        trust_level: trustLevel,
        config: { provider_lane_policy: nextPolicy },
      }),
    });
  } catch (error) {
    // Revert optimistic change.
    setLanePolicy(previous);
    toast.error(`Failed to save lane policy: ${getErrorMessage(error)}`);
  }
}, [factoryProjectId, lanePolicy, trustLevel, toast]);
```

Replace the `onLanePolicyChange={() => {}}` stub at the render site
with `onLanePolicyChange={handleLanePolicyChange}`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd dashboard && npx vitest run src/views/ProjectSettings.test.jsx -t "FactoryLanePolicyPanel"
```

Expected: all six cases (Task 2's two + Task 3's four) PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/views/ProjectSettings.jsx dashboard/src/views/ProjectSettings.test.jsx
git commit -m "feat(dashboard): wire optimistic save for FactoryLanePolicyPanel

Every editor change now fires PUT /api/v2/factory/projects/{id}/trust
with the full provider_lane_policy and the project's current
trust_level (echoed unchanged because set_factory_trust_level requires
it). Failed saves revert the optimistic state and toast the error."
```

---

### Task 4: Save status indicator (Saving / Saved / Error)

**Files:**
- Modify: `dashboard/src/views/ProjectSettings.jsx`
- Modify: `dashboard/src/views/ProjectSettings.test.jsx`

- [ ] **Step 1: Write the failing test**

Append to the same `describe`:

```jsx
it('shows Saving… then Saved ✓ on success', async () => {
  mountWithLanePolicy({
    lanePolicy: {
      expected_provider: 'ollama',
      allowed_providers: [],
      allowed_fallback_providers: [],
      by_kind: {},
      enforce_handoffs: false,
    },
  });
  await screen.findByText('Factory Lane Policy');

  let resolve;
  const baseFetch = globalThis.fetch;
  globalThis.fetch = vi.fn((url, options = {}) => {
    if (url === '/api/v2/factory/projects/fp-1/trust' && String(options.method).toUpperCase() === 'PUT') {
      return new Promise((r) => { resolve = () => r(createResponse({ data: { ok: true } }).then((v) => v)); });
    }
    return baseFetch(url, options);
  });

  fireEvent.change(screen.getByLabelText('Expected provider'), { target: { value: 'codex' } });

  // While in flight, indicator says Saving…
  await screen.findByText('Saving…');

  // Resolve and expect Saved ✓
  resolve();
  await screen.findByText('Saved ✓');
});

it('shows Save failed — retry on error', async () => {
  mountWithLanePolicy({
    lanePolicy: {
      expected_provider: 'ollama',
      allowed_providers: [],
      allowed_fallback_providers: [],
      by_kind: {},
      enforce_handoffs: false,
    },
  });
  await screen.findByText('Factory Lane Policy');

  const baseFetch = globalThis.fetch;
  globalThis.fetch = vi.fn((url, options = {}) => {
    if (url === '/api/v2/factory/projects/fp-1/trust' && String(options.method).toUpperCase() === 'PUT') {
      return createResponse({ error: { message: 'boom' } }, { status: 500 });
    }
    return baseFetch(url, options);
  });

  fireEvent.change(screen.getByLabelText('Expected provider'), { target: { value: 'codex' } });

  await screen.findByText('Save failed — retry');
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd dashboard && npx vitest run src/views/ProjectSettings.test.jsx -t "Saving|Save failed"
```

Expected: FAIL — `Unable to find an element with the text: Saving…`
(status is hardcoded to `idle`).

- [ ] **Step 3: Add `saveStatus` state and update the callback**

Near the other state declarations in `ProjectSettings`, add:

```jsx
const [laneSaveStatus, setLaneSaveStatus] = useState('idle');
const saveStatusClearRef = useRef(null);
```

Update `handleLanePolicyChange` to set status during the save:

```jsx
const handleLanePolicyChange = useCallback(async (nextPolicy) => {
  if (!factoryProjectId) return;
  if (saveStatusClearRef.current) {
    clearTimeout(saveStatusClearRef.current);
    saveStatusClearRef.current = null;
  }
  const previous = lanePolicy;
  setLanePolicy(nextPolicy);
  setLaneSaveStatus('saving');
  try {
    await requestV2(`/factory/projects/${encodeURIComponent(factoryProjectId)}/trust`, {
      method: 'PUT',
      body: JSON.stringify({
        trust_level: trustLevel,
        config: { provider_lane_policy: nextPolicy },
      }),
    });
    setLaneSaveStatus('saved');
    saveStatusClearRef.current = setTimeout(() => {
      saveStatusClearRef.current = null;
      setLaneSaveStatus('idle');
    }, 2000);
  } catch (error) {
    setLanePolicy(previous);
    setLaneSaveStatus('error');
    toast.error(`Failed to save lane policy: ${getErrorMessage(error)}`);
  }
}, [factoryProjectId, lanePolicy, trustLevel, toast]);
```

Add a cleanup effect so the timeout does not fire after unmount:

```jsx
useEffect(() => () => {
  if (saveStatusClearRef.current) {
    clearTimeout(saveStatusClearRef.current);
    saveStatusClearRef.current = null;
  }
}, []);
```

Pass the status to the panel: replace `saveStatus="idle"` at the render
site with `saveStatus={laneSaveStatus}`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd dashboard && npx vitest run src/views/ProjectSettings.test.jsx -t "FactoryLanePolicyPanel"
```

Expected: PASS (now 8 cases in the editor block).

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/views/ProjectSettings.jsx dashboard/src/views/ProjectSettings.test.jsx
git commit -m "feat(dashboard): save status indicator for lane policy editor

Shows Saving…, Saved ✓ (auto-clears after 2s), or Save failed — retry
in the panel header so operators see the result of inline auto-saves
without watching for toasts."
```

---

### Task 5: Concurrency — debounce-and-collapse

**Files:**
- Modify: `dashboard/src/views/ProjectSettings.jsx`
- Modify: `dashboard/src/views/ProjectSettings.test.jsx`

When an operator clicks rapidly through several controls, do not
fire one PUT per change. Queue only the latest state and flush after
the in-flight save resolves.

- [ ] **Step 1: Write the failing test**

```jsx
it('coalesces rapid changes into one final PUT', async () => {
  mountWithLanePolicy({
    lanePolicy: {
      expected_provider: 'ollama',
      allowed_providers: [],
      allowed_fallback_providers: [],
      by_kind: {},
      enforce_handoffs: false,
    },
  });
  await screen.findByText('Factory Lane Policy');

  const posts = [];
  let resolveFirst;
  const baseFetch = globalThis.fetch;
  globalThis.fetch = vi.fn((url, options = {}) => {
    if (url === '/api/v2/factory/projects/fp-1/trust' && String(options.method).toUpperCase() === 'PUT') {
      posts.push(JSON.parse(options.body));
      if (posts.length === 1) {
        return new Promise((r) => { resolveFirst = () => r(createResponse({ data: { ok: true } }).then((v) => v)); });
      }
      return createResponse({ data: { ok: true } });
    }
    return baseFetch(url, options);
  });

  // Fire three changes while the first save is still in flight.
  fireEvent.change(screen.getByLabelText('Provider for scout'), { target: { value: 'codex' } });
  fireEvent.change(screen.getByLabelText('Provider for plan_generation'), { target: { value: 'codex' } });
  fireEvent.change(screen.getByLabelText('Provider for verify_review'), { target: { value: 'codex' } });

  // First PUT in flight, others should be queued.
  await waitFor(() => expect(posts.length).toBe(1));
  resolveFirst();

  // After the first resolves, exactly ONE more PUT should fire with the
  // final state (all three by_kind entries).
  await waitFor(() => expect(posts.length).toBe(2));
  expect(posts[1].config.provider_lane_policy.by_kind).toEqual({
    scout: 'codex', plan_generation: 'codex', verify_review: 'codex',
  });

  // No third PUT.
  await new Promise((r) => setTimeout(r, 50));
  expect(posts.length).toBe(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd dashboard && npx vitest run src/views/ProjectSettings.test.jsx -t "coalesces rapid changes"
```

Expected: FAIL — without coalescing, three PUTs fire (two of them
race because the in-flight one has not resolved).

- [ ] **Step 3: Add debounce-and-collapse**

Replace `handleLanePolicyChange` with a queue-aware version. Add two
refs alongside `saveStatusClearRef`:

```jsx
const inFlightRef = useRef(false);
const pendingPolicyRef = useRef(null);
```

Refactor the callback. Extract the actual fetch into an inner helper
so we can call it again from the flush path:

```jsx
const performLanePolicySave = useCallback(async (nextPolicy) => {
  setLaneSaveStatus('saving');
  try {
    await requestV2(`/factory/projects/${encodeURIComponent(factoryProjectId)}/trust`, {
      method: 'PUT',
      body: JSON.stringify({
        trust_level: trustLevel,
        config: { provider_lane_policy: nextPolicy },
      }),
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}, [factoryProjectId, trustLevel]);

const handleLanePolicyChange = useCallback((nextPolicy) => {
  if (!factoryProjectId) return;

  // Optimistic local update is always immediate.
  const previous = lanePolicy;
  setLanePolicy(nextPolicy);

  // If a save is in flight, queue the latest state and bail.
  if (inFlightRef.current) {
    pendingPolicyRef.current = nextPolicy;
    return;
  }

  // Otherwise fire a save and drain the queue when it settles.
  (async () => {
    inFlightRef.current = true;
    let lastSent = nextPolicy;
    let revertTo = previous;
    if (saveStatusClearRef.current) {
      clearTimeout(saveStatusClearRef.current);
      saveStatusClearRef.current = null;
    }

    while (true) {
      const result = await performLanePolicySave(lastSent);
      if (!result.ok) {
        // Revert to whatever the policy was before this batch started.
        setLanePolicy(revertTo);
        setLaneSaveStatus('error');
        toast.error(`Failed to save lane policy: ${getErrorMessage(result.error)}`);
        pendingPolicyRef.current = null;
        break;
      }

      // If a queued change accumulated, flush it. Track the new
      // baseline so a subsequent failure reverts to lastSent (the most
      // recent persisted state), not all the way to the original.
      if (pendingPolicyRef.current && pendingPolicyRef.current !== lastSent) {
        revertTo = lastSent;
        lastSent = pendingPolicyRef.current;
        pendingPolicyRef.current = null;
        continue;
      }

      pendingPolicyRef.current = null;
      setLaneSaveStatus('saved');
      saveStatusClearRef.current = setTimeout(() => {
        saveStatusClearRef.current = null;
        setLaneSaveStatus('idle');
      }, 2000);
      break;
    }

    inFlightRef.current = false;
  })();
}, [factoryProjectId, lanePolicy, performLanePolicySave, toast]);
```

- [ ] **Step 4: Run all panel tests to verify nothing regressed**

```bash
cd dashboard && npx vitest run src/views/ProjectSettings.test.jsx
```

Expected: all cases (existing + new) PASS, including the previous
"reverts optimistic state when the PUT fails" test (still works
because `revertTo` starts at `previous`).

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/views/ProjectSettings.jsx dashboard/src/views/ProjectSettings.test.jsx
git commit -m "feat(dashboard): debounce-and-collapse lane policy saves

Rapid changes during an in-flight PUT now queue only the latest state
and flush a single follow-up PUT once the first save resolves. Avoids
racing requests writing stale state and reduces request volume when an
operator clicks through several controls."
```

---

### Task 6: Empty-policy initial state

**Files:**
- Modify: `dashboard/src/views/ProjectSettings.jsx` (already partially handled by Task 2's loosened render guard; verify edge case)
- Modify: `dashboard/src/views/ProjectSettings.test.jsx`

A factory project that has no `provider_lane_policy` yet should still
render the editor (seeded with empty values), and the first edit
should successfully PUT a real policy.

- [ ] **Step 1: Write the failing test**

```jsx
it('renders an empty editor when the project has no lane policy yet', async () => {
  globalThis.fetch = vi.fn((url) => {
    if (url === '/api/v2/tasks/list-projects') return createResponse({ data: [{ name: 'alpha', task_count: 1, last_active: '2026-01-15T10:30:00Z' }] });
    if (url === '/api/v2/tasks/list-project-configs') return createResponse({ data: [{ project: 'alpha' }] });
    if (url === '/api/v2/project-config?project=alpha') {
      return createResponse({ data: { default_provider: 'ollama', default_model: '', verify_command: '', routing_template_id: null, auto_fix_enabled: 0, default_timeout: 30 } });
    }
    if (url === '/api/v2/routing/templates') return createResponse({ data: [] });
    if (url === '/api/v2/provider-scores') return createResponse([]);
    if (url === '/api/v2/cost-budgets') return createResponse([]);
    if (url === '/api/v2/factory/projects') {
      return createResponse({
        data: { projects: [{
          id: 'fp-1', name: 'alpha', trust_level: 'guided',
          config_json: JSON.stringify({}), // no provider_lane_policy
        }] },
      });
    }
    if (url === '/api/v2/providers') {
      return createResponse({ data: { items: [{ name: 'ollama' }, { name: 'codex' }] } });
    }
    throw new Error(`Unhandled fetch: ${url}`);
  });

  renderWithProviders(<ProjectSettings />, { route: '/settings?project=alpha' });

  await screen.findByText('Factory Lane Policy');

  // Expected provider defaults to — none —
  expect(screen.getByLabelText('Expected provider').value).toBe('');

  // Per-kind selects all show — use default —
  for (const kind of ['scout', 'architect_cycle', 'plan_generation', 'verify_review', 'execute']) {
    expect(screen.getByLabelText(`Provider for ${kind}`).value).toBe('');
  }
});

it('first edit on an empty policy PUTs the seeded shape', async () => {
  globalThis.fetch = vi.fn((url, options = {}) => {
    if (url === '/api/v2/tasks/list-projects') return createResponse({ data: [{ name: 'alpha', task_count: 1, last_active: '2026-01-15T10:30:00Z' }] });
    if (url === '/api/v2/tasks/list-project-configs') return createResponse({ data: [{ project: 'alpha' }] });
    if (url === '/api/v2/project-config?project=alpha') {
      return createResponse({ data: { default_provider: 'ollama', default_model: '', verify_command: '', routing_template_id: null, auto_fix_enabled: 0, default_timeout: 30 } });
    }
    if (url === '/api/v2/routing/templates') return createResponse({ data: [] });
    if (url === '/api/v2/provider-scores') return createResponse([]);
    if (url === '/api/v2/cost-budgets') return createResponse([]);
    if (url === '/api/v2/factory/projects') {
      return createResponse({
        data: { projects: [{
          id: 'fp-1', name: 'alpha', trust_level: 'guided',
          config_json: JSON.stringify({}),
        }] },
      });
    }
    if (url === '/api/v2/providers') {
      return createResponse({ data: { items: [{ name: 'ollama' }, { name: 'codex' }] } });
    }
    if (url === '/api/v2/factory/projects/fp-1/trust' && String(options.method).toUpperCase() === 'PUT') {
      return createResponse({ data: { ok: true, body: JSON.parse(options.body) } });
    }
    throw new Error(`Unhandled fetch: ${url}`);
  });

  renderWithProviders(<ProjectSettings />, { route: '/settings?project=alpha' });
  await screen.findByText('Factory Lane Policy');

  fireEvent.change(screen.getByLabelText('Provider for plan_generation'), { target: { value: 'codex' } });

  // Verify a PUT was fired with the seeded structure plus the new override.
  await waitFor(() => {
    const calls = globalThis.fetch.mock.calls.filter((c) => c[0] === '/api/v2/factory/projects/fp-1/trust');
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const body = JSON.parse(calls[0][1].body);
    expect(body).toEqual({
      trust_level: 'guided',
      config: {
        provider_lane_policy: {
          expected_provider: null,
          allowed_providers: [],
          allowed_fallback_providers: [],
          by_kind: { plan_generation: 'codex' },
          enforce_handoffs: false,
        },
      },
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail (or skip if already passing)**

```bash
cd dashboard && npx vitest run src/views/ProjectSettings.test.jsx -t "empty editor|first edit on an empty policy"
```

If they already PASS — Task 2's loosened guard plus the `policy = lanePolicy || {seeded}` fallback inside the panel should already make this work — that is fine. Mark steps 3-4 N/A and skip to Step 5.

If they FAIL — most likely cause is that `lanePolicy` is `null` and the
empty-policy panel re-renders before the new `setLanePolicy(nextPolicy)`
landed. In that case, ensure the seeded fallback in
`FactoryLanePolicyPanel` matches:

```jsx
const policy = lanePolicy || {
  expected_provider: null,
  allowed_providers: [],
  allowed_fallback_providers: [],
  by_kind: {},
  enforce_handoffs: false,
};
```

(this should already exist from Task 2 — verify and adjust).

- [ ] **Step 3: Re-run the tests**

```bash
cd dashboard && npx vitest run src/views/ProjectSettings.test.jsx
```

Expected: all tests PASS.

- [ ] **Step 4: Commit (only if changes were made)**

```bash
git add dashboard/src/views/ProjectSettings.jsx dashboard/src/views/ProjectSettings.test.jsx
git commit -m "test(dashboard): empty-policy editor seeds and saves correctly

Adds regression coverage for projects with no provider_lane_policy yet
— the editor seeds an empty form and a first edit produces a
well-formed PUT with the full shape."
```

If Step 2 passed without code changes, only stage the test file:

```bash
git add dashboard/src/views/ProjectSettings.test.jsx
git commit -m "test(dashboard): empty-policy regression coverage for lane policy editor"
```

---

### Task 7: Provider list fetch fallback + warning toast

**Files:**
- Modify: `dashboard/src/views/ProjectSettings.jsx`
- Modify: `dashboard/src/views/ProjectSettings.test.jsx`

When `/api/v2/providers` fails (404 / network), the editor must still
work. Fall back to a hardcoded baseline list and toast a warning once.

- [ ] **Step 1: Write the failing test**

```jsx
it('falls back to a baseline provider list when /api/v2/providers fails', async () => {
  globalThis.fetch = vi.fn((url) => {
    if (url === '/api/v2/tasks/list-projects') return createResponse({ data: [{ name: 'alpha', task_count: 1, last_active: '2026-01-15T10:30:00Z' }] });
    if (url === '/api/v2/tasks/list-project-configs') return createResponse({ data: [{ project: 'alpha' }] });
    if (url === '/api/v2/project-config?project=alpha') {
      return createResponse({ data: { default_provider: 'ollama', default_model: '', verify_command: '', routing_template_id: null, auto_fix_enabled: 0, default_timeout: 30 } });
    }
    if (url === '/api/v2/routing/templates') return createResponse({ data: [] });
    if (url === '/api/v2/provider-scores') return createResponse([]);
    if (url === '/api/v2/cost-budgets') return createResponse([]);
    if (url === '/api/v2/factory/projects') {
      return createResponse({
        data: { projects: [{
          id: 'fp-1', name: 'alpha', trust_level: 'guided',
          config_json: JSON.stringify({ provider_lane_policy: { expected_provider: 'ollama', allowed_providers: [], allowed_fallback_providers: [], by_kind: {}, enforce_handoffs: false } }),
        }] },
      });
    }
    if (url === '/api/v2/providers') {
      return createResponse({ error: { message: 'not found' } }, { status: 404 });
    }
    throw new Error(`Unhandled fetch: ${url}`);
  });

  renderWithProviders(<ProjectSettings />, { route: '/settings?project=alpha' });
  await screen.findByText('Factory Lane Policy');

  // The expected_provider <select> should still have option list — including codex from the baseline.
  const expectedSelect = screen.getByLabelText('Expected provider');
  expect(expectedSelect.querySelector('option[value="codex"]')).not.toBeNull();
  expect(expectedSelect.querySelector('option[value="ollama"]')).not.toBeNull();
  expect(expectedSelect.querySelector('option[value="deepinfra"]')).not.toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd dashboard && npx vitest run src/views/ProjectSettings.test.jsx -t "falls back to a baseline"
```

Expected: FAIL — without a fallback, providers stays `[]` and no
options render.

- [ ] **Step 3: Wire the fallback**

Define the baseline near the other module-level constants
(top-of-file):

```jsx
const BASELINE_PROVIDERS = Object.freeze([
  'ollama', 'codex', 'codex-spark', 'claude-cli', 'claude-ollama',
  'anthropic', 'deepinfra', 'hyperbolic', 'groq', 'cerebras',
  'google-ai', 'openrouter', 'ollama-cloud',
]);
```

Update the providers fetch effect from Task 1:

```jsx
useEffect(() => {
  let cancelled = false;
  providersApi.list()
    .then((items) => {
      if (cancelled || !mountedRef.current) return;
      const names = Array.isArray(items)
        ? items.map((p) => (typeof p === 'string' ? p : p?.name)).filter(Boolean)
        : [];
      if (names.length === 0) {
        setProviders([...BASELINE_PROVIDERS]);
        toast.warning('Provider list unavailable, using defaults');
      } else {
        setProviders(names);
      }
    })
    .catch(() => {
      if (cancelled || !mountedRef.current) return;
      setProviders([...BASELINE_PROVIDERS]);
      toast.warning('Provider list unavailable, using defaults');
    });
  return () => { cancelled = true; };
}, [toast]);
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd dashboard && npx vitest run src/views/ProjectSettings.test.jsx
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/views/ProjectSettings.jsx dashboard/src/views/ProjectSettings.test.jsx
git commit -m "feat(dashboard): baseline provider fallback for lane policy editor

When /api/v2/providers fails or returns empty, the editor falls back
to a hardcoded baseline list (the 13 known providers) and surfaces a
one-time warning toast. Editor stays fully functional."
```

---

### Task 8: Smoke verification with a live dev server

**Files:** none modified — manual check only.

The implementer should boot the dashboard against a live TORQUE
instance and confirm the editor works end-to-end. This is *the* place
where bugs that don't surface in jsdom show up (focus management, real
network latency, Tailwind class collisions, etc.).

- [ ] **Step 1: Start the dashboard dev server**

```bash
cd dashboard && npm run dev
```

The dev server proxies `/api/v2/*` to the running TORQUE server on
`127.0.0.1:3457` (or wherever the local config points). If TORQUE is
not running, start it first per the root `CLAUDE.md`.

- [ ] **Step 2: Navigate to Project Settings for a factory project**

In a browser open the dashboard URL (default `http://localhost:5173`),
go to Settings, and pick a project that is registered with the
factory and has an existing `provider_lane_policy` (DLPhone is the
canonical example in this repo).

- [ ] **Step 3: Manually verify each control**

For each, confirm the change persists by reloading the page:
- Change the per-kind dropdown for `architect_cycle` and pick a
  different provider. Reload — the new value sticks.
- Set the per-kind dropdown back to `— use default —`. Reload —
  the row shows `(default)` again and source is "Active routing
  template".
- Change `Expected provider` to a different value, including
  `— none —`. Reload between each.
- Toggle `Enforce handoffs`. Reload.
- Open `Allowed providers`, toggle a checkbox. Reload.
- Open `Allowed fallback providers`, toggle a checkbox. Reload.
- Verify the status indicator transitions: `Saving…` (briefly) →
  `Saved ✓` → fades.

- [ ] **Step 4: Verify the failure path**

Stop TORQUE (or use the browser devtools network tab to throttle the
PUT). Make a change. Confirm:
- Toast appears with `Failed to save lane policy: …`.
- The control reverts to its previous value.
- Status indicator shows `Save failed — retry`.

Restart TORQUE and verify a subsequent change saves cleanly.

- [ ] **Step 5: No commit needed if behavior matches the design**

If you find a bug in this manual phase, treat it as a Task 8a / 8b
follow-up — write a test reproducing the issue first, fix, commit.

---

## Self-review

**Spec coverage:**

- ✅ Full editor scope (per-kind table + expected_provider + enforce_handoffs + allowed_providers + allowed_fallback_providers) — Task 2 introduces all five control types.
- ✅ Provider list from `GET /api/v2/providers` — Task 1 adds the fetch; Task 7 adds the fallback.
- ✅ Inline auto-save per field — Task 3 wires the save callback; controls are individual `onChange` handlers.
- ✅ Multi-select dropdown with checkboxes — Task 2 adds `MultiSelectDropdown`.
- ✅ Sentinel options (`— none —`, `— use default —`) — Task 2 adds them; Task 3 verifies key deletion.
- ✅ `trust_level` echo — Task 1 captures, Task 3 sends in the PUT body.
- ✅ Concurrency: debounce-and-collapse — Task 5.
- ✅ Empty-policy seeded editor — Task 2's loosened render guard + Task 6's regression test.
- ✅ Disabled state when no `factoryProjectId` — Task 2 panel passes `disabled={!factoryProjectId}` and renders the amber hint.
- ✅ Status indicator (Saving / Saved ✓ / Save failed — retry) — Task 4.
- ✅ Optimistic update + revert on error — Task 3 (and refined in Task 5 for the queued-flush case).
- ✅ Manual smoke check — Task 8.

**Placeholder scan:** None. Every step has the actual code or the
exact command and expected result.

**Type consistency:** The `provider_lane_policy` shape is consistent
across all task code blocks
(`{expected_provider, allowed_providers, allowed_fallback_providers,
by_kind, enforce_handoffs}`). The save body shape is the same in
Task 3, Task 5, Task 6, and Task 7 (`{trust_level, config:
{provider_lane_policy}}`). Status indicator values are `idle |
saving | saved | error` everywhere.

**Followups deliberately not covered (already in the spec's
"Out of scope" section):**
- Surfacing kind-family inheritance in the UI.
- Marking `trust_level` optional on `set_factory_trust_level` (would
  let us drop the trustLevel echo and is a pure server-side change).
- Bulk-editing across projects.
