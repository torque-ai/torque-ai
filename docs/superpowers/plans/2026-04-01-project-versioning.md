# Project Versioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add automated semver release management to TORQUE-managed projects with hard-gate enforcement, auto-release on task/workflow completion, and a release timeline dashboard.

**Architecture:** New `version-intent` module validates and enforces `version_intent` on submissions for versioned projects (checked via `project_metadata`). Auto-release service wraps existing `release-manager.js` and `changelog-generator.js`, triggered from the completion pipeline (Phase 9). Dashboard redesigned from commit/worktree viewer to release timeline with full-detail drawer.

**Tech Stack:** Node.js, better-sqlite3, React, date-fns

**Spec:** `docs/superpowers/specs/2026-04-01-project-versioning-design.md`

---

## File Map

| File | Responsibility | Action |
|------|---------------|--------|
| `server/db/schema-tables.js` | Schema definitions | Modify: add `vc_releases` table, extend `vc_commits` |
| `server/versioning/version-intent.js` | Version intent validation + project config queries | Create: ~80 lines |
| `server/versioning/auto-release.js` | Auto-release service wrapping release-manager + changelog-generator | Create: ~120 lines |
| `server/handlers/task/core.js` | Task submission handler | Modify: add version_intent validation |
| `server/handlers/integration/routing.js` | Smart submit handler | Modify: pass version_intent through |
| `server/handlers/workflow/index.js` | Workflow creation handler | Modify: add version_intent validation + inheritance |
| `server/db/cron-scheduling.js` | Schedule creation | Modify: add version_intent to schedule config |
| `server/execution/completion-pipeline.js` | Post-completion pipeline | Modify: add Phase 9 auto-release check |
| `server/governance/hooks.js` | Governance rules | Modify: add `auto-track-direct-commits` rule |
| `server/handlers/advanced/scheduling.js` | Schedule MCP tool defs | Modify: add version_intent to tool schemas |
| `dashboard/src/api.js` | Dashboard API client | Modify: update versionControl methods |
| `dashboard/src/components/ReleaseDetailDrawer.jsx` | Release detail drawer | Create: ~280 lines |
| `dashboard/src/views/VersionControl.jsx` | Version control dashboard | Modify: redesign to release timeline |

---

## Task 1: Schema — vc_releases Table and vc_commits Extension

**Files:**
- Modify: `server/db/schema-tables.js`
- Modify: `server/plugins/version-control/index.js`

- [ ] **Step 1: Add vc_releases table to schema-tables.js**

In `server/db/schema-tables.js`, find the section where version-control tables are created (search for `vc_worktrees` or add after the last `db.exec` block). Add:

```js
  db.exec(`
    CREATE TABLE IF NOT EXISTS vc_releases (
      id TEXT PRIMARY KEY,
      repo_path TEXT NOT NULL,
      version TEXT NOT NULL,
      tag TEXT NOT NULL,
      bump_type TEXT NOT NULL,
      changelog TEXT,
      commit_count INTEGER DEFAULT 0,
      files_changed INTEGER DEFAULT 0,
      workflow_id TEXT,
      task_id TEXT,
      trigger TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
```

- [ ] **Step 2: Extend vc_commits in plugin index.js**

In `server/plugins/version-control/index.js`, inside the `ensureSchema` function (line 68), after the existing `CREATE TABLE` statements, add safe column additions:

```js
function ensureSchema(dbHandle) {
  dbHandle.prepare(CREATE_WORKTREES_TABLE_SQL).run();
  dbHandle.prepare(CREATE_COMMITS_TABLE_SQL).run();

  // vc_releases table
  dbHandle.prepare(`
    CREATE TABLE IF NOT EXISTS vc_releases (
      id TEXT PRIMARY KEY,
      repo_path TEXT NOT NULL,
      version TEXT NOT NULL,
      tag TEXT NOT NULL,
      bump_type TEXT NOT NULL,
      changelog TEXT,
      commit_count INTEGER DEFAULT 0,
      files_changed INTEGER DEFAULT 0,
      workflow_id TEXT,
      task_id TEXT,
      trigger TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `).run();

  // Extend vc_commits with version_intent + linkage columns
  const cols = dbHandle.prepare("PRAGMA table_info('vc_commits')").all().map(c => c.name);
  if (!cols.includes('version_intent')) {
    dbHandle.prepare("ALTER TABLE vc_commits ADD COLUMN version_intent TEXT DEFAULT 'internal'").run();
  }
  if (!cols.includes('task_id')) {
    dbHandle.prepare('ALTER TABLE vc_commits ADD COLUMN task_id TEXT').run();
  }
  if (!cols.includes('workflow_id')) {
    dbHandle.prepare('ALTER TABLE vc_commits ADD COLUMN workflow_id TEXT').run();
  }
  if (!cols.includes('release_id')) {
    dbHandle.prepare('ALTER TABLE vc_commits ADD COLUMN release_id TEXT').run();
  }
}
```

- [ ] **Step 3: Commit**

```
git add server/db/schema-tables.js server/plugins/version-control/index.js
git commit -m "feat: add vc_releases table and extend vc_commits schema"
```

---

## Task 2: Version Intent Validation Module

**Files:**
- Create: `server/versioning/version-intent.js`

- [ ] **Step 1: Create the module**

Create `server/versioning/version-intent.js`:

```js
'use strict';

const VALID_INTENTS = new Set(['feature', 'fix', 'breaking', 'internal']);

const INTENT_PRIORITY = { breaking: 3, feature: 2, fix: 1, internal: 0 };

const INTENT_TO_BUMP = { breaking: 'major', feature: 'minor', fix: 'patch', internal: null };

const CONVENTIONAL_PREFIX_MAP = {
  feat: 'feature',
  fix: 'fix',
  refactor: 'internal',
  docs: 'internal',
  test: 'internal',
  chore: 'internal',
  style: 'internal',
  perf: 'fix',
  ci: 'internal',
  build: 'internal',
};

function isValidIntent(intent) {
  return VALID_INTENTS.has(intent);
}

function validateVersionIntent(intent) {
  if (!intent || typeof intent !== 'string') {
    return { valid: false, error: 'version_intent is required. Use: feature, fix, breaking, or internal' };
  }
  const normalized = intent.trim().toLowerCase();
  if (!VALID_INTENTS.has(normalized)) {
    return { valid: false, error: `Invalid version_intent "${intent}". Use: feature, fix, breaking, or internal` };
  }
  return { valid: true, intent: normalized };
}

function isProjectVersioned(db, workingDirectory) {
  if (!workingDirectory) return false;
  try {
    const row = db.prepare(
      "SELECT value FROM project_metadata WHERE project = ? AND key = 'versioning_enabled'"
    ).get(workingDirectory);
    return row && (row.value === '1' || row.value === 'true');
  } catch {
    return false;
  }
}

function getVersioningConfig(db, workingDirectory) {
  if (!workingDirectory) return null;
  try {
    const rows = db.prepare(
      "SELECT key, value FROM project_metadata WHERE project = ? AND key LIKE 'versioning_%'"
    ).all(workingDirectory);
    if (rows.length === 0) return null;
    const config = {};
    for (const row of rows) {
      const shortKey = row.key.replace('versioning_', '');
      config[shortKey] = row.value;
    }
    config.enabled = config.enabled === '1' || config.enabled === 'true';
    config.auto_push = config.auto_push === '1' || config.auto_push === 'true';
    config.start = config.start || '0.1.0';
    return config;
  } catch {
    return null;
  }
}

function inferIntentFromCommitMessage(message) {
  if (!message || typeof message !== 'string') return 'internal';
  if (/BREAKING CHANGE|BREAKING:/i.test(message)) return 'breaking';
  const match = /^([a-z]+)(?:\([^)]+\))?!?:/i.exec(message.trim());
  if (match) {
    const prefix = match[1].toLowerCase();
    if (match[0].includes('!')) return 'breaking';
    return CONVENTIONAL_PREFIX_MAP[prefix] || 'internal';
  }
  return 'internal';
}

function highestIntent(intents) {
  let max = 'internal';
  for (const intent of intents) {
    if ((INTENT_PRIORITY[intent] || 0) > (INTENT_PRIORITY[max] || 0)) {
      max = intent;
    }
  }
  return max;
}

function intentToBump(intent) {
  return INTENT_TO_BUMP[intent] || null;
}

module.exports = {
  VALID_INTENTS,
  INTENT_PRIORITY,
  isValidIntent,
  validateVersionIntent,
  isProjectVersioned,
  getVersioningConfig,
  inferIntentFromCommitMessage,
  highestIntent,
  intentToBump,
};
```

- [ ] **Step 2: Commit**

```
git add server/versioning/version-intent.js
git commit -m "feat: version-intent validation module"
```

---

## Task 3: Auto-Release Service

**Files:**
- Create: `server/versioning/auto-release.js`

- [ ] **Step 1: Create the auto-release service**

Create `server/versioning/auto-release.js`:

```js
'use strict';

const { randomUUID } = require('crypto');
const { highestIntent, intentToBump, getVersioningConfig } = require('./version-intent');

function createAutoReleaseService({ db, releaseManager, changelogGenerator, logger }) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('auto-release service requires db with prepare()');
  }
  if (!releaseManager) throw new Error('auto-release service requires releaseManager');
  if (!changelogGenerator) throw new Error('auto-release service requires changelogGenerator');
  const log = logger || console;

  function hasColumn(name) {
    try {
      const cols = db.prepare("PRAGMA table_info('vc_commits')").all().map(c => c.name);
      return cols.includes(name);
    } catch {
      return false;
    }
  }

  function getUnreleasedCommits(repoPath) {
    const tsCol = hasColumn('generated_at') ? 'generated_at' : 'created_at';
    return db.prepare(
      `SELECT * FROM vc_commits WHERE repo_path = ? AND release_id IS NULL ORDER BY ${tsCol} ASC`
    ).all(repoPath);
  }

  function calculateBump(commits) {
    const intents = commits.map(c => c.version_intent || 'internal');
    const intent = highestIntent(intents);
    return intentToBump(intent);
  }

  function cutRelease(repoPath, { workflowId, taskId, trigger }) {
    const config = getVersioningConfig(db, repoPath);
    if (!config || !config.enabled) {
      return null;
    }

    const unreleased = getUnreleasedCommits(repoPath);
    if (unreleased.length === 0) {
      log.info(`[auto-release] No unreleased commits for ${repoPath}`);
      return null;
    }

    const bump = calculateBump(unreleased);
    if (!bump) {
      log.info(`[auto-release] All commits are internal for ${repoPath}, skipping release`);
      return null;
    }

    // Use existing release-manager to create the git tag
    let releaseResult;
    try {
      releaseResult = releaseManager.createRelease(repoPath, {
        push: config.auto_push,
        startVersion: config.start,
      });
    } catch (err) {
      log.error(`[auto-release] Failed to create release for ${repoPath}: ${err.message}`);
      return null;
    }

    // Generate changelog
    let changelog = '';
    try {
      changelog = changelogGenerator.generateChangelog(repoPath, {
        version: releaseResult.version,
      });
      if (changelog) {
        changelogGenerator.updateChangelogFile(repoPath, releaseResult.version, changelog);
      }
    } catch (err) {
      log.info(`[auto-release] Changelog generation failed (non-fatal): ${err.message}`);
    }

    // Record release in vc_releases
    const releaseId = randomUUID();
    const now = new Date().toISOString();
    try {
      db.prepare(`
        INSERT INTO vc_releases (id, repo_path, version, tag, bump_type, changelog, commit_count, files_changed, workflow_id, task_id, trigger, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        releaseId, repoPath, releaseResult.version, releaseResult.tag, bump,
        changelog || null, unreleased.length, 0,
        workflowId || null, taskId || null, trigger, now
      );
    } catch (err) {
      log.error(`[auto-release] Failed to record release: ${err.message}`);
    }

    // Link unreleased commits to this release
    try {
      const commitIds = unreleased.map(c => c.id);
      const placeholders = commitIds.map(() => '?').join(',');
      db.prepare(`UPDATE vc_commits SET release_id = ? WHERE id IN (${placeholders})`).run(releaseId, ...commitIds);
    } catch (err) {
      log.info(`[auto-release] Failed to link commits to release: ${err.message}`);
    }

    log.info(`[auto-release] Released ${releaseResult.tag} (${bump}) for ${repoPath}`);

    return {
      releaseId,
      version: releaseResult.version,
      tag: releaseResult.tag,
      bump,
      commitCount: unreleased.length,
      pushed: releaseResult.pushed,
    };
  }

  return { cutRelease, getUnreleasedCommits, calculateBump };
}

module.exports = { createAutoReleaseService };
```

- [ ] **Step 2: Commit**

```
git add server/versioning/auto-release.js
git commit -m "feat: auto-release service wrapping release-manager + changelog-generator"
```

---

## Task 4: Enforce version_intent on Task Submission

**Files:**
- Modify: `server/handlers/task/core.js:263-312`
- Modify: `server/handlers/integration/routing.js:270-280`

- [ ] **Step 1: Add validation to handleSubmitTask**

In `server/handlers/task/core.js`, at the top of the file add:

```js
const { validateVersionIntent, isProjectVersioned } = require('../../versioning/version-intent');
```

In `handleSubmitTask` (line 263), after the auto_route dispatch block (line 281) and before the existing input validation (line 284), add version_intent enforcement. Also forward `version_intent` through the auto_route dispatch (add to the args object on line 269).

In the task metadata assembly, include `version_intent` from args when present.

- [ ] **Step 2: Pass version_intent through smart_submit_task**

In `server/handlers/integration/routing.js`, in `handleSmartSubmitTask`, add `version_intent` to the destructured args (line 277) and pass it through when creating the task.

- [ ] **Step 3: Add version_intent to submit_task and smart_submit_task tool schemas**

Add to both tool inputSchema properties:

```js
        version_intent: {
          type: 'string',
          enum: ['feature', 'fix', 'breaking', 'internal'],
          description: 'Version intent for this task. Required for versioned projects. Determines semver bump: feature=minor, fix=patch, breaking=major, internal=no bump.',
        },
```

- [ ] **Step 4: Commit**

```
git add server/handlers/task/core.js server/handlers/integration/routing.js
git commit -m "feat: enforce version_intent on task submission for versioned projects"
```

---

## Task 5: Enforce version_intent on Workflow Creation

**Files:**
- Modify: `server/handlers/workflow/index.js:589-650`

- [ ] **Step 1: Add validation to handleCreateWorkflow**

In `server/handlers/workflow/index.js`, add the require at top:

```js
const { validateVersionIntent, isProjectVersioned } = require('../../versioning/version-intent');
```

In `handleCreateWorkflow`, after existing input validation and before `normalizeInitialWorkflowTasks`, add enforcement: if the project is versioned, require `version_intent` on the workflow OR on every task. Store in workflow metadata for retrieval at completion.

- [ ] **Step 2: Add version_intent to create_workflow tool schema**

Add `version_intent` to the workflow-level properties and to each task's properties within the tasks array schema.

- [ ] **Step 3: Commit**

```
git add server/handlers/workflow/index.js
git commit -m "feat: enforce version_intent on workflow creation for versioned projects"
```

---

## Task 6: Enforce version_intent on Schedule Creation

**Files:**
- Modify: `server/db/cron-scheduling.js`
- Modify: `server/handlers/advanced/scheduling.js`

- [ ] **Step 1: Add version_intent to schedule task_config**

In `server/db/cron-scheduling.js`, in `createCronScheduledTask` and `createOneTimeSchedule`, include `version_intent` in the assembled `task_config`. Add enforcement for versioned projects.

- [ ] **Step 2: Add version_intent to schedule MCP tool schemas**

In `server/handlers/advanced/scheduling.js`, add `version_intent` property to the `create_schedule` and `create_one_time_schedule` tool input schemas.

- [ ] **Step 3: Pass version_intent when schedule fires**

When the scheduler fires a task, pass `version_intent` from the schedule's `task_config` to the task submission.

- [ ] **Step 4: Commit**

```
git add server/db/cron-scheduling.js server/handlers/advanced/scheduling.js
git commit -m "feat: enforce version_intent on schedule creation and firing"
```

---

## Task 7: Wire Auto-Release into Completion Pipeline

**Files:**
- Modify: `server/execution/completion-pipeline.js:103-230`

- [ ] **Step 1: Add Phase 9 auto-release check**

In `server/execution/completion-pipeline.js`, at the end of `handlePostCompletion`, add a Phase 9 block that:

1. Checks if the completed task's `working_directory` is a versioned project
2. For workflow tasks: only trigger release when the entire workflow is complete
3. For standalone tasks: trigger release immediately
4. Uses `triggerAutoRelease` helper that instantiates the auto-release service from existing modules

Add `triggerAutoRelease` as a module-level helper that:
- Gets the raw DB via `require('../database').getDbInstance()`
- Creates `releaseManager` and `changelogGenerator` from the existing plugin modules
- Creates `autoReleaseService` and calls `cutRelease()`
- All wrapped in try/catch (non-fatal — release failure should never break task completion)

- [ ] **Step 2: Commit**

```
git add server/execution/completion-pipeline.js
git commit -m "feat: wire auto-release into completion pipeline (Phase 9)"
```

---

## Task 8: Governance Hook for Direct Commits

**Files:**
- Modify: `server/governance/hooks.js`

- [ ] **Step 1: Add auto-track-direct-commits rule**

In `server/governance/hooks.js`, add a new built-in governance rule `auto-track-direct-commits` that:

1. Triggers on `task_complete` events (piggybacks on existing hook cycle)
2. Checks if the task's `working_directory` is a versioned project
3. Runs `git log` (via `execFileSync`) to find commits since the last recorded hash in `vc_commits`
4. For each untracked commit, infers `version_intent` from the conventional commit prefix
5. Records in `vc_commits` with inferred intent
6. Non-blocking — the hook is observational, uses `execFileSync` with `windowsHide: true`

- [ ] **Step 2: Commit**

```
git add server/governance/hooks.js
git commit -m "feat: governance hook to auto-track direct commits on versioned projects"
```

---

## Task 9: Dashboard API — Release Endpoints

**Files:**
- Modify: `server/dashboard/router.js`
- Modify: `dashboard/src/api.js`

- [ ] **Step 1: Update releases endpoint in router.js**

Replace `handleGetVersionControlReleasesRoute` to query the `vc_releases` table with full detail:
- Return `current_version`, `latest_tag`, `unreleased_count`, `recent_releases`
- Enrich each release with linked commits from `vc_commits WHERE release_id = ?`
- Support `repo_path` query param for filtering

- [ ] **Step 2: Update dashboard API client**

In `dashboard/src/api.js`, update the `versionControl` object's `getReleases` method to accept an optional `repoPath` param.

- [ ] **Step 3: Commit**

```
git add server/dashboard/router.js dashboard/src/api.js
git commit -m "feat: update releases endpoint to query vc_releases with full detail"
```

---

## Task 10: Dashboard — ReleaseDetailDrawer Component

**Files:**
- Create: `dashboard/src/components/ReleaseDetailDrawer.jsx`

- [ ] **Step 1: Create the drawer component**

Create `dashboard/src/components/ReleaseDetailDrawer.jsx` — right-side slide-in drawer (same pattern as ScheduleDetailDrawer wrapped in `React.memo`). All sections expanded:

- Header: version (large) + bump badge + date + trigger info
- Stats bar: commits / files / workflows counts
- Changelog: parse the `changelog` markdown field into grouped sections (Added/Fixed/Changed etc.)
- Commits: full list with message + short hash, linked task_id where available
- TORQUE Tasks: unique task_ids from commits, with clickable badges
- Files Changed: derive from commits if available
- Actions: "View Diff" button, "Rollback" button (with confirmation)

Props: `release` (object), `onClose` (callback). Escape/backdrop to close.

- [ ] **Step 2: Commit**

```
git add dashboard/src/components/ReleaseDetailDrawer.jsx
git commit -m "feat: ReleaseDetailDrawer component with full detail view"
```

---

## Task 11: Dashboard — Redesign VersionControl.jsx to Release Timeline

**Files:**
- Modify: `dashboard/src/views/VersionControl.jsx`

- [ ] **Step 1: Redesign the main view**

Replace the current commit/worktree table view with the release timeline layout:

- Top bar: project name + current version badge + "Cut Release" button
- Unreleased indicator when `unreleased_count > 0`
- Vertical timeline of releases (newest first), each showing:
  - Version badge, bump type badge (minor=green, patch=yellow, major=red)
  - Date and stats summary
  - Current version highlighted with blue accent
- Click a release → set `selectedRelease` state → render `ReleaseDetailDrawer`
- Keep worktree section as collapsible below the timeline
- Pause polling while drawer is open (same pattern as Schedules)
- Stable callbacks via `useCallback` for drawer props

- [ ] **Step 2: Build dashboard**

```
cd dashboard && npx vite build
```

- [ ] **Step 3: Commit**

```
git add dashboard/src/views/VersionControl.jsx
git commit -m "feat: redesign Version Control dashboard to release timeline with detail drawer"
```

---

## Task 12: Verification

- [ ] **Step 1: Run server tests**

```
torque-remote npx vitest run --reporter=verbose 2>&1 | tail -20
```

Expected: All existing tests pass. No regressions.

- [ ] **Step 2: Build dashboard**

```
cd dashboard && npx vite build 2>&1 | tail -10
```

Expected: Build succeeds.

- [ ] **Step 3: Manual endpoint verification**

```bash
curl -s http://127.0.0.1:3456/api/version-control/releases | python3 -m json.tool
```

Expected: Returns `{ current_version, latest_tag, unreleased_count, recent_releases }`.

- [ ] **Step 4: Fix regressions if any, commit**

Only if needed.
