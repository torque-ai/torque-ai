# Provider Quota Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface real-time quota/rate-limit data on dashboard provider cards and use it to skip exhausted providers during routing.

**Architecture:** In-memory quota store updated from response headers (groq/cerebras/openrouter) and task history inference (others). Three integration points: provider submit methods (header capture), routing chain iteration (quota check), dashboard Providers page (UI bars + badge).

**Tech Stack:** Node.js, React (JSX), vitest, existing provider classes + dashboard components

**Spec:** `docs/superpowers/specs/2026-03-19-provider-quota-monitoring-design.md`

---

### Task 1: Quota Store — core module + tests (TDD)

**Files:**
- Create: `server/db/provider-quotas.js`
- Create: `server/tests/provider-quotas.test.js`

- [ ] **Step 1: Write failing tests**

Create `server/tests/provider-quotas.test.js`:

```js
'use strict';

const { createQuotaStore } = require('../db/provider-quotas');

describe('provider-quotas', () => {
  let store;
  beforeEach(() => { store = createQuotaStore(); });

  describe('updateFromHeaders', () => {
    it('parses groq-style headers (relative duration reset)', () => {
      store.updateFromHeaders('groq', {
        'x-ratelimit-limit-requests': '30',
        'x-ratelimit-remaining-requests': '25',
        'x-ratelimit-reset-requests': '6s',
        'x-ratelimit-limit-tokens': '6000',
        'x-ratelimit-remaining-tokens': '5200',
        'x-ratelimit-reset-tokens': '1m30s',
      });
      const q = store.getQuota('groq');
      expect(q).not.toBeNull();
      expect(q.limits.rpm.limit).toBe(30);
      expect(q.limits.rpm.remaining).toBe(25);
      expect(q.limits.tpm.limit).toBe(6000);
      expect(q.limits.tpm.remaining).toBe(5200);
      expect(q.source).toBe('headers');
    });

    it('parses cerebras-style headers (ISO reset)', () => {
      const resetTime = new Date(Date.now() + 60000).toISOString();
      store.updateFromHeaders('cerebras', {
        'x-ratelimit-limit-requests': '200',
        'x-ratelimit-remaining-requests': '142',
        'x-ratelimit-reset-requests': resetTime,
      });
      const q = store.getQuota('cerebras');
      expect(q.limits.rpm.limit).toBe(200);
      expect(q.limits.rpm.remaining).toBe(142);
      expect(q.limits.rpm.resetsAt).toBe(resetTime);
    });

    it('parses openrouter-style headers (epoch reset)', () => {
      const epochSec = Math.floor(Date.now() / 1000) + 60;
      store.updateFromHeaders('openrouter', {
        'x-ratelimit-limit-requests': '100',
        'x-ratelimit-remaining-requests': '88',
        'x-ratelimit-reset': String(epochSec),
      });
      const q = store.getQuota('openrouter');
      expect(q.limits.rpm.remaining).toBe(88);
    });

    it('last-write-wins — newer update overwrites', () => {
      store.updateFromHeaders('groq', {
        'x-ratelimit-remaining-requests': '10',
      });
      store.updateFromHeaders('groq', {
        'x-ratelimit-remaining-requests': '30',
      });
      expect(store.getQuota('groq').limits.rpm.remaining).toBe(30);
    });

    it('ignores missing headers without overwriting existing data', () => {
      store.updateFromHeaders('groq', {
        'x-ratelimit-remaining-requests': '20',
        'x-ratelimit-remaining-tokens': '5000',
      });
      store.updateFromHeaders('groq', {
        'x-ratelimit-remaining-requests': '19',
        // no token headers this time
      });
      const q = store.getQuota('groq');
      expect(q.limits.rpm.remaining).toBe(19);
      expect(q.limits.tpm.remaining).toBe(5000); // preserved
    });
  });

  describe('status computation', () => {
    it('green when all limits > 50%', () => {
      store.updateFromHeaders('cerebras', {
        'x-ratelimit-limit-requests': '100',
        'x-ratelimit-remaining-requests': '80',
      });
      expect(store.getQuota('cerebras').status).toBe('green');
    });

    it('yellow when any limit 10-50%', () => {
      store.updateFromHeaders('cerebras', {
        'x-ratelimit-limit-requests': '100',
        'x-ratelimit-remaining-requests': '30',
      });
      expect(store.getQuota('cerebras').status).toBe('yellow');
    });

    it('red when any limit < 10%', () => {
      store.updateFromHeaders('cerebras', {
        'x-ratelimit-limit-requests': '100',
        'x-ratelimit-remaining-requests': '5',
      });
      expect(store.getQuota('cerebras').status).toBe('red');
    });
  });

  describe('getQuota', () => {
    it('returns null for unknown providers', () => {
      expect(store.getQuota('nonexistent')).toBeNull();
    });

    it('returns all quotas via getAllQuotas', () => {
      store.updateFromHeaders('groq', { 'x-ratelimit-remaining-requests': '10' });
      store.updateFromHeaders('cerebras', { 'x-ratelimit-remaining-requests': '20' });
      const all = store.getAllQuotas();
      expect(Object.keys(all)).toContain('groq');
      expect(Object.keys(all)).toContain('cerebras');
    });
  });

  describe('record429', () => {
    it('sets status to red on 429', () => {
      store.updateFromHeaders('groq', {
        'x-ratelimit-limit-requests': '30',
        'x-ratelimit-remaining-requests': '0',
      });
      store.record429('groq');
      expect(store.getQuota('groq').status).toBe('red');
    });
  });

  describe('isExhausted', () => {
    it('returns false when no data', () => {
      expect(store.isExhausted('groq')).toBe(false);
    });
    it('returns true when remaining is 0', () => {
      store.updateFromHeaders('groq', {
        'x-ratelimit-limit-requests': '30',
        'x-ratelimit-remaining-requests': '0',
      });
      expect(store.isExhausted('groq')).toBe(true);
    });
    it('returns false when remaining > 0', () => {
      store.updateFromHeaders('groq', {
        'x-ratelimit-remaining-requests': '5',
      });
      expect(store.isExhausted('groq')).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `./scripts/torque-test.sh npx vitest run server/tests/provider-quotas.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the quota store**

Create `server/db/provider-quotas.js`:

```js
'use strict';

/**
 * Provider Quota Store — in-memory rate limit tracking.
 *
 * Updated from two sources:
 * 1. Response headers (groq, cerebras, openrouter) — real-time, zero cost
 * 2. Task history inference (google-ai, deepinfra, etc.) — 5-minute cycle
 *
 * Consumed by: dashboard (GET /api/provider-quotas) and routing (isExhausted check).
 */

/**
 * Parse a rate-limit reset value into an ISO datetime string.
 * Handles three formats:
 * - Relative duration: "6s", "1m30s", "2m" → Date.now() + duration
 * - ISO timestamp: "2026-03-19T12:05:00Z" → as-is
 * - Unix epoch: "1742565900" → new Date(value * 1000)
 */
function parseResetValue(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();

  // ISO timestamp (contains T or -)
  if (trimmed.includes('T') || (trimmed.includes('-') && trimmed.length > 10)) {
    return trimmed;
  }

  // Unix epoch (all digits, reasonable range)
  if (/^\d{10,13}$/.test(trimmed)) {
    const epoch = parseInt(trimmed, 10);
    // If 13 digits, already ms; if 10, convert to ms
    const ms = epoch > 1e12 ? epoch : epoch * 1000;
    return new Date(ms).toISOString();
  }

  // Relative duration (e.g., "6s", "1m30s", "2m")
  const durationMatch = trimmed.match(/^(?:(\d+)m)?(?:(\d+)s)?$/);
  if (durationMatch && (durationMatch[1] || durationMatch[2])) {
    const minutes = parseInt(durationMatch[1] || '0', 10);
    const seconds = parseInt(durationMatch[2] || '0', 10);
    const ms = (minutes * 60 + seconds) * 1000;
    return new Date(Date.now() + ms).toISOString();
  }

  return null;
}

function computeStatus(limits) {
  let worstPct = 100;
  for (const key of Object.keys(limits)) {
    const { limit, remaining } = limits[key];
    if (limit > 0) {
      const pct = (remaining / limit) * 100;
      if (pct < worstPct) worstPct = pct;
    }
  }
  if (worstPct < 10) return 'red';
  if (worstPct < 50) return 'yellow';
  return 'green';
}

function createQuotaStore() {
  const quotas = {}; // provider -> quota entry

  function ensureEntry(provider) {
    if (!quotas[provider]) {
      quotas[provider] = {
        provider,
        limits: {},
        status: 'green',
        lastUpdated: null,
        source: null,
      };
    }
    return quotas[provider];
  }

  /**
   * Update quota from response headers.
   * Handles groq, cerebras, and openrouter header conventions.
   * @param {string} provider
   * @param {Object} headers — either a Headers object (.get) or plain object
   */
  function updateFromHeaders(provider, headers) {
    if (!provider || !headers) return;

    const get = typeof headers.get === 'function'
      ? (k) => headers.get(k)
      : (k) => headers[k];

    const entry = ensureEntry(provider);

    // RPM
    const limitReq = get('x-ratelimit-limit-requests');
    const remainReq = get('x-ratelimit-remaining-requests');
    const resetReq = get('x-ratelimit-reset-requests') || get('x-ratelimit-reset');

    if (remainReq != null) {
      if (!entry.limits.rpm) entry.limits.rpm = {};
      entry.limits.rpm.remaining = parseInt(remainReq, 10);
      if (limitReq != null) entry.limits.rpm.limit = parseInt(limitReq, 10);
      if (resetReq) {
        const parsed = parseResetValue(resetReq);
        if (parsed) entry.limits.rpm.resetsAt = parsed;
      }
    }

    // TPM
    const limitTok = get('x-ratelimit-limit-tokens');
    const remainTok = get('x-ratelimit-remaining-tokens');
    const resetTok = get('x-ratelimit-reset-tokens');

    if (remainTok != null) {
      if (!entry.limits.tpm) entry.limits.tpm = {};
      entry.limits.tpm.remaining = parseInt(remainTok, 10);
      if (limitTok != null) entry.limits.tpm.limit = parseInt(limitTok, 10);
      if (resetTok) {
        const parsed = parseResetValue(resetTok);
        if (parsed) entry.limits.tpm.resetsAt = parsed;
      }
    }

    entry.lastUpdated = new Date().toISOString();
    entry.source = 'headers';
    entry.status = computeStatus(entry.limits);
  }

  function record429(provider) {
    const entry = ensureEntry(provider);
    entry.status = 'red';
    entry.lastUpdated = new Date().toISOString();
  }

  function getQuota(provider) {
    return quotas[provider] || null;
  }

  function getAllQuotas() {
    return { ...quotas };
  }

  function isExhausted(provider) {
    const q = quotas[provider];
    if (!q || !q.limits) return false;
    return Object.values(q.limits).some(l => l.remaining === 0);
  }

  /**
   * Update from task history inference (for providers without headers).
   * @param {string} provider
   * @param {Object} usage — { tasksLastHour, tokensLastHour }
   * @param {Object} knownLimits — { rpm, tpd } known free-tier limits
   */
  function updateFromInference(provider, usage, knownLimits) {
    const entry = ensureEntry(provider);
    if (knownLimits.rpm && usage.tasksLastHour != null) {
      if (!entry.limits.rpm) entry.limits.rpm = {};
      entry.limits.rpm.limit = knownLimits.rpm;
      entry.limits.rpm.remaining = Math.max(0, knownLimits.rpm - usage.tasksLastHour);
    }
    if (knownLimits.tpd && usage.tokensLastHour != null) {
      if (!entry.limits.daily) entry.limits.daily = {};
      entry.limits.daily.limit = knownLimits.tpd;
      // Rough: extrapolate hourly to daily usage estimate
      entry.limits.daily.remaining = Math.max(0, knownLimits.tpd - usage.tokensLastHour * 24);
    }
    entry.lastUpdated = new Date().toISOString();
    entry.source = 'inference';
    entry.status = computeStatus(entry.limits);
  }

  return {
    updateFromHeaders,
    updateFromInference,
    record429,
    getQuota,
    getAllQuotas,
    isExhausted,
    // Exported for testing
    _parseResetValue: parseResetValue,
    _computeStatus: computeStatus,
  };
}

// Singleton instance
let _instance = null;
function getQuotaStore() {
  if (!_instance) _instance = createQuotaStore();
  return _instance;
}

module.exports = { createQuotaStore, getQuotaStore };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `./scripts/torque-test.sh npx vitest run server/tests/provider-quotas.test.js`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```
git add server/db/provider-quotas.js server/tests/provider-quotas.test.js
git commit -m "feat(quotas): provider quota store with header parsing + status computation"
```

---

### Task 2: Header capture in provider submit methods

**Files:**
- Modify: `server/providers/groq.js` — capture headers after `fetch()` response
- Modify: `server/providers/cerebras.js` — capture headers after `fetch()` response
- Modify: `server/providers/openrouter.js` — capture headers after `fetch()` response
- Modify: `server/providers/adapters/openai-chat.js` — capture headers for agentic path

- [ ] **Step 1: Add header capture to groq.js**

In `server/providers/groq.js`, after `const response = await fetch(...)` and before `if (!response.ok)`, add:

```js
      // Capture rate limit headers for quota monitoring
      try {
        const { getQuotaStore } = require('../db/provider-quotas');
        getQuotaStore().updateFromHeaders('groq', response.headers);
      } catch { /* non-critical */ }
```

Also in the error handler, after detecting a 429, add:

```js
      if (response.status === 429) {
        try { const { getQuotaStore } = require('../db/provider-quotas'); getQuotaStore().record429('groq'); } catch {}
      }
```

- [ ] **Step 2: Add header capture to cerebras.js**

Same pattern as groq.js but with `'cerebras'` as the provider name. Add after `const response = await fetch(...)`.

- [ ] **Step 3: Add header capture to openrouter.js**

Same pattern with `'openrouter'`.

- [ ] **Step 4: Add header capture to openai-chat.js (agentic path)**

In `server/providers/adapters/openai-chat.js`, the response comes via `http.request`. After `res.on('end', () => { ... })` parses the response, add header capture. The adapter receives the provider name in its options — use that to call:

```js
        // Capture rate limit headers (provider name comes from adapter options)
        try {
          const providerName = params.providerName || '';
          if (providerName) {
            const { getQuotaStore } = require('../../db/provider-quotas');
            getQuotaStore().updateFromHeaders(providerName, res.headers);
          }
        } catch { /* non-critical */ }
```

Then pass `providerName` from `execution.js` adapter options (add `providerName: provider` to the adapterOptions objects).

- [ ] **Step 5: Run existing provider tests to verify no regressions**

Run: `./scripts/torque-test.sh npx vitest run server/tests/groq-provider.test.js server/tests/cerebras-provider.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```
git add server/providers/groq.js server/providers/cerebras.js server/providers/openrouter.js server/providers/adapters/openai-chat.js
git commit -m "feat(quotas): capture rate limit headers from groq, cerebras, openrouter"
```

---

### Task 3: Routing integration — skip exhausted providers

**Files:**
- Modify: `server/db/provider-routing-core.js` — add quota check in chain iteration

- [ ] **Step 1: Write failing test**

Add to `server/tests/provider-routing-core.test.js`:

```js
  it('skips provider with exhausted quota in chain', () => {
    const { getQuotaStore } = require('../db/provider-quotas');
    const store = getQuotaStore();
    store.updateFromHeaders('cerebras', {
      'x-ratelimit-limit-requests': '30',
      'x-ratelimit-remaining-requests': '0',
    });
    // With cerebras exhausted, routing should fall to next in chain
    // (test depends on template having cerebras as primary in default)
  });
```

- [ ] **Step 2: Add quota check to chain iteration loops**

In `server/db/provider-routing-core.js`, at the top, add:

```js
let _quotaStore = null;
function getQuotaStoreIfAvailable() {
  if (!_quotaStore) {
    try { _quotaStore = require('./provider-quotas').getQuotaStore(); } catch { /* not initialized yet */ }
  }
  return _quotaStore;
}
```

Then in both template chain iteration loops (around lines 508-520 and 552-574), after checking `provConfig && provConfig.enabled`, add:

```js
        // Skip providers with exhausted quota
        const qs = getQuotaStoreIfAvailable();
        if (qs && qs.isExhausted(entry.provider || resolved.provider)) {
          logger.info(`[SmartRouting] Skipping ${entry.provider} — quota exhausted`);
          continue;
        }
```

- [ ] **Step 3: Run routing tests**

Run: `./scripts/torque-test.sh npx vitest run server/tests/provider-routing-core.test.js`
Expected: PASS

- [ ] **Step 4: Commit**

```
git add server/db/provider-routing-core.js server/tests/provider-routing-core.test.js
git commit -m "feat(quotas): routing skips providers with exhausted quota"
```

---

### Task 4: REST endpoint + dashboard inference timer

**Files:**
- Modify: `server/index.js` — init quota store, add inference timer, add REST route
- Modify: `server/dashboard/routes/infrastructure.js` or create inline route

- [ ] **Step 1: Add REST endpoint for quota data**

In `server/index.js` (or the appropriate dashboard route file), add:

```js
app.get('/api/provider-quotas', (req, res) => {
  try {
    const { getQuotaStore } = require('./db/provider-quotas');
    res.json(getQuotaStore().getAllQuotas());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 2: Add inference timer (5-minute cycle)**

In `server/index.js`, after server startup, add:

```js
// Provider quota inference timer (5-minute cycle for headerless providers)
const KNOWN_FREE_LIMITS = {
  'google-ai': { rpm: 15, tpd: 1000000 },
  'groq': { rpm: 30, tpd: 6000 },
  'cerebras': { rpm: 30, tpd: 1000000 },
};

setInterval(() => {
  try {
    const { getQuotaStore } = require('./db/provider-quotas');
    const store = getQuotaStore();
    for (const [provider, limits] of Object.entries(KNOWN_FREE_LIMITS)) {
      // Only infer for providers without fresh header data
      const existing = store.getQuota(provider);
      if (existing && existing.source === 'headers') continue;

      const hourAgo = new Date(Date.now() - 3600000).toISOString();
      const tasks = db.listTasks({ provider, since: hourAgo, status: 'completed', limit: 1000 });
      const taskArray = Array.isArray(tasks) ? tasks : (tasks?.tasks || []);
      const tokensLastHour = taskArray.reduce((sum, t) => {
        const meta = typeof t.metadata === 'string' ? JSON.parse(t.metadata || '{}') : (t.metadata || {});
        return sum + (meta.token_usage?.total_tokens || 0);
      }, 0);

      store.updateFromInference(provider, {
        tasksLastHour: taskArray.length,
        tokensLastHour,
      }, limits);
    }
  } catch (err) {
    console.error('[Quota Inference] Error:', err.message);
  }
}, 5 * 60 * 1000); // 5 minutes
```

- [ ] **Step 3: Commit**

```
git add server/index.js
git commit -m "feat(quotas): REST endpoint + inference timer for headerless providers"
```

---

### Task 5: Dashboard UI — inline bars + status badge

**Files:**
- Modify: `dashboard/src/views/Providers.jsx`
- Modify: `dashboard/src/api.js` (if needed — add `providerQuotas` fetch)

- [ ] **Step 1: Add quota fetch to loadData**

In `Providers.jsx`, add to the `Promise.all` in `loadData`:

```js
requestV2('/provider-quotas').catch(() => ({})),
```

Add state: `const [quotas, setQuotas] = useState({});`

Set it in loadData: `setQuotas(quotaData);`

- [ ] **Step 2: Create QuotaBar component**

Add above `ProviderCard`:

```jsx
function QuotaBar({ label, remaining, limit }) {
  if (remaining == null || !limit) return null;
  const pct = Math.round((remaining / limit) * 100);
  const color = pct > 50 ? 'bg-green-500' : pct > 10 ? 'bg-yellow-500' : 'bg-red-500';
  const display = limit >= 10000
    ? `${Math.round(remaining / 1000)}K/${Math.round(limit / 1000)}K`
    : `${remaining}/${limit}`;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-slate-500 w-8">{label}</span>
      <div className="flex-1 h-1.5 bg-slate-700 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-slate-400 w-16 text-right">{display}</span>
    </div>
  );
}
```

- [ ] **Step 3: Create StatusBadge component**

```jsx
function QuotaStatusBadge({ quota }) {
  if (!quota) return <span className="w-2.5 h-2.5 rounded-full bg-slate-600" title="No quota data" />;
  const colors = { green: 'bg-green-500', yellow: 'bg-yellow-500', red: 'bg-red-500' };
  const bgColor = colors[quota.status] || 'bg-slate-600';

  const lines = [];
  if (quota.limits?.rpm) {
    const pct = quota.limits.rpm.limit ? Math.round((quota.limits.rpm.remaining / quota.limits.rpm.limit) * 100) : '?';
    lines.push(`RPM: ${quota.limits.rpm.remaining}/${quota.limits.rpm.limit || '?'} (${pct}%)`);
  }
  if (quota.limits?.tpm) {
    const pct = quota.limits.tpm.limit ? Math.round((quota.limits.tpm.remaining / quota.limits.tpm.limit) * 100) : '?';
    lines.push(`TPM: ${quota.limits.tpm.remaining}/${quota.limits.tpm.limit || '?'} (${pct}%)`);
  }
  if (quota.limits?.daily) {
    lines.push(`Daily: ${quota.limits.daily.remaining}/${quota.limits.daily.limit || '?'}`);
  }
  if (quota.limits?.rpm?.resetsAt) {
    const resetMs = new Date(quota.limits.rpm.resetsAt).getTime() - Date.now();
    if (resetMs > 0) {
      const m = Math.floor(resetMs / 60000);
      const s = Math.floor((resetMs % 60000) / 1000);
      lines.push(`Resets in ${m}m ${s}s`);
    }
  }
  const tooltip = lines.join('\n') || 'Quota data available';

  return <span className={`w-2.5 h-2.5 rounded-full ${bgColor}`} title={tooltip} />;
}
```

- [ ] **Step 4: Wire into ProviderCard**

In the `ProviderCard` component, pass `quota` as a prop. Add the status badge next to the provider name, and quota bars after the stats grid:

In the card header (after the sparkline):
```jsx
<QuotaStatusBadge quota={quota} />
```

After the stats grid `</div>` (around line 117):
```jsx
{quota && Object.keys(quota.limits || {}).length > 0 && (
  <div className="mt-3 space-y-1.5">
    <QuotaBar label="RPM" remaining={quota.limits?.rpm?.remaining} limit={quota.limits?.rpm?.limit} />
    <QuotaBar label="TPM" remaining={quota.limits?.tpm?.remaining} limit={quota.limits?.tpm?.limit} />
    {quota.limits?.daily && (
      <QuotaBar label="Day" remaining={quota.limits.daily.remaining} limit={quota.limits.daily.limit} />
    )}
    <p className="text-[10px] text-slate-600">
      Updated {quota.lastUpdated ? `${Math.round((Date.now() - new Date(quota.lastUpdated).getTime()) / 1000)}s ago` : 'never'} ({quota.source || 'unknown'})
    </p>
  </div>
)}
```

Where the card is rendered in the provider list, pass quota:
```jsx
<ProviderCard ... quota={quotas[provider.provider]} />
```

- [ ] **Step 5: Build dashboard**

Run: `cd dashboard && npm run build`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```
git add dashboard/src/views/Providers.jsx dashboard/dist/
git commit -m "feat(quotas): dashboard inline bars + status badge on provider cards"
```
