# Version Control Plugin Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a TORQUE plugin for git worktree management, branch policies, and auto-generated commit messages that works with any git repository.

**Architecture:** A plugin at `server/plugins/version-control/` implementing the TORQUE plugin contract. Four core modules (config-resolver, worktree-manager, commit-generator, policy-engine), 8 MCP tools, REST endpoints, and a dashboard tab in OperationsHub. DB-tracked worktrees in `vc_worktrees` and `vc_commits` tables. Auto-loaded on server startup via `DEFAULT_PLUGIN_NAMES`. All git operations use `execFileSync` (not exec) to prevent shell injection.

**Tech Stack:** Node.js, better-sqlite3, child_process.execFileSync for git, React (JSX), Vitest

**Spec:** `docs/superpowers/specs/2026-03-30-version-control-plugin-phase1-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `server/plugins/version-control/config-resolver.js` | Create | Per-repo + global config loading and merge |
| `server/plugins/version-control/worktree-manager.js` | Create | Worktree CRUD, DB tracking, stale detection |
| `server/plugins/version-control/commit-generator.js` | Create | Diff analysis, type/scope detection, message generation |
| `server/plugins/version-control/policy-engine.js` | Create | Branch policy evaluation and required checks |
| `server/plugins/version-control/tool-defs.js` | Create | 8 MCP tool schemas |
| `server/plugins/version-control/handlers.js` | Create | MCP tool handlers |
| `server/plugins/version-control/index.js` | Create | Plugin entry with contract implementation |
| `server/plugins/version-control/tests/config-resolver.test.js` | Create | Config tests |
| `server/plugins/version-control/tests/worktree-manager.test.js` | Create | Worktree tests |
| `server/plugins/version-control/tests/commit-generator.test.js` | Create | Commit generator tests |
| `server/plugins/version-control/tests/policy-engine.test.js` | Create | Policy engine tests |
| `server/plugins/version-control/tests/plugin.test.js` | Create | Plugin contract integration test |
| `server/index.js` | Modify | Add version-control to DEFAULT_PLUGIN_NAMES |
| `dashboard/src/views/VersionControl.jsx` | Create | Dashboard tab view |
| `dashboard/src/views/OperationsHub.jsx` | Modify | Add Version Control tab |
| `dashboard/src/api.js` | Modify | Add VC API calls |
| `server/dashboard/router.js` | Modify | Add VC REST routes |

---

### Task 1: Config Resolver

**Files:**
- Create: `server/plugins/version-control/config-resolver.js`
- Create: `server/plugins/version-control/tests/config-resolver.test.js`

- [ ] **Step 1: Write failing test**

Create test file using Vitest globals (NOT require('vitest')). Use fs.mkdtempSync for temp dirs. Tests: getGlobalDefaults returns built-in defaults when no file exists; getEffectiveConfig returns global defaults for repo with no local config; getEffectiveConfig merges local over global; getEffectiveConfig inherits missing keys from global; invalidateCache forces re-read; getEffectiveConfig caches; handles malformed JSON gracefully.

- [ ] **Step 2: Implement config-resolver.js**

Export createConfigResolver() factory. Built-in defaults hardcoded. getGlobalDefaults reads ~/.torque/vc-defaults.json or returns built-ins. getEffectiveConfig reads .torque-vc.json from repo root, deep-merges with global, caches by repoPath. invalidateCache deletes cache entry.

- [ ] **Step 3: Run tests, verify pass**
- [ ] **Step 4: Commit**

---

### Task 2: Worktree Manager

**Files:**
- Create: `server/plugins/version-control/worktree-manager.js`
- Create: `server/plugins/version-control/tests/worktree-manager.test.js`

- [ ] **Step 1: Write failing test**

In-memory SQLite with vc_worktrees table in beforeEach. Mock execFileSync for git commands. Tests: createWorktree inserts record; listWorktrees returns all sorted by created_at DESC; listWorktrees filters by repoPath; getWorktree returns single or null; recordActivity updates last_activity_at and increments commit_count; cleanupWorktree removes DB record; stale detection marks old worktrees; cleanupStale dry run does not delete.

- [ ] **Step 2: Implement worktree-manager.js**

Export createWorktreeManager({ db }) factory. Uses execFileSync('git', [...], { cwd, windowsHide: true }) for git operations. createWorktree runs git worktree add, inserts DB record. mergeWorktree runs git merge/squash/rebase based on strategy. syncWithGit parses git worktree list --porcelain and reconciles with DB.

- [ ] **Step 3: Run tests, verify pass**
- [ ] **Step 4: Commit**

---

### Task 3: Commit Generator

**Files:**
- Create: `server/plugins/version-control/commit-generator.js`
- Create: `server/plugins/version-control/tests/commit-generator.test.js`

- [ ] **Step 1: Write failing test**

No DB, no real git. Mock execFileSync for git diff. Tests: analyzeChanges detects feat for new files in src/; detects test for files in tests/; detects docs for .md files; detects chore for package.json; detects style for .css; detects fix for small source modifications; scope detection for single directory; scope omitted for multiple dirs; generateCommitMessage produces conventional format; includes body when multiple files changed.

- [ ] **Step 2: Implement commit-generator.js**

Export createCommitGenerator() factory. analyzeChanges applies type heuristics: test > docs > style > chore > feat (new) > refactor (large) > fix (small). Scope from most common directory. generateCommitMessage calls git diff --staged, analyzes, formats conventional commit, executes git commit -m, returns result with commitHash.

- [ ] **Step 3: Run tests, verify pass**
- [ ] **Step 4: Commit**

---

### Task 4: Policy Engine

**Files:**
- Create: `server/plugins/version-control/policy-engine.js`
- Create: `server/plugins/version-control/tests/policy-engine.test.js`

- [ ] **Step 1: Write failing test**

Mock configResolver. Tests: validateBeforeCommit blocks protected branch; allows feature branch; respects policy mode; validateBranchName accepts feat/my-feature; rejects random-branch with suggestion; validateBeforeMerge runs required checks; blocks when check fails (block mode); warns when check fails (warn mode); runRequiredChecks executes commands and returns results.

- [ ] **Step 2: Implement policy-engine.js**

Export createPolicyEngine({ configResolver }) factory. Each validate function reads effective config, evaluates rules, returns { allowed, violations }. runRequiredChecks runs each command via execFileSync with timeout.

- [ ] **Step 3: Run tests, verify pass**
- [ ] **Step 4: Commit**

---

### Task 5: MCP Tools and Handlers

**Files:**
- Create: `server/plugins/version-control/tool-defs.js`
- Create: `server/plugins/version-control/handlers.js`

- [ ] **Step 1: Create tool definitions**

8 tools: vc_create_worktree, vc_list_worktrees, vc_switch_worktree, vc_merge_worktree, vc_cleanup_stale, vc_generate_commit, vc_commit_status, vc_get_policy. Each with name, description, inputSchema.

- [ ] **Step 2: Create handlers**

Export handler functions. Each receives args, calls the appropriate module, returns MCP response format. Handlers receive services via closure from install(). vc_generate_commit also records in vc_commits table.

- [ ] **Step 3: Commit**

---

### Task 6: Plugin Entry

**Files:**
- Create: `server/plugins/version-control/index.js`
- Create: `server/plugins/version-control/tests/plugin.test.js`
- Modify: `server/index.js`

- [ ] **Step 1: Create plugin entry**

Implements TORQUE plugin contract. On install(container): get db, create tables (vc_worktrees, vc_commits) with CREATE TABLE IF NOT EXISTS, instantiate all 4 modules, wire handlers. mcpTools() returns tool-defs with handlers. uninstall() nulls all references.

- [ ] **Step 2: Add to DEFAULT_PLUGIN_NAMES**

In server/index.js line 56, add 'version-control' to the array.

- [ ] **Step 3: Write plugin integration test**

Tests: passes contract validation; correct name and version; install without error; mcpTools returns 8 tools after install; uninstall cleans up; mcpTools returns empty after uninstall.

- [ ] **Step 4: Run tests, verify pass**
- [ ] **Step 5: Commit**

---

### Task 7: Dashboard — Version Control Tab

**Files:**
- Create: `dashboard/src/views/VersionControl.jsx`
- Modify: `dashboard/src/views/OperationsHub.jsx`
- Modify: `dashboard/src/api.js`
- Modify: `server/dashboard/router.js`

- [ ] **Step 1: Add REST routes to dashboard router**

GET /api/version-control/worktrees, GET /api/version-control/commits, DELETE /api/version-control/worktrees/:id, POST /api/version-control/worktrees/:id/merge.

- [ ] **Step 2: Add API calls to dashboard api.js**

versionControl namespace with getWorktrees, getCommits, deleteWorktree, mergeWorktree.

- [ ] **Step 3: Create VersionControl.jsx**

React component: StatCards row (Active Worktrees, Stale Worktrees, Commits Today, Policy Violations), Worktrees table with status badges and actions, Recent Commits section with type badges. Uses StatCard, LoadingSkeleton, useToast.

- [ ] **Step 4: Add tab to OperationsHub.jsx**

Lazy import, add to TABS array, add render case.

- [ ] **Step 5: Commit**

---

## Dependency Graph

```
Task 1 (config-resolver) ──┐
                            ├── Task 4 (policy-engine)
Task 2 (worktree-manager) ──┤
                            ├── Task 5 (tools + handlers) ── Task 6 (plugin entry)
Task 3 (commit-generator) ──┘                                       |
                                                                    └── Task 7 (dashboard)
```

- Tasks 1, 2, 3 are independent and can run in parallel
- Task 4 depends on Task 1 (policy engine needs config resolver)
- Task 5 depends on Tasks 1-4 (handlers call all modules)
- Task 6 depends on Task 5 (plugin wires everything)
- Task 7 depends on Task 6 (dashboard needs REST routes from plugin)
