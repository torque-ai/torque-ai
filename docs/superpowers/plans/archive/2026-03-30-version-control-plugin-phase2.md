# Version Control Plugin Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the version-control plugin with PR preparation, changelog generation, and semver-aware release tagging.

**Architecture:** Three new modules added to `server/plugins/version-control/`. PR preparer generates content from git log. Changelog generator queries vc_commits and formats as Keep a Changelog. Release manager infers semver from commit types and creates git tags. 5 new MCP tools, dashboard Releases section. All git operations use execFileSync (not exec) to prevent shell injection.

**Tech Stack:** Node.js, child_process.execFileSync for git/gh, better-sqlite3, React (JSX), Vitest

**Spec:** `docs/superpowers/specs/2026-03-30-version-control-plugin-phase2-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `server/plugins/version-control/pr-preparer.js` | Create | PR title/body/label generation |
| `server/plugins/version-control/changelog-generator.js` | Create | Changelog text + file writing |
| `server/plugins/version-control/release-manager.js` | Create | Semver inference + git tag |
| `server/plugins/version-control/tool-defs.js` | Modify | Add 5 new tool schemas |
| `server/plugins/version-control/handlers.js` | Modify | Add 5 new handlers |
| `server/plugins/version-control/index.js` | Modify | Wire new modules, bump version |
| `server/plugins/version-control/tests/pr-preparer.test.js` | Create | PR tests |
| `server/plugins/version-control/tests/changelog-generator.test.js` | Create | Changelog tests |
| `server/plugins/version-control/tests/release-manager.test.js` | Create | Release tests |
| `dashboard/src/views/VersionControl.jsx` | Modify | Add Releases section |
| `dashboard/src/api.js` | Modify | Add release API calls |
| `server/dashboard/router.js` | Modify | Add release REST routes |

---

### Task 1: PR Preparer

**Files:**
- Create: `server/plugins/version-control/pr-preparer.js`
- Create: `server/plugins/version-control/tests/pr-preparer.test.js`

- [ ] **Step 1: Write failing test**

Vitest globals, mock execFileSync. Tests: title from branch name, body with grouped commits, label suggestions, default branches, commit hashes option, diff stat option, empty branch handling.

- [ ] **Step 2: Implement pr-preparer.js**

Export createPrPreparer() factory. preparePr runs git log via execFileSync(windowsHide:true), parses conventional commit prefixes, generates title/body/labels. formatPrBody groups by type. Labels: feat->enhancement, fix->bug, docs->documentation.

- [ ] **Step 3: Run tests, verify pass**
- [ ] **Step 4: Commit**

---

### Task 2: Changelog Generator

**Files:**
- Create: `server/plugins/version-control/changelog-generator.js`
- Create: `server/plugins/version-control/tests/changelog-generator.test.js`

- [ ] **Step 1: Write failing test**

In-memory SQLite with vc_commits table. Tests: group into sections, filter by tags/dates, version header, type mapping (feat->Added, fix->Fixed, refactor->Changed), empty range, create new CHANGELOG.md, prepend to existing, getChangelogSinceTag.

- [ ] **Step 2: Implement changelog-generator.js**

Export createChangelogGenerator({ db }) factory. Queries vc_commits, groups by type, formats Keep a Changelog. updateChangelogFile reads/creates CHANGELOG.md, prepends new version block.

- [ ] **Step 3: Run tests, verify pass**
- [ ] **Step 4: Commit**

---

### Task 3: Release Manager

**Files:**
- Create: `server/plugins/version-control/release-manager.js`
- Create: `server/plugins/version-control/tests/release-manager.test.js`

- [ ] **Step 1: Write failing test**

In-memory SQLite, mock execFileSync. Tests: getLatestTag returns/null, inferNextVersion minor/patch/major bumps, startVersion default, breakdown, createRelease tags/pushes/records.

- [ ] **Step 2: Implement release-manager.js**

Export createReleaseManager({ db }) factory. getLatestTag via git describe. inferNextVersion scans commit types: BREAKING->major, feat->minor, else->patch. createRelease creates annotated tag, optionally pushes, records in vc_commits.

- [ ] **Step 3: Run tests, verify pass**
- [ ] **Step 4: Commit**

---

### Task 4: MCP Tools and Handlers

**Files:**
- Modify: `server/plugins/version-control/tool-defs.js`
- Modify: `server/plugins/version-control/handlers.js`

- [ ] **Step 1: Add 5 tool definitions**

vc_prepare_pr, vc_create_pr, vc_generate_changelog, vc_update_changelog_file, vc_create_release.

- [ ] **Step 2: Add 5 handler functions**

Each calls the appropriate module. vc_create_pr runs gh pr create via execFileSync. All return toTextResponse matching existing pattern.

- [ ] **Step 3: Commit**

---

### Task 5: Plugin Wiring

**Files:**
- Modify: `server/plugins/version-control/index.js`

- [ ] **Step 1: Wire new modules in install()**

Import and instantiate pr-preparer, changelog-generator, release-manager. Pass to createHandlers. Bump PLUGIN_VERSION to 2.0.0.

- [ ] **Step 2: Verify 13 tools total (8 + 5)**
- [ ] **Step 3: Commit**

---

### Task 6: Dashboard Releases Section

**Files:**
- Modify: `dashboard/src/views/VersionControl.jsx`
- Modify: `dashboard/src/api.js`
- Modify: `server/dashboard/router.js`

- [ ] **Step 1: Add REST routes**

GET /api/version-control/releases, POST /api/version-control/releases.

- [ ] **Step 2: Add API calls**

versionControl.getReleases(), versionControl.createRelease(body).

- [ ] **Step 3: Add Releases section to VersionControl.jsx**

Current version badge, next version suggestion with bump reason, recent releases table.

- [ ] **Step 4: Commit**

---

## Dependency Graph

```
Task 1 (pr-preparer) ───┐
Task 2 (changelog-gen) ──┤── Task 4 (tools + handlers) ── Task 5 (plugin wiring)
Task 3 (release-mgr) ───┘                                       |
                                                                 └── Task 6 (dashboard)
```

- Tasks 1, 2, 3 are independent and can run in parallel
- Task 4 depends on Tasks 1-3
- Task 5 depends on Task 4
- Task 6 depends on Task 5
