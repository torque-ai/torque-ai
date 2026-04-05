# Strategy Overview Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Strategy overview tab to show real task routing data instead of unused Strategic Intelligence brain stats.

**Architecture:** The overview tab fetches 3 new data sources (providers list, budget summary, queue counts) alongside the existing strategic API calls. The "Strategic Intelligence" panel moves to the Configuration tab. New panels show task distribution by provider (SVGBarChart), active routing template, queue depth, 7-day cost, and a compact recent-decisions preview. Provider Health cards switch from 1-hour to 7-day stats sourced from the providers list API.

**Tech Stack:** React, existing SVGBarChart/SVGPieChart from `dashboard/src/components/charts/`, existing API functions from `dashboard/src/api.js`

**Spec:** The routing overview should answer: "Where are my tasks going, how well are providers performing, and what's the routing doing?"

---

## Current Usage Audit

| Section | Current Source | Problem |
|---------|---------------|---------|
| Stat cards | `strategic.status().usage` | LLM Calls / Tokens Used always 0 — strategic brain unused |
| Strategic Intelligence panel | `strategic.status()` | Shows brain LLM config, not task routing config |
| Routing Summary | `strategic.decisions()` | Only strategic brain decisions, not smart routing |
| Provider Health grid | `strategic.providerHealth()` | 1-hour window — always shows "—" |

## File Map

| File | Responsibility | Action |
|------|---------------|--------|
| `dashboard/src/views/Strategy.jsx` | Strategy page with 5 tabs | Modify: ~150 lines changed in overview tab |
| `dashboard/src/views/Strategy.test.jsx` | Tests for Strategy | Modify: update mocks + assertions for new data |

---

## Task 1: Add New API Imports and State

**Files:**
- Modify: `dashboard/src/views/Strategy.jsx:1-10` (imports)
- Modify: `dashboard/src/views/Strategy.jsx:440-467` (state + loadData)

- [ ] **Step 1: Add imports for new API modules and chart components**

At the top of Strategy.jsx, add to the existing imports:

```jsx
import { providers as providersApi, budget as budgetApi, tasks as tasksApi, routingTemplates as routingTemplatesApi } from '../api';
import { SVGBarChart, SVGPieChart } from '../components/charts';
```

- [ ] **Step 2: Add new state variables**

After the existing `useState` declarations (around line 447), add:

```jsx
const [providerStats, setProviderStats] = useState([]);
const [budgetSummary, setBudgetSummary] = useState(null);
const [queueDepth, setQueueDepth] = useState({ queued: 0, running: 0 });
const [activeTemplate, setActiveTemplate] = useState(null);
```

- [ ] **Step 3: Expand loadData to fetch new data sources**

In the `loadData` callback (line 449-467), add the new fetches to the `Promise.all`. The new fetches should all have `.catch(() => ...)` fallbacks since they're supplementary:

```jsx
const loadData = useCallback(async () => {
  try {
    const [statusData, opsData, decisionsData, healthData, provData, budgetData, queuedData, runningData, templateData] = await Promise.all([
      strategicApi.status(),
      strategicApi.operations(20),
      strategicApi.decisions(50),
      strategicApi.providerHealth(),
      providersApi.list().catch(() => []),
      budgetApi.summary(7).catch(() => null),
      tasksApi.list({ status: 'queued', limit: 1 }).catch(() => ({ total: 0 })),
      tasksApi.list({ status: 'running', limit: 1 }).catch(() => ({ total: 0 })),
      routingTemplatesApi.getActive().catch(() => null),
    ]);
    setStatus(statusData);
    setOperations(unwrapArrayPayload(opsData, 'operations', 'items'));
    setDecisions(unwrapArrayPayload(decisionsData, 'decisions', 'items'));
    setProviderHealth(unwrapArrayPayload(healthData, 'providers', 'items'));
    setProviderStats(Array.isArray(provData) ? provData : []);
    setBudgetSummary(budgetData);
    setQueueDepth({ queued: queuedData?.total || 0, running: runningData?.total || 0 });
    setActiveTemplate(templateData?.template || null);
    setError(null);
  } catch (err) {
    setError(err.message);
  } finally {
    setLoading(false);
  }
}, []);
```

- [ ] **Step 4: Commit**

```
git add dashboard/src/views/Strategy.jsx
git commit -m "feat: add provider stats, budget, queue, and template data to Strategy overview"
```

---

## Task 2: Replace Stat Cards

**Files:**
- Modify: `dashboard/src/views/Strategy.jsx:559-575` (stat cards grid)

- [ ] **Step 1: Compute new derived values**

After the existing `healthyProviders` line (around line 517), add:

```jsx
const totalTasks7d = providerStats.reduce((s, p) => s + (p.stats?.total_tasks || 0), 0);
const completedTasks7d = providerStats.reduce((s, p) => s + (p.stats?.completed_tasks || p.stats?.successful_tasks || 0), 0);
const successRate7d = totalTasks7d > 0 ? Math.round((completedTasks7d / totalTasks7d) * 100) : null;
const totalCost7d = budgetSummary?.total_cost || 0;
```

- [ ] **Step 2: Replace the stat cards grid**

Replace the stat cards block (lines 559-575) with:

```jsx
<div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
  <StatCard label="Tasks (7d)" value={totalTasks7d} gradient="blue" />
  <StatCard
    label="Success Rate"
    value={successRate7d !== null ? `${successRate7d}%` : 'N/A'}
    gradient={successRate7d === null ? 'slate' : successRate7d >= 80 ? 'green' : successRate7d >= 50 ? 'orange' : 'red'}
  />
  <StatCard label="Queue" value={queueDepth.queued + queueDepth.running} subtext={`${queueDepth.running} running`} gradient={queueDepth.queued > 10 ? 'orange' : 'cyan'} />
  <StatCard label="Cost (7d)" value={`$${totalCost7d.toFixed(2)}`} gradient="purple" />
  <StatCard
    label="Providers"
    value={`${healthyProviders}/${enabledProviders}`}
    subtext="healthy / enabled"
    gradient={healthyProviders < enabledProviders ? 'orange' : 'green'}
  />
</div>
```

- [ ] **Step 3: Commit**

```
git add dashboard/src/views/Strategy.jsx
git commit -m "feat: replace strategic brain stat cards with real task routing stats"
```

---

## Task 3: Replace Panels — Active Routing + Task Distribution

**Files:**
- Modify: `dashboard/src/views/Strategy.jsx:577-633` (two-column panel area)

- [ ] **Step 1: Replace "Strategic Intelligence" panel with "Active Routing"**

Replace the left panel (lines 579-599) with:

```jsx
<div className="glass-card p-5">
  <h3 className="text-sm font-medium text-slate-400 mb-3">Active Routing</h3>
  <div className="space-y-2">
    <div className="flex items-center justify-between">
      <span className="text-sm text-slate-400">Template</span>
      <span className="text-sm text-white font-medium">{activeTemplate?.name || 'System Default'}</span>
    </div>
    <div className="flex items-center justify-between">
      <span className="text-sm text-slate-400">Default Provider</span>
      <span className="text-sm text-white font-medium capitalize">{status?.provider || 'auto'}</span>
    </div>
    <div className="flex items-center justify-between">
      <span className="text-sm text-slate-400">Total Decisions</span>
      <span className="text-sm text-white">{decisions.length}</span>
    </div>
    <div className="flex items-center justify-between">
      <span className="text-sm text-slate-400">Tasks (7d)</span>
      <span className="text-sm text-white">{totalTasks7d}</span>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Replace "Routing Summary" panel with real task distribution**

Replace the right panel (lines 601-632) with a bar chart showing tasks by provider from real completion data:

```jsx
<div className="glass-card p-5">
  <h3 className="text-sm font-medium text-slate-400 mb-3">Tasks by Provider (7d)</h3>
  {(() => {
    const chartData = providerStats
      .filter(p => (p.stats?.total_tasks || 0) > 0)
      .sort((a, b) => (b.stats?.total_tasks || 0) - (a.stats?.total_tasks || 0))
      .slice(0, 8)
      .map(p => ({
        name: p.provider,
        tasks: p.stats?.total_tasks || 0,
      }));
    if (chartData.length === 0) {
      return <p className="text-slate-500 text-sm">No task data yet</p>;
    }
    return (
      <SVGBarChart
        data={chartData}
        xKey="name"
        bars={[{
          dataKey: 'tasks',
          colorFn: (entry) => {
            const s = getProviderStyle(entry.name);
            // Extract hex from the tailwind class (dot field holds bg-xxx-400)
            const colorMap = { codex: '#3b82f6', 'claude-cli': '#8b5cf6', ollama: '#22c55e', groq: '#ec4899', deepinfra: '#f97316', hyperbolic: '#a855f7', cerebras: '#06b6d4', 'google-ai': '#10b981', openrouter: '#f59e0b', 'ollama-cloud': '#14b8a6', anthropic: '#f59e0b' };
            return colorMap[entry.name] || '#64748b';
          },
        }]}
        height={180}
        formatTooltip={(v) => `${v} tasks`}
      />
    );
  })()}
</div>
```

- [ ] **Step 3: Commit**

```
git add dashboard/src/views/Strategy.jsx
git commit -m "feat: active routing panel + real task distribution chart"
```

---

## Task 4: Update Provider Health Grid to Use 7-Day Stats

**Files:**
- Modify: `dashboard/src/views/Strategy.jsx:131-201` (ProviderHealthCard + ProviderHealthGrid)
- Modify: `dashboard/src/views/Strategy.jsx:624-627` (where grid is rendered)

- [ ] **Step 1: Update ProviderHealthCard to accept 7-day stats**

The provider health grid currently receives `providerHealth` (from strategic API, 1-hour window). Change it to merge 7-day stats from the providers list API. In the overview rendering section (around line 625), change:

```jsx
<ProviderHealthGrid providers={providerHealth} />
```

to:

```jsx
<ProviderHealthGrid providers={providerHealth.map(p => {
  const ps = providerStats.find(s => s.provider === p.provider);
  return {
    ...p,
    total_tasks_7d: ps?.stats?.total_tasks || 0,
    completed_7d: ps?.stats?.completed_tasks || ps?.stats?.successful_tasks || 0,
    failed_7d: ps?.stats?.failed_tasks || 0,
    success_rate_7d: ps?.stats?.success_rate || null,
    avg_duration_seconds: ps?.stats?.avg_duration_seconds || p.avg_duration_seconds || null,
  };
})} />
```

- [ ] **Step 2: Update ProviderHealthCard to show 7-day data**

In ProviderHealthCard (around line 159-177), replace the grid contents:

```jsx
<div className="grid grid-cols-2 gap-2 text-xs">
  <div>
    <p className="text-slate-500 mb-0.5">Success (7d)</p>
    <p className="text-white font-medium">
      {data.success_rate_7d !== null && data.success_rate_7d !== undefined ? `${data.success_rate_7d}%` : '—'}
    </p>
  </div>
  <div>
    <p className="text-slate-500 mb-0.5">Avg Latency</p>
    <p className="text-white font-medium">{avgLatencyDisplay}</p>
  </div>
  <div>
    <p className="text-slate-500 mb-0.5">Completed (7d)</p>
    <p className="text-white font-medium">{data.completed_7d || 0}</p>
  </div>
  <div>
    <p className="text-slate-500 mb-0.5">Failed (7d)</p>
    <p className="text-white font-medium">{data.failed_7d || 0}</p>
  </div>
</div>
```

- [ ] **Step 3: Commit**

```
git add dashboard/src/views/Strategy.jsx
git commit -m "feat: provider health cards show 7-day stats instead of 1-hour"
```

---

## Task 5: Add Recent Decisions Preview

**Files:**
- Modify: `dashboard/src/views/Strategy.jsx` (after Provider Health grid, before closing `</>`)

- [ ] **Step 1: Add compact decisions preview between Fallback Chain and Provider Health**

After the Fallback Chain section and before the Provider Health grid (around line 635), add:

```jsx
{/* Recent Routing Decisions */}
{decisions.length > 0 && (
  <div className="glass-card p-5 mb-6">
    <div className="flex items-center justify-between mb-3">
      <h3 className="text-lg font-semibold text-white">Recent Decisions</h3>
      <button
        onClick={() => setTopTab('decisions')}
        className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
      >
        View all
      </button>
    </div>
    <div className="space-y-2">
      {decisions.slice(0, 5).map((d) => {
        const style = getProviderStyle(d.provider);
        const complexityStyle = COMPLEXITY_STYLES[d.complexity] || COMPLEXITY_STYLES.unknown;
        return (
          <div key={d.task_id} className="flex items-center gap-3 text-xs">
            <span className="text-slate-500 w-16 shrink-0">
              {d.created_at ? format(new Date(d.created_at), 'HH:mm') : '—'}
            </span>
            <span className={`px-2 py-0.5 rounded-full font-medium ${complexityStyle} shrink-0`}>
              {d.complexity}
            </span>
            <span className={`px-2 py-0.5 rounded-lg font-medium ${style.bg} ${style.text} capitalize shrink-0`}>
              {d.provider}
            </span>
            <span className="text-slate-400 truncate">{d.reason}</span>
          </div>
        );
      })}
    </div>
  </div>
)}
```

- [ ] **Step 2: Commit**

```
git add dashboard/src/views/Strategy.jsx
git commit -m "feat: add recent decisions preview to routing overview"
```

---

## Task 6: Move Strategic Intelligence to Configuration Tab

**Files:**
- Modify: `dashboard/src/views/Strategy.jsx` (config tab section)

- [ ] **Step 1: Find the Configuration tab render section**

The Configuration tab renders `StrategicConfig` via lazy loading. Find the section (around line 650+) that renders when `topTab === 'config'`. Add the Strategic Intelligence info above the lazy-loaded config component:

```jsx
{topTab === 'config' && (
  <>
    <div className="glass-card p-5 mb-6">
      <h3 className="text-sm font-medium text-slate-400 mb-3">Strategic Intelligence</h3>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm text-slate-400">Provider</span>
          <span className="text-sm text-white font-medium capitalize">{status?.provider || 'none'}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-slate-400">Model</span>
          <span className="text-sm text-white font-mono text-xs">{status?.model || 'none'}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-slate-400">Confidence Threshold</span>
          <span className="text-sm text-white">{((status?.confidence_threshold || 0) * 100).toFixed(0)}%</span>
        </div>
      </div>
    </div>
    <Suspense fallback={<LoadingSkeleton lines={3} />}>
      <StrategicConfig />
    </Suspense>
  </>
)}
```

- [ ] **Step 2: Commit**

```
git add dashboard/src/views/Strategy.jsx
git commit -m "feat: move strategic intelligence panel to configuration tab"
```

---

## Task 7: Update Header Subtitle

**Files:**
- Modify: `dashboard/src/views/Strategy.jsx:525-527`

- [ ] **Step 1: Update the subtitle text**

Change line 526 from:
```
Routing decisions, provider health, and LLM-powered orchestration
```
to:
```
Task routing, provider health, and queue status
```

- [ ] **Step 2: Commit**

```
git add dashboard/src/views/Strategy.jsx
git commit -m "chore: update strategy page subtitle"
```

---

## Task 8: Update Tests

**Files:**
- Modify: `dashboard/src/views/Strategy.test.jsx`

- [ ] **Step 1: Add new API mocks**

In the `vi.mock('../api', ...)` block (lines 5-19), add the new API modules:

```jsx
providers: {
  list: vi.fn().mockResolvedValue([
    { provider: 'codex', enabled: true, stats: { total_tasks: 15, completed_tasks: 14, failed_tasks: 1, success_rate: 93, avg_duration_seconds: 120 } },
    { provider: 'ollama', enabled: true, stats: { total_tasks: 30, completed_tasks: 28, failed_tasks: 2, success_rate: 93, avg_duration_seconds: 45 } },
  ]),
},
budget: {
  summary: vi.fn().mockResolvedValue({ total_cost: 0.45, task_count: 45, by_provider: { codex: 0.45 } }),
},
tasks: {
  list: vi.fn().mockResolvedValue({ tasks: [], total: 3 }),
},
```

Also update the `routingTemplates` mock to return template data:
```jsx
routingTemplates: {
  list: vi.fn().mockResolvedValue([]),
  getActive: vi.fn().mockResolvedValue({ template: { id: 'preset-system-default', name: 'System Default' } }),
  categories: vi.fn().mockResolvedValue([]),
},
```

- [ ] **Step 2: Update stat card tests**

Replace the "displays LLM Calls stat card" test (line 228) with:
```jsx
it('displays Tasks (7d) stat card', async () => {
  renderWithProviders(<Strategic />, { route: '/strategy' });
  await waitFor(() => {
    expect(screen.getByText('Tasks (7d)')).toBeInTheDocument();
  });
});
```

Replace the "displays Tokens Used stat card" test (line 242) with:
```jsx
it('displays Cost (7d) stat card', async () => {
  renderWithProviders(<Strategic />, { route: '/strategy' });
  await waitFor(() => {
    expect(screen.getByText('Cost (7d)')).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Update panel tests**

Replace the "Active Configuration" test (line 268) to check for "Active Routing":
```jsx
expect(screen.getByText('Active Routing')).toBeInTheDocument();
```

Replace the "Routing Summary" test (line 292) to check for "Tasks by Provider (7d)":
```jsx
expect(screen.getByText('Tasks by Provider (7d)')).toBeInTheDocument();
```

- [ ] **Step 4: Verify tests pass**

```
torque-remote npx vitest run dashboard/src/views/Strategy.test.jsx --reporter=verbose
```

- [ ] **Step 5: Commit**

```
git add dashboard/src/views/Strategy.test.jsx
git commit -m "test: update strategy tests for routing overview redesign"
```

---

## Task 9: Build and Visual Verification

- [ ] **Step 1: Build the dashboard**

```
cd dashboard && npx vite build
```

Expected: clean build, no errors, index chunk ~390KB

- [ ] **Step 2: Rebuild dist and commit**

```
git add -f dashboard/dist/
git commit -m "chore: rebuild dashboard dist with strategy overview redesign"
```

- [ ] **Step 3: Visual verification with Playwright**

Take a screenshot of the routing overview and verify:
- Stat cards: Tasks (7d), Success Rate, Queue, Cost (7d), Providers
- Left panel: "Active Routing" with template name + default provider
- Right panel: "Tasks by Provider (7d)" with SVGBarChart
- Fallback Chain: unchanged, shows correct health status
- Recent Decisions: last 5 with time, complexity, provider, reason
- Provider Health: 7-day stats (Success 7d, Completed 7d, Failed 7d)
- No page errors

- [ ] **Step 4: Push**

```
git push origin main
```
