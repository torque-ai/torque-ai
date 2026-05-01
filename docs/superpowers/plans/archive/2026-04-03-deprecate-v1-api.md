# Deprecate V1 Dashboard API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the v1 `request()` function from the dashboard API client, routing all 23 remaining calls through `requestV2()` with v2 envelope unwrapping.

**Architecture:** Rather than modifying 30+ server handlers to wrap responses, we add v2 passthrough routes for the ~15 v1-only endpoints in `routes-passthrough.js` (one line each). Then switch all 23 `request()` calls to `requestV2()` and remove the `request()` function. The passthrough routes call the existing v1 handler and wrap the response in `{data: ...}` automatically.

**Tech Stack:** Node.js server (CommonJS), React dashboard (ESM)

---

## File Map

| File | Responsibility | Action |
|------|---------------|--------|
| `dashboard/src/api.js` | API client | Modify: switch 23 calls, remove `request()` |
| `server/dashboard/router.js` | V1 dashboard API routes | Modify: export handler functions for passthrough |
| `server/api/routes-passthrough.js` | V2 passthrough route definitions | Modify: add ~15 passthrough entries |
| `dashboard/src/api.test.js` | API client tests | Modify: remove `request` mock, update imports |
| `dashboard/src/App.test.jsx` | App tests | Modify: remove `request` mock |
| `dashboard/src/views/*.test.jsx` | View tests | Modify: remove `request` mock from any that have it |

---

## Task 1: Add V2 Passthrough Routes for V1-Only Endpoints

**Files:**
- Modify: `server/api/routes-passthrough.js`
- Modify: `server/dashboard/router.js` (export handler references)

The passthrough route system already exists — it maps `{ method, path, handler }` entries that auto-wrap responses in v2 envelopes. We add entries for each v1-only endpoint.

- [ ] **Step 1: Check existing passthrough pattern**

Read `server/api/routes-passthrough.js` to understand the existing format. Each entry maps a v2 path to a handler function or MCP tool name.

- [ ] **Step 2: Add governance routes**

In `routes-passthrough.js`, add passthrough entries for governance endpoints. The v1 handlers are in `server/dashboard/router.js`. Add:

```js
{ method: 'GET', path: '/api/v2/governance/rules', handler: 'handleGovernanceRulesRoute', mapQuery: true },
{ method: 'PUT', path: /^\/api\/v2\/governance\/rules\/([^/]+)$/, handler: 'handleGovernanceUpdateRoute', mapParams: ['id'], mapBody: true },
{ method: 'POST', path: /^\/api\/v2\/governance\/rules\/([^/]+)\/reset$/, handler: 'handleGovernanceResetRoute', mapParams: ['id'] },
```

- [ ] **Step 3: Add version-control routes**

```js
{ method: 'GET', path: '/api/v2/version-control/worktrees', handler: 'handleGetVersionControlWorktreesRoute' },
{ method: 'GET', path: '/api/v2/version-control/commits', handler: 'handleGetVersionControlCommitsRoute', mapQuery: true },
{ method: 'GET', path: '/api/v2/version-control/releases', handler: 'handleGetVersionControlReleasesRoute', mapQuery: true },
{ method: 'POST', path: '/api/v2/version-control/releases', handler: 'handleCreateVersionControlReleaseRoute', mapBody: true },
{ method: 'DELETE', path: /^\/api\/v2\/version-control\/worktrees\/([^/]+)$/, handler: 'handleDeleteVersionControlWorktreeRoute', mapParams: ['id'] },
{ method: 'POST', path: /^\/api\/v2\/version-control\/worktrees\/([^/]+)\/merge$/, handler: 'handleMergeVersionControlWorktreeRoute', mapParams: ['id'], mapBody: true },
```

- [ ] **Step 4: Add coordination routes**

```js
{ method: 'GET', path: '/api/v2/coordination', handler: 'handleCoordinationDashboardRoute', mapQuery: true },
{ method: 'GET', path: '/api/v2/coordination/agents', handler: 'handleCoordinationAgentsRoute' },
{ method: 'GET', path: '/api/v2/coordination/rules', handler: 'handleCoordinationRulesRoute' },
{ method: 'GET', path: '/api/v2/coordination/claims', handler: 'handleCoordinationClaimsRoute' },
```

- [ ] **Step 5: Add remaining routes**

```js
{ method: 'GET', path: '/api/v2/hosts/activity', handler: 'handleHostActivityRoute', mapQuery: true },
{ method: 'GET', path: '/api/v2/instances', handler: 'handleInstancesRoute', mapQuery: true },
{ method: 'GET', path: /^\/api\/v2\/project-tuning\/(.+)$/, handler: 'handleProjectTuningRoute', mapParams: ['projectPath'] },
{ method: 'GET', path: /^\/api\/v2\/providers\/([^/]+)\/percentiles$/, handler: 'handleProviderPercentilesRoute', mapParams: ['id'], mapQuery: true },
```

- [ ] **Step 6: Commit**

```
git add server/api/routes-passthrough.js server/dashboard/router.js
git commit -m "feat: add v2 passthrough routes for 15 v1-only dashboard endpoints"
```

---

## Task 2: Migrate All 23 request() Calls to requestV2()

**Files:**
- Modify: `dashboard/src/api.js`

- [ ] **Step 1: Migrate Group 1 — endpoints with existing v2 routes (4 calls)**

```js
// tasks.cancel — line ~178
cancel: (id) => requestV2(`/tasks/${id}/cancel`, { method: 'POST' }),

// strategic.operations — line ~510
operations: (limit = 20) => requestV2(`/strategic/operations?limit=${limit}`),

// providers.percentiles — line ~193
percentiles: (id, days = 7) => requestV2(`/providers/${id}/percentiles?days=${days}`),

// workflows.tasks — line ~419
tasks: (id) => requestV2(`/workflows/${id}/tasks`),
```

- [ ] **Step 2: Migrate Group 2 — governance (3 calls)**

```js
getRules: (params) => requestV2('/governance/rules' + buildQuery(params)),
updateRule: (id, body) => requestV2('/governance/rules/' + id, {
  method: 'PUT', body: JSON.stringify(body),
}),
resetViolations: (id) => requestV2('/governance/rules/' + id + '/reset', {
  method: 'POST',
}),
```

- [ ] **Step 3: Migrate Group 2 — version control (6 calls)**

```js
getWorktrees: () => requestV2('/version-control/worktrees'),
getCommits: (days = 7) => requestV2('/version-control/commits?days=' + days),
getReleases: (repoPath) => requestV2('/version-control/releases' + (repoPath ? '?repo_path=' + encodeURIComponent(repoPath) : '')),
createRelease: (body) => requestV2('/version-control/releases', {
  method: 'POST', body: JSON.stringify(body),
}),
deleteWorktree: (id) => requestV2('/version-control/worktrees/' + id, { method: 'DELETE' }),
mergeWorktree: (id, opts = {}) => requestV2('/version-control/worktrees/' + id + '/merge', {
  method: 'POST', body: JSON.stringify(opts),
}),
```

- [ ] **Step 4: Migrate Group 2 — coordination (4 calls)**

```js
getDashboard: (hours = 24) => requestV2(`/coordination?hours=${hours}`),
listAgents: () => requestV2('/coordination/agents'),
listRules: () => requestV2('/coordination/rules'),
listClaims: () => requestV2('/coordination/claims'),
```

- [ ] **Step 5: Migrate Group 2 — hosts, instances, project tuning (3 calls)**

```js
// hosts
activity: (options) => requestV2('/hosts/activity', options),

// instances
list: (options) => requestV2('/instances', options),

// projectTuning
get: (projectPath) => requestV2(`/project-tuning/${encodeURIComponent(projectPath)}`),
```

- [ ] **Step 6: Migrate Group 3 — legacy free tier (2 calls)**

```js
status: () => requestV2('/provider-quotas/status'),
history: (days = 7) => requestV2('/provider-quotas/history?days=' + days),
```

Note: the legacy free tier paths use a different base (`/provider-quotas`). These need passthrough routes too (add in Task 1 if not already covered).

- [ ] **Step 7: Remove the request() function and API_BASE constant**

Delete lines 9, 44-49 from api.js:
```js
// DELETE: const API_BASE = '/api';
// DELETE: export async function request(endpoint, options = {}) { ... }
```

Also remove `request` from the default export at the bottom of the file.

- [ ] **Step 8: Commit**

```
git add dashboard/src/api.js
git commit -m "feat: migrate all 23 v1 request() calls to requestV2() and remove request()"
```

---

## Task 3: Update Test Mocks

**Files:**
- Modify: `dashboard/src/App.test.jsx`
- Modify: `dashboard/src/api.test.js`
- Modify: Any view test files that mock `request`

- [ ] **Step 1: Find all test files that mock request**

```
grep -r "request:" dashboard/src --include="*.test.*" -l
grep -r "request: vi.fn" dashboard/src --include="*.test.*" -l
```

- [ ] **Step 2: Remove request mock from each file**

In each vi.mock('../api', ...) block, remove the `request: vi.fn().mockResolvedValue({}),` line. The `requestV2` mock already exists and handles everything.

- [ ] **Step 3: Verify tests pass**

```
torque-remote npm run test --prefix dashboard
```

- [ ] **Step 4: Commit**

```
git add dashboard/src
git commit -m "test: remove v1 request() mocks from dashboard tests"
```

---

## Task 4: Verify and Clean Up

- [ ] **Step 1: Verify no request() usage remains**

```
grep -n "request(" dashboard/src/api.js | grep -v requestV2 | grep -v "_fetch"
```

Expected: no matches.

- [ ] **Step 2: Build the dashboard**

```
cd dashboard && npx vite build
```

- [ ] **Step 3: Restart TORQUE (server changes)**

```
await_restart — load new passthrough routes
```

- [ ] **Step 4: Visual verification**

Check each affected view loads:
- Governance tab in Operations
- Version Control tab in Operations
- Coordination tab (if visible)
- Hosts activity
- Kanban (uses timeseries, already v2)

- [ ] **Step 5: Run full test suite**

```
torque-remote npm run test --prefix dashboard
torque-remote npm run test --prefix server
```

- [ ] **Step 6: Final commit and push**

```
git add -f dashboard/dist/
git commit -m "chore: rebuild dashboard dist — v1 API fully deprecated"
git push origin main
```
