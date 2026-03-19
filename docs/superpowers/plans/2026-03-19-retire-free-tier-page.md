# Retire Free Tier Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the misleading Free Tier dashboard page by migrating its two unique features (usage history chart, cooldown tracking) to the Providers page, then deleting the page.

**Architecture:** Three steps — add cooldown to the quota store, add usage history chart to Providers page, then remove the Free Tier page and all its wiring. Each step is independently shippable.

**Tech Stack:** Node.js, React (JSX), vitest, recharts, existing provider-quotas module

---

### Task 1: Add cooldown tracking to provider-quotas store

**Files:**
- Modify: `server/db/provider-quotas.js` — add `cooldownUntil` to `record429`, expose in `getQuota`
- Modify: `server/tests/provider-quotas.test.js` — test cooldown behavior
- Modify: `dashboard/src/views/Providers.jsx` — show cooldown badge on provider cards

The quota store already has `record429()` which sets status to red. Extend it to also record a cooldown expiry timestamp so the dashboard can show a countdown.

- [ ] **Step 1: Write failing test for cooldown**

Append to `server/tests/provider-quotas.test.js`:

```js
  describe('cooldown', () => {
    it('record429 sets cooldownUntil 60s in the future', () => {
      store.record429('groq');
      const q = store.getQuota('groq');
      expect(q.cooldownUntil).toBeDefined();
      const until = new Date(q.cooldownUntil).getTime();
      const now = Date.now();
      expect(until).toBeGreaterThan(now);
      expect(until).toBeLessThanOrEqual(now + 61000);
    });

    it('isOnCooldown returns true during cooldown', () => {
      store.record429('groq');
      expect(store.isOnCooldown('groq')).toBe(true);
    });

    it('isOnCooldown returns false when no 429 recorded', () => {
      expect(store.isOnCooldown('cerebras')).toBe(false);
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement cooldown in provider-quotas.js**

In `record429()`, add `cooldownUntil`:

```js
  function record429(provider, cooldownSeconds = 60) {
    if (!provider) return;
    const entry = ensureEntry(provider);
    entry.status = 'red';
    entry.cooldownUntil = new Date(Date.now() + cooldownSeconds * 1000).toISOString();
    entry.lastUpdated = new Date().toISOString();
  }

  function isOnCooldown(provider) {
    const q = quotas[provider];
    if (!q || !q.cooldownUntil) return false;
    return new Date(q.cooldownUntil).getTime() > Date.now();
  }
```

Export `isOnCooldown` from the store.

- [ ] **Step 4: Add cooldown badge to Providers.jsx QuotaStatusBadge**

In the `QuotaStatusBadge` component, check `quota.cooldownUntil`:

```jsx
  if (quota?.cooldownUntil && new Date(quota.cooldownUntil) > new Date()) {
    const secsLeft = Math.round((new Date(quota.cooldownUntil) - new Date()) / 1000);
    tooltipLines.unshift(`⏱ Cooldown: ${secsLeft}s remaining`);
  }
```

- [ ] **Step 5: Run tests, commit**

```
git add server/db/provider-quotas.js server/tests/provider-quotas.test.js dashboard/src/views/Providers.jsx
git commit -m "feat(quotas): add cooldown tracking to provider-quotas store"
```

---

### Task 2: Migrate usage history chart to Providers page

**Files:**
- Modify: `dashboard/src/views/Providers.jsx` — add 7-day usage history chart at the bottom
- Modify: `dashboard/src/api.js` — ensure `freeTier.history()` is accessible (it already exists)

The Free Tier page has a stacked area chart showing 7-day usage history per provider (requests and tokens). Move this chart to the bottom of the Providers page.

- [ ] **Step 1: Add history fetch to Providers.jsx loadData**

In the `Promise.all` inside `loadData`, add:

```js
request('/free-tier/history?days=7').catch(() => ({ history: [] })),
```

Add state: `const [usageHistory, setUsageHistory] = useState([]);`

Set it: `setUsageHistory(historyResult.history || []);`

- [ ] **Step 2: Add buildChartData helper**

Copy the `buildChartData` function from `FreeTier.jsx` into `Providers.jsx` (or extract to a shared util). It transforms flat history rows into recharts-friendly `[{ date, groq: 12, cerebras: 5 }]` format.

```jsx
const CHART_METRICS = {
  requests: { field: 'total_requests', label: 'Requests' },
  tokens: { field: 'total_tokens', label: 'Tokens' },
};

function buildChartData(history, metric = 'requests') {
  if (!history || history.length === 0) return { chartData: [], providerKeys: [] };
  const fieldName = CHART_METRICS[metric]?.field || 'total_requests';
  const byDate = {};
  const providerSet = new Set();
  for (const row of history) {
    providerSet.add(row.provider);
    if (!byDate[row.date]) byDate[row.date] = { date: row.date };
    byDate[row.date][row.provider] = row[fieldName] || 0;
  }
  const providerKeys = [...providerSet].sort();
  const chartData = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
  for (const entry of chartData) {
    for (const p of providerKeys) {
      if (entry[p] === undefined) entry[p] = 0;
    }
  }
  return { chartData, providerKeys };
}
```

- [ ] **Step 3: Add chart metric toggle + stacked area chart**

Below the existing charts section (after the "Overall Success Rate Trend" chart, around line 880), add:

```jsx
{/* 7-Day Provider Usage History */}
{usageHistory.length > 0 && (
  <div className="glass-card p-6 mt-6">
    <div className="flex items-center justify-between mb-4">
      <h3 className="text-lg font-semibold text-white">7-Day Provider Usage</h3>
      {/* Toggle between requests/tokens */}
    </div>
    <ResponsiveContainer width="100%" height={250}>
      <AreaChart data={chartData}>
        <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
        <XAxis dataKey="date" tick={{ fill: '#94a3b8', fontSize: 12 }} tickFormatter={formatDate} />
        <YAxis tick={{ fill: '#94a3b8', fontSize: 12 }} allowDecimals={false} />
        <Tooltip contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '8px' }} />
        <Legend />
        {providerKeys.map((provider, idx) => (
          <Area key={provider} type="monotone" dataKey={provider}
            stackId="usage" stroke={getProviderColor(provider)}
            fill={getProviderColor(provider)} fillOpacity={0.3}
            strokeWidth={2} name={provider} />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  </div>
)}
```

Add `Area` to the recharts import at the top of the file if not already present.

- [ ] **Step 4: Build and test**

Run: `cd dashboard && npm run build`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```
git add dashboard/src/views/Providers.jsx
git commit -m "feat(providers): migrate 7-day usage history chart from Free Tier page"
```

---

### Task 3: Remove Free Tier page and all wiring

**Files:**
- Delete: `dashboard/src/views/FreeTier.jsx`
- Delete: `dashboard/src/views/FreeTier.test.jsx`
- Modify: `dashboard/src/App.jsx` — remove route and lazy import
- Modify: `dashboard/src/components/Layout.jsx` — remove sidebar nav entry
- Modify: `dashboard/src/api.js` — remove `freeTier` export (keep the functions if history endpoint is still used by Providers)

- [ ] **Step 1: Remove sidebar nav entry**

In `dashboard/src/components/Layout.jsx`, remove line 20 (`'/free-tier': 'Free Tier'`) and line 148 (`{ to: '/free-tier', icon: FreeTierIcon, label: 'Free Tier' }`). Also remove the `FreeTierIcon` import/definition if it's only used here.

- [ ] **Step 2: Remove route**

In `dashboard/src/App.jsx`, remove line 26 (`const FreeTier = lazy(...)`) and line 273 (`<Route path="free-tier" ...>`).

- [ ] **Step 3: Delete FreeTier files**

```
rm dashboard/src/views/FreeTier.jsx dashboard/src/views/FreeTier.test.jsx
```

- [ ] **Step 4: Clean up api.js**

In `dashboard/src/api.js`, the `freeTier` export (line 422-425) can be removed from the default export. BUT keep the `history` function accessible if Providers.jsx uses it. If Providers.jsx calls `request('/free-tier/history')` directly (not through `freeTierApi`), the export can be fully removed.

- [ ] **Step 5: Build and verify**

Run: `cd dashboard && npm run build`
Expected: Build succeeds, no references to FreeTier remain.

Run: `grep -r "FreeTier\|free-tier\|freeTier" dashboard/src/ --include="*.jsx" --include="*.js"`
Expected: Only the `/free-tier/history` API call in Providers.jsx (the backend endpoint stays for now).

- [ ] **Step 6: Commit**

```
git add -A
git commit -m "feat: retire Free Tier page — features migrated to Providers page"
```

- [ ] **Step 7: Rebuild dashboard**

```
cd dashboard && npm run build
git add dashboard/dist/
git commit -m "build: dashboard rebuild after Free Tier page removal"
```
