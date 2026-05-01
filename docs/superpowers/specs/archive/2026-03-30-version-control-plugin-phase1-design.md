# Version Control Plugin — Phase 1 Design Spec

**Date:** 2026-03-30
**Status:** Approved
**Goal:** A TORQUE plugin that provides git worktree management, branch policies, and auto-generated commit messages for any git repository. Phase 1 covers the day-to-day development workflow.

---

## Problem

Git worktree workflows, branch policies, and commit message conventions are currently either manual or project-specific (TORQUE's own worktree scripts only work for TORQUE). There's no general-purpose system that tracks worktree state, enforces branch policies, auto-generates commit messages, and provides dashboard visibility across all projects.

## Solution

A TORQUE plugin at `server/plugins/version-control/` that works with any git repository. Worktree state is tracked in the database for cross-session awareness and dashboard integration. Branch policies are configurable per-repo via `.torque-vc.json` with global defaults inheritance. Commit messages are auto-generated from staged diffs using file path heuristics.

---

## Architecture

### Plugin Contract

The plugin implements the standard TORQUE plugin contract: `name`, `version`, `install`, `uninstall`, `middleware`, `mcpTools`, `eventHandlers`, `configSchema`. On install, it creates database tables and seeds global defaults. MCP tools are the primary interface.

### Scope

- Works with any git repository on the machine (not limited to TORQUE-managed projects)
- Only requires a valid `.git` directory
- No dependency on `set_project_defaults` or TORQUE project registration

---

## Components

### 1. Worktree Manager (`worktree-manager.js`)

Export `createWorktreeManager({ db })` factory.

Functions:
- `createWorktree(repoPath, featureName, options)` — runs `git worktree add`, registers in `vc_worktrees` table. Options: `baseBranch` (default: 'main'), `worktreeDir` (default: '.worktrees'). Returns worktree record.
- `listWorktrees(repoPath?)` — returns all tracked worktrees, optionally filtered by repo. Includes computed `isStale` flag.
- `getWorktree(id)` — single worktree record or null.
- `mergeWorktree(id, options)` — merge the feature branch back to its base branch. Runs policy checks first. Options: `strategy` (merge/squash/rebase), `deleteAfter` (default: true). Returns merge result.
- `cleanupWorktree(id)` — remove worktree directory, delete branch, remove DB record.
- `cleanupStale(thresholdDays)` — find and remove worktrees with no commits beyond threshold.
- `recordActivity(id)` — update `last_activity_at` and increment `commit_count`.
- `syncWithGit(repoPath)` — reconcile DB state with `git worktree list` output (handle manual deletions).

### 2. Commit Generator (`commit-generator.js`)

Export `createCommitGenerator()` factory (no DB dependency — pure utility).

Functions:
- `generateCommitMessage(repoPath, options)` — analyzes `git diff --staged` in the given repo. Returns `{ type, scope, subject, body, fullMessage }`.
- `analyzeChanges(diffStat, filePaths)` — categorizes changes by examining file paths and diff content. Returns `{ type, scope, filesChanged, summary }`.

Type detection heuristics (no LLM, pure file path analysis):
- `feat` — new files in src/, lib/, app/, components/
- `fix` — modifications to existing source files with small diffs
- `test` — files in tests/, __tests__/, *.test.*, *.spec.*
- `docs` — *.md, docs/, README
- `refactor` — large modifications to existing source (>50% of file changed)
- `chore` — config files, package.json, .gitignore, scripts/
- `style` — *.css, *.scss, *.less

Scope detection: extracted from the most common directory among changed files. If all changes are in `server/db/`, scope is `db`. If spread across directories, scope is omitted.

Commit message format (conventional commits):
```
<type>(<scope>): <subject>

<body — optional, lists key changes>
```

### 3. Branch Policy Engine (`policy-engine.js`)

Export `createPolicyEngine({ configResolver })` factory.

Functions:
- `validateBeforeCommit(repoPath, branch)` — checks if branch is protected. Returns `{ allowed, violations }`.
- `validateBeforeMerge(repoPath, sourceBranch, targetBranch)` — runs all pre-merge checks. Returns `{ allowed, violations, checksRun }`.
- `runRequiredChecks(repoPath, checks)` — executes each command in the `require_before_merge` array. Returns `{ allPassed, results }`.
- `validateBranchName(branch, allowedPrefixes)` — checks branch matches one of the configured prefixes. Returns `{ valid, suggestion }`.

Policy rules:
- **Protected branches** — block direct commits to listed branches (default: main, master). Mode: block.
- **Branch naming** — require branches to start with a configured prefix. Mode: warn.
- **Required checks before merge** — run test/lint/type-check commands before allowing merge. Mode: block.
- **Merge strategy** — enforce merge, squash, or rebase. Mode: warn.

Each rule has a configurable mode (block/warn/shadow/off) following the governance pattern.

### 4. Config Resolver (`config-resolver.js`)

Export `createConfigResolver()` factory.

Functions:
- `getEffectiveConfig(repoPath)` — reads `~/.torque/vc-defaults.json` (global), reads `.torque-vc.json` from repo root (local), merges with local overriding global. Caches result per repoPath.
- `getGlobalDefaults()` — returns global config or built-in defaults if file doesn't exist.
- `invalidateCache(repoPath)` — clear cached config for a repo.

Default global config (`~/.torque/vc-defaults.json`):
```json
{
  "protected_branches": ["main", "master"],
  "branch_prefix": ["feat/", "fix/", "chore/", "refactor/", "test/", "docs/"],
  "merge_strategy": "merge",
  "require_before_merge": [],
  "stale_threshold_days": 7,
  "commit_format": "conventional",
  "worktree_dir": ".worktrees",
  "policy_modes": {
    "protected_branches": "block",
    "branch_naming": "warn",
    "required_checks": "block",
    "merge_strategy": "warn"
  }
}
```

Per-repo `.torque-vc.json` overrides any key. Missing keys inherit from global.

---

## MCP Tools (8 tools)

### Worktree Management

**`vc_create_worktree`**
- Input: `{ repo_path: string, feature_name: string, base_branch?: string }`
- Creates worktree, registers in DB, returns worktree record with path
- Validates branch name against policy

**`vc_list_worktrees`**
- Input: `{ repo_path?: string, include_stale?: boolean }`
- Returns all tracked worktrees with status, branch, last activity, stale flag

**`vc_switch_worktree`**
- Input: `{ worktree_id: string }`
- Returns the worktree path for Claude to use as working directory
- Updates last_activity_at

**`vc_merge_worktree`**
- Input: `{ worktree_id: string, strategy?: string, delete_after?: boolean }`
- Runs policy checks (required checks, merge strategy)
- Merges branch, optionally deletes worktree
- Returns merge result with any policy warnings

**`vc_cleanup_stale`**
- Input: `{ repo_path?: string, threshold_days?: number, dry_run?: boolean }`
- Lists or removes stale worktrees

### Commit

**`vc_generate_commit`**
- Input: `{ repo_path: string, override_message?: string }`
- Analyzes staged diff, generates conventional commit message
- Executes the commit
- Records in vc_commits table
- Returns the commit message and hash

**`vc_commit_status`**
- Input: `{ repo_path: string }`
- Returns staged, unstaged, untracked file counts with commit readiness summary

### Config

**`vc_get_policy`**
- Input: `{ repo_path: string }`
- Returns effective merged policy for the repo (global + local)

---

## Database

```sql
CREATE TABLE IF NOT EXISTS vc_worktrees (
  id TEXT PRIMARY KEY,
  repo_path TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_branch TEXT NOT NULL DEFAULT 'main',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
  merged_at TEXT,
  commit_count INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_vc_worktrees_repo ON vc_worktrees(repo_path);
CREATE INDEX IF NOT EXISTS idx_vc_worktrees_status ON vc_worktrees(status);

CREATE TABLE IF NOT EXISTS vc_commits (
  id TEXT PRIMARY KEY,
  repo_path TEXT NOT NULL,
  worktree_id TEXT,
  branch TEXT NOT NULL,
  commit_hash TEXT NOT NULL,
  commit_type TEXT NOT NULL,
  scope TEXT,
  message TEXT NOT NULL,
  files_changed INTEGER DEFAULT 0,
  generated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vc_commits_repo ON vc_commits(repo_path);
CREATE INDEX IF NOT EXISTS idx_vc_commits_type ON vc_commits(commit_type);
```

---

## Dashboard Integration

### OperationsHub Tab

A **Version Control** tab added to OperationsHub alongside existing tabs (Routing, Schedules, Approvals, Coordination, Budget, Governance).

**StatCards row:**
- Active Worktrees — count of status='active'
- Stale Worktrees — count where last_activity_at older than threshold
- Commits Today — count from vc_commits where generated_at is today
- Policy Violations — count of blocked/warned merge attempts (from governance evaluation store)

**Worktrees table:**
- Columns: Repo, Branch, Base, Status, Created, Last Activity, Commits, Actions
- Status badges: active (blue), stale (yellow), merged (green)
- Actions: Merge, Cleanup (with confirmation)

**Recent Commits section:**
- Last 10 auto-generated commits across all repos
- Type badges (feat=blue, fix=red, refactor=yellow, test=green, docs=gray, chore=gray)
- Commit hash (linked), scope, message, repo

### REST Endpoints

- `GET /api/version-control/worktrees` — list tracked worktrees (query: `?repo_path=&status=`)
- `GET /api/version-control/worktrees/:id` — single worktree details
- `DELETE /api/version-control/worktrees/:id` — cleanup a worktree
- `POST /api/version-control/worktrees/:id/merge` — trigger merge
- `GET /api/version-control/commits` — recent auto-generated commits (query: `?repo_path=&limit=`)

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `server/plugins/version-control/index.js` | Create | Plugin entry — contract implementation |
| `server/plugins/version-control/worktree-manager.js` | Create | Worktree CRUD + DB tracking |
| `server/plugins/version-control/commit-generator.js` | Create | Diff analysis + message generation |
| `server/plugins/version-control/policy-engine.js` | Create | Branch policy evaluation |
| `server/plugins/version-control/config-resolver.js` | Create | Per-repo + global config merge |
| `server/plugins/version-control/tool-defs.js` | Create | 8 MCP tool schemas |
| `server/plugins/version-control/handlers.js` | Create | MCP tool handlers |
| `server/plugins/version-control/tests/worktree-manager.test.js` | Create | Worktree tests |
| `server/plugins/version-control/tests/commit-generator.test.js` | Create | Commit generator tests |
| `server/plugins/version-control/tests/policy-engine.test.js` | Create | Policy engine tests |
| `server/plugins/version-control/tests/config-resolver.test.js` | Create | Config resolver tests |
| `server/plugins/version-control/tests/plugin.test.js` | Create | Plugin contract integration test |
| `dashboard/src/views/VersionControl.jsx` | Create | Dashboard tab |
| `dashboard/src/views/OperationsHub.jsx` | Modify | Add Version Control tab |
| `dashboard/src/api.js` | Modify | Add version control API calls |
| `server/dashboard/router.js` | Modify | Add version control REST routes |
| `server/plugins/loader.js` | Modify | Auto-load version-control plugin |

---

## Plugin Loading

The version-control plugin loads automatically on server startup (unlike auth which requires `TORQUE_AUTH_MODE=enterprise`). In `server/plugins/loader.js`, add it to the always-loaded plugin list:

```js
const ALWAYS_LOADED_PLUGINS = ['version-control'];
```

The auth plugin remains enterprise-only. Version control is core development infrastructure.

---

## Phase 2 (Future)

Phase 2 will add: PR automation (create/update PRs via `gh`), changelog generation (from vc_commits), and release tagging. Phase 1 must be complete and stable before starting Phase 2.

---

## What This Does NOT Include

- LLM-based commit message generation (pure heuristics only)
- GitHub/GitLab integration (Phase 2)
- PR workflows (Phase 2)
- Changelog generation (Phase 2)
- Release tagging (Phase 2)
- Multi-repo management (each repo is independent)
- Conflict resolution (git handles this natively)
