# Project Versioning Design

**Date:** 2026-04-01
**Status:** Approved

## Summary

Add automated semver release management to every TORQUE-managed project. When versioning is enabled for a repo, every task, workflow, and schedule submission must declare a `version_intent`. Releases are cut automatically when workflows complete or standalone tasks land — no human approval step. A post-commit governance hook auto-tracks direct Claude changes. The dashboard shows a release timeline with a full-detail drawer per release.

## Core Model

- **One version per repo** — each repo has a single linear version timeline
- **Semver** — `major.minor.patch` following standard semver rules
- **Git tags** — releases create annotated tags (`v1.3.0`) on the repo
- **Changelog** — auto-generated from task descriptions (primary) and commit messages (fallback), grouped by conventional commit type

### Version Intent

Every change to a versioned project carries a `version_intent`:

| Intent | Bump | When to use |
|--------|------|------------|
| `feature` | minor | New functionality, new components, new endpoints |
| `fix` | patch | Bug fixes, corrections, hotfixes |
| `breaking` | major | API changes, schema changes, removed functionality |
| `internal` | none | Refactoring, docs, CI config, test-only changes — no version bump |

The highest intent in a release determines the bump: `breaking` > `feature` > `fix` > `internal`.

## Enforcement

### Opt-in Per Project

Versioning is enabled per project via `set_project_defaults`:

```js
set_project_defaults({
  working_directory: "/path/to/project",
  versioning_enabled: true,
  versioning_start: "0.1.0"  // optional, defaults to 0.1.0
})
```

Unregistered projects work as they do today — no versioning overhead.

### Hard Gate on Submission

Once `versioning_enabled: true` is set for a project, TORQUE enforces `version_intent` on:

- **`submit_task` / `smart_submit_task`** — required field, rejects without it
- **`create_workflow` / `add_workflow_task`** — required on the workflow or per-task (task inherits workflow intent if not specified)
- **`create_one_time_schedule` / `createCronScheduledTask`** — required in schedule config, carried through when the schedule fires

If `version_intent` is missing and the project is versioned, the submission fails with a clear error: `"version_intent is required for versioned project <repo_path>. Use: feature, fix, breaking, or internal"`.

### Direct Claude Changes — Governance Hook

A post-commit governance hook fires for versioned projects when commits are detected that aren't linked to a TORQUE task. The hook:

1. Reads the commit message
2. Infers `version_intent` from the conventional commit prefix (`feat:` → feature, `fix:` → fix, `BREAKING CHANGE` → breaking, anything else → internal)
3. Records the commit in `vc_commits` with the inferred intent
4. No blocking — the hook is observational, not a gate

This ensures direct Claude edits (hotfixes, debugging, quick changes) are captured without requiring Claude to remember extra steps. The CLAUDE.md instructions reinforce conventional commit messages as the standard for versioned projects.

## Automated Release Policy

Releases are cut automatically — no human approval, no preview step.

### Trigger: Workflow Completion

When a workflow completes (all tasks done, verification passed):

1. Check if the workflow's `working_directory` is a versioned project
2. Collect all `version_intent` values from the workflow's tasks
3. Calculate bump type (highest intent wins)
4. If bump is `internal` only — no release, just record the commits
5. Otherwise: generate changelog, create git tag, record release in DB

### Trigger: Standalone Task Completion

When a standalone task (not part of a workflow) completes:

1. Check if versioned project
2. Use the task's `version_intent` to determine bump
3. If `internal` — no release
4. Otherwise: generate changelog, create git tag, record release

### Trigger: Governance Hook (Direct Changes)

When the post-commit governance hook records a direct change with `feature`, `fix`, or `breaking` intent:

1. Check accumulated unreleased commits since last tag
2. Calculate bump from all unreleased intents
3. Auto-release with the calculated bump

### Changelog Generation

The changelog groups entries by conventional commit type:

```markdown
## [v1.3.0] - 2026-04-01

### Added
- Schedule detail drawer with inline editing
- One-time schedule support with auto-delete

### Fixed
- Debounce Kanban refetch to prevent UI flickering
- Version control dashboard db fallback
- Block scheduling tasks in the past

### Stats
5 commits · 8 files changed · 2 workflows
```

**Content source priority:**
1. TORQUE task description (when the commit is linked to a task/workflow)
2. Commit message (for standalone/direct commits)

The existing `changelog-generator.js` handles the grouping and formatting. The existing `release-manager.js` handles tag creation, version inference, and commit analysis.

## Data Model

### New Table: `vc_releases`

```sql
CREATE TABLE IF NOT EXISTS vc_releases (
  id TEXT PRIMARY KEY,
  repo_path TEXT NOT NULL,
  version TEXT NOT NULL,
  tag TEXT NOT NULL,
  bump_type TEXT NOT NULL,          -- 'major', 'minor', 'patch'
  changelog TEXT,                    -- generated markdown
  commit_count INTEGER DEFAULT 0,
  files_changed INTEGER DEFAULT 0,
  workflow_id TEXT,                   -- linked workflow (if triggered by workflow completion)
  task_id TEXT,                      -- linked task (if triggered by standalone task)
  trigger TEXT NOT NULL,             -- 'workflow', 'task', 'governance', 'manual'
  created_at TEXT NOT NULL
);
```

### Extended: `vc_commits`

Add `version_intent` column to the existing `vc_commits` table:

```sql
ALTER TABLE vc_commits ADD COLUMN version_intent TEXT DEFAULT 'internal';
ALTER TABLE vc_commits ADD COLUMN task_id TEXT;
ALTER TABLE vc_commits ADD COLUMN workflow_id TEXT;
ALTER TABLE vc_commits ADD COLUMN release_id TEXT;
```

### Extended: Task Schema

Add `version_intent` to the task submission schema. Stored in `task_config` or as a top-level metadata field on the task row.

### Extended: Workflow Schema

Add `version_intent` to the workflow creation schema. Individual tasks can override with their own intent; the workflow-level intent is the default.

### Extended: Schedule Schema

Add `version_intent` to the schedule config. Carried through to the spawned task when the schedule fires.

### Extended: Project Defaults

Add to `set_project_defaults`:

```js
{
  versioning_enabled: true,       // opt-in toggle
  versioning_start: "0.1.0",     // starting version if no tags exist
  versioning_auto_push: false,    // push tags to origin automatically
}
```

## Dashboard: Version Control View

### Main View — Release Timeline

Left panel: vertical timeline of releases, newest at top.

Each timeline entry shows:
- Version badge (e.g., `v1.3.0`)
- Bump type badge (`minor` / `patch` / `major`)
- Date and summary stats (`Apr 1, 2026 · 5 commits · 8 files`)
- Current version highlighted with blue accent

Top bar:
- Project name + current version badge
- "Cut Release" button (for explicit/manual releases)

Clicking a release opens the detail drawer.

### Release Detail Drawer

Right-side slide-in drawer (same pattern as ScheduleDetailDrawer), showing all sections expanded:

**Header:**
- Version number (large, bold)
- Bump type badge
- Date and trigger info ("tagged by workflow" / "tagged by governance hook")

**Stats Bar:**
- Commits count
- Files changed count
- Workflows count

**Changelog:**
- Grouped by Added / Fixed / Changed / Documentation / Testing / Maintenance
- Each entry is the task description or commit message

**Commits:**
- Full list with commit message and short hash
- Linked to TORQUE task where applicable

**TORQUE Tasks:**
- Linked tasks/workflows with clickable names
- Badge showing task type (workflow / fix / feature)

**Files Changed:**
- List with `+` (added), `~` (modified), `-` (deleted) indicators
- Truncated with "...and N more" for large releases

**Actions:**
- View Diff — shows combined diff for the release
- Rollback — reverts to this version (with confirmation)

### Unreleased Changes Indicator

When there are commits since the last tag that haven't been released yet, the timeline shows an "Unreleased" section at the top with a count of pending changes and their accumulated intent.

## Server Integration Points

### Task Close Handler

The existing task close handler pipeline (in `server/execution/`) gets a new phase after verification:

- **Phase 7: Auto-release check** — if the completed task's project is versioned and `version_intent` is not `internal`:
  - For workflow tasks: check if this is the last task in the workflow. If yes, trigger release for the workflow.
  - For standalone tasks: trigger release immediately.

### Governance Engine

New governance rule: `auto-track-direct-commits`

- **Trigger:** Periodic scan (runs every 60s) comparing `git log` HEAD against the last recorded commit hash in `vc_commits` for each versioned project. Detects new commits not linked to TORQUE tasks.
- **Action:** Record each untracked commit in `vc_commits` with inferred `version_intent` from conventional commit prefix
- **Scope:** Versioned projects only
- **Auto-release:** If any recorded commit has `feature`, `fix`, or `breaking` intent, trigger an auto-release with the accumulated bump type

### MCP Tools

Existing tools that need extension:
- `submit_task` / `smart_submit_task` — add `version_intent` parameter
- `create_workflow` / `add_workflow_task` — add `version_intent` parameter
- `create_one_time_schedule` / `createCronScheduledTask` — add `version_intent` to schedule config

New MCP tools:
- `vc_get_project_version` — return current version, unreleased changes count, next inferred version
- `vc_list_releases` — return release history for a project

Existing tools that are already sufficient:
- `vc_create_release` — manual release trigger (already implemented in release-manager.js)
- `vc_generate_changelog` — already implemented in changelog-generator.js
- `vc_update_changelog_file` — already implemented

### Dashboard API

New endpoints:
- `GET /api/version-control/releases` — already exists, needs to query `vc_releases` table
- `GET /api/version-control/releases/:id` — release detail with commits, files, linked tasks

Extended endpoints:
- `GET /api/version-control/releases` response includes changelog, commit list, file changes, linked tasks

### CLAUDE.md Instructions

Add to project CLAUDE.md for versioned projects:

```
## Version Control
This project uses TORQUE automated versioning. All TORQUE submissions require version_intent.
Direct commits must use conventional commit format (feat:, fix:, docs:, etc.) — the governance
hook auto-tracks them. Releases are cut automatically on workflow/task completion.
```

## Existing Infrastructure Reuse

| Component | Status | Reuse |
|-----------|--------|-------|
| `release-manager.js` | Functional | `createRelease()`, `inferNextVersion()`, `getLatestTag()` — use as-is |
| `changelog-generator.js` | Functional | `generateChangelog()`, `updateChangelogFile()` — use as-is |
| `vc_commits` table | Exists | Extend with `version_intent`, `task_id`, `workflow_id`, `release_id` columns |
| `vc_worktrees` table | Exists | Keep for worktree tracking, orthogonal to versioning |
| MCP tools (`vc_create_release`, etc.) | Exist but not exposed | Wire into MCP tool registry |
| Dashboard VersionControl.jsx | Exists | Redesign from commit/worktree view to release timeline |
| Governance engine | Exists | Add new `auto-track-direct-commits` rule |
| Task close handler | Exists | Add Phase 7 auto-release check |

## Edge Cases

**First release:** If no tags exist, use `versioning_start` (default `0.1.0`) as the base and apply the bump.

**Concurrent workflows:** If two workflows complete simultaneously on the same project, releases are serialized — the second workflow sees the first's tag and bumps from there.

**Failed workflow:** No release is cut if the workflow fails. Failed tasks don't contribute to version bumps.

**Internal-only changes:** If all accumulated intents are `internal`, no release is created. The commits are recorded but don't trigger a tag.

**Rollback:** Rolling back to a previous version creates a new tag (e.g., if rolling back from v1.3.0 to v1.2.0, it tags v1.3.1 with the rolled-back state). History is append-only.

**Manual override:** The "Cut Release" dashboard button and `vc_create_release` MCP tool allow explicit version specification, bypassing auto-inference. For cases where you want to force a specific version number.
