# Software Factory Phase 4: Trust & Policy Framework — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-project policy configuration (budget ceilings, scope limits, blast radius, restricted paths, escalation rules, work hours, provider restrictions) to the existing factory project registry, with MCP tools and dashboard UI for policy management.

**Architecture:** Policy data lives in the existing `factory_projects.config_json` column (no migration needed). A policy module (`server/factory/policy-engine.js`) validates and enforces policies. New MCP tools expose `set_project_policy` and `get_project_policy`. The Factory dashboard gets a policy configuration panel.

**Tech Stack:** better-sqlite3 (existing), vitest (existing), React (dashboard)

**What already exists:** Trust levels (supervised/guided/autonomous/dark), kill switch (pause_project/resume_project/pause_all_projects), factory_status — all built in Phase 1.

---

## File Structure

```
server/factory/policy-engine.js          # Policy schema, validation, enforcement checks
server/db/factory-health.js              # Modify: add policy getter/setter helpers
server/handlers/factory-handlers.js      # Modify: add policy handlers
server/tool-defs/factory-defs.js         # Modify: add policy tool definitions
server/core-tools.js                     # Modify: add to tiers
server/tool-annotations.js              # Modify: add annotations
server/api-server.core.js               # Modify: add REST routes
dashboard/src/views/Factory.jsx          # Modify: add policy config panel
dashboard/src/api.js                     # Modify: add policy API methods
server/tests/factory-policy.test.js      # Tests
```

---

### Task 1: Policy Engine Module

Create `server/factory/policy-engine.js`. This module defines the policy schema, validates policy objects, and provides enforcement check functions.

Default policy (applied when no policy is configured):
```js
{
  budget_ceiling: null,           // no limit
  scope_ceiling: { max_tasks: 20, max_files_per_task: 10 },
  blast_radius_percent: 5,        // max 5% of codebase per batch
  restricted_paths: [],           // files/dirs requiring approval
  required_checks: [],            // verification commands
  escalation_rules: {
    security_findings: true,      // always escalate
    health_drop_threshold: 10,    // escalate if any dimension drops by 10+
    breaking_changes: true,
    budget_warning_percent: 80,   // warn at 80% of ceiling
  },
  work_hours: null,               // no restriction (null = 24/7)
  provider_restrictions: [],      // empty = all providers allowed
}
```

Exports:
- `DEFAULT_POLICY` — the default object above
- `validatePolicy(policy)` — returns `{ valid: true }` or `{ valid: false, errors: [...] }`
- `mergeWithDefaults(policy)` — deep merge user policy with defaults
- `checkScopeAllowed(policy, taskCount)` — returns `{ allowed: true }` or `{ allowed: false, reason: string }`
- `checkBlastRadius(policy, filesChanged, totalFiles)` — returns `{ allowed: true }` or `{ allowed: false, reason, percent }`
- `checkRestrictedPaths(policy, filePaths)` — returns `{ restricted: [...matching paths] }` or `{ restricted: [] }`
- `checkWorkHours(policy)` — returns `{ allowed: true }` or `{ allowed: false, reason, next_window }`
- `checkProviderAllowed(policy, provider)` — returns `{ allowed: true }` or `{ allowed: false, reason }`
- `shouldEscalate(policy, event)` — returns `{ escalate: true, reason }` or `{ escalate: false }`

After creating the file, stop.

---

### Task 2: Policy Helpers in factory-health.js

Modify `server/db/factory-health.js` to add two helper functions for policy CRUD:

- `getProjectPolicy(projectId)` — reads config_json, parses it, returns the policy object merged with defaults. If no config_json or no policy key, returns DEFAULT_POLICY.
- `setProjectPolicy(projectId, policy)` — validates via validatePolicy, merges with defaults, stores in config_json.policy, updates updated_at.

These use the existing `config_json` column — no migration needed.

After making the edits, stop.

---

### Task 3: MCP Tools + Handlers + Wiring

Add 2 tools:

**`set_project_policy`** — Configure policy overrides for a factory project.
- Input: `{ project: string, policy: object }` where policy can contain any subset of policy fields
- Validates, merges with defaults, stores

**`get_project_policy`** — Get the current policy for a factory project.
- Input: `{ project: string }`
- Returns the full merged policy

Add handlers in factory-handlers.js. Add to TIER_2. Add annotations. Add REST routes:
```
GET  /api/v2/factory/projects/:id/policy  → get_project_policy
PUT  /api/v2/factory/projects/:id/policy  → set_project_policy
```

After making the edits, stop.

---

### Task 4: Dashboard Policy Panel

Add a policy configuration section to Factory.jsx (visible when a project is selected). Shows:
- Current trust level with change dropdown
- Budget ceiling input
- Scope ceiling (max tasks, max files) inputs
- Blast radius percentage slider
- Restricted paths as a tag list with add/remove
- Required checks as a tag list
- Escalation rule toggles
- Work hours selector (or "24/7" toggle)
- Provider restrictions as checkboxes
- Save button that calls set_project_policy

Add policy API methods to api.js.

After making the edits, stop.

---

### Task 5: Tests

Create `server/tests/factory-policy.test.js` testing:
- DEFAULT_POLICY has expected shape
- validatePolicy accepts valid policies, rejects invalid
- mergeWithDefaults fills gaps with defaults
- checkScopeAllowed enforces max_tasks
- checkBlastRadius enforces percentage limit
- checkRestrictedPaths detects restricted file matches
- checkWorkHours allows/denies based on time window
- checkProviderAllowed enforces restrictions
- shouldEscalate returns true for security findings
- Handler: get/set policy round-trip
- Integration: policy stored in config_json and retrieved correctly

After creating the file, stop.
