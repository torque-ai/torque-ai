# Version Control Plugin — Phase 2 Design Spec

**Date:** 2026-03-30
**Status:** Approved
**Goal:** Extend the version-control plugin with PR preparation, changelog generation, and semver-aware release tagging — the shipping workflow.

---

## Problem

Phase 1 covers the development workflow (worktrees, commits, branch policies). But shipping — creating PRs, generating changelogs, tagging releases — is still manual. The `vc_commits` table already has structured commit data; Phase 2 puts it to use.

## Solution

Three new modules in `server/plugins/version-control/` that build on Phase 1's commit data. PR preparation generates content for Claude to review before submission. Changelog generation produces Keep a Changelog format from commit types. Release tagging infers semver from commit history. 5 new MCP tools, dashboard additions.

---

## Components

### 1. PR Preparer (`pr-preparer.js`)

Export `createPrPreparer()` factory.

Functions:
- `preparePr(repoPath, sourceBranch, targetBranch)` — reads commit history between branches via `git log sourceBranch..targetBranch --oneline`. Returns prepared PR content:
  - `title` — derived from branch name (e.g., `feat/add-governance` → `Add governance`) or first commit subject if branch name is generic
  - `body` — commits grouped by type with markdown formatting:
    ```
    ## Summary
    - feat: add governance rules table
    - feat: add governance hooks
    - fix: container registration order

    ## Changes
    3 commits, 12 files changed
    ```
  - `labels` — suggested from commit types: `feat`→`enhancement`, `fix`→`bug`, `docs`→`documentation`, `test`→`testing`, `refactor`→`refactoring`, `chore`→`maintenance`
  - `reviewers` — empty array (future: could suggest based on file ownership)

- `formatPrBody(commits, options)` — takes parsed commits, produces markdown body. Options: `includeCommitHashes` (default: true), `includeDiffStat` (default: true).

### 2. Changelog Generator (`changelog-generator.js`)

Export `createChangelogGenerator({ db })` factory.

Functions:
- `generateChangelog(repoPath, options)` — queries `vc_commits` table for commits between `fromTag` and `toTag` (or `fromDate`/`toDate`). Groups by commit type into Keep a Changelog sections. Returns markdown string.

  Section mapping:
  - `feat` → **Added**
  - `fix` → **Fixed**
  - `refactor` → **Changed**
  - `docs` → **Documentation**
  - `test` → **Testing**
  - `chore` → **Maintenance**
  - `style` → **Styling**

  Format:
  ```markdown
  ## [1.2.0] - 2026-03-30

  ### Added
  - Add governance rules table (#123)
  - Add governance hooks with 5 checkers

  ### Fixed
  - Container registration order for governance

  ### Changed
  - Refactor policy engine evaluation loop
  ```

- `updateChangelogFile(repoPath, version, changelogText, options)` — reads existing CHANGELOG.md (or creates it), prepends new version section after the header. Options: `filePath` (default: `CHANGELOG.md`), `createIfMissing` (default: true).

- `getChangelogSinceTag(repoPath, tag)` — convenience: gets commits since tag, generates changelog text.

### 3. Release Manager (`release-manager.js`)

Export `createReleaseManager({ db })` factory.

Functions:
- `getLatestTag(repoPath)` — runs `git describe --tags --abbrev=0` to find the most recent semver tag. Returns `{ tag, version }` or null if no tags.

- `inferNextVersion(repoPath, options)` — analyzes commits since last tag:
  1. Get latest tag via `getLatestTag`
  2. Query `vc_commits` since that tag (or all commits if no tag)
  3. Scan commit types and messages:
     - Any commit message contains `BREAKING CHANGE` or `BREAKING:` → **major** bump
     - Any `feat` commit → **minor** bump
     - Only `fix`, `docs`, `chore`, `refactor`, `test`, `style` → **patch** bump
  4. Parse current version, apply bump, return `{ current, next, bump, commitCount, breakdown }`

  Options: `prerelease` (e.g., `beta.1`), `startVersion` (default: `0.1.0` when no tags exist).

- `createRelease(repoPath, options)` — creates a git tag:
  1. Use `options.version` or call `inferNextVersion` to determine version
  2. Run `git tag -a v{version} -m "Release {version}"`
  3. If `options.push` is true, run `git push origin v{version}`
  4. Record in `vc_commits` table with type `release`
  5. Return `{ version, tag, pushed, commitCount }`

---

## MCP Tools (5 new)

### PR

**`vc_prepare_pr`**
- Input: `{ repo_path: string, source_branch?: string, target_branch?: string }`
- Defaults: source = current branch, target = base_branch from worktree record or 'main'
- Returns prepared PR content (title, body, labels) for review

**`vc_create_pr`**
- Input: `{ repo_path: string, title: string, body: string, labels?: string[], target_branch?: string, draft?: boolean }`
- Runs `gh pr create --title --body --label --base`
- Returns `{ url, number }`

### Changelog

**`vc_generate_changelog`**
- Input: `{ repo_path: string, from_tag?: string, to_tag?: string, from_date?: string, to_date?: string }`
- Returns changelog markdown text

**`vc_update_changelog_file`**
- Input: `{ repo_path: string, version: string, changelog_text?: string }`
- If `changelog_text` not provided, generates it automatically
- Writes/appends to CHANGELOG.md
- Returns `{ path, version, sections }`

### Release

**`vc_create_release`**
- Input: `{ repo_path: string, version?: string, push?: boolean }`
- If `version` not provided, infers from commit history
- Creates git tag, optionally pushes
- Returns `{ version, tag, bump, pushed, commitCount, breakdown }`

---

## Database

No new tables. All data comes from `vc_commits` (Phase 1). Release tags are recorded as `vc_commits` entries with `commit_type = 'release'`.

---

## Dashboard Integration

Add to the existing Version Control tab in OperationsHub:

**Releases section** (below Worktrees and Recent Commits):
- Latest tag and version
- Next suggested version with bump reason (e.g., "1.3.0 — minor bump, 2 feat commits")
- "Generate Changelog" button → shows preview modal
- Recent releases table: version, date, commit count, bump type

REST endpoints:
- `GET /api/version-control/releases` — latest tag + inferred next version
- `POST /api/version-control/releases` — create release (calls vc_create_release)

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `server/plugins/version-control/pr-preparer.js` | Create | PR title/body/label generation |
| `server/plugins/version-control/changelog-generator.js` | Create | Changelog text generation + file writing |
| `server/plugins/version-control/release-manager.js` | Create | Semver inference + git tag creation |
| `server/plugins/version-control/tool-defs.js` | Modify | Add 5 new tool schemas |
| `server/plugins/version-control/handlers.js` | Modify | Add 5 new handlers |
| `server/plugins/version-control/index.js` | Modify | Wire new modules in install() |
| `server/plugins/version-control/tests/pr-preparer.test.js` | Create | PR preparation tests |
| `server/plugins/version-control/tests/changelog-generator.test.js` | Create | Changelog tests |
| `server/plugins/version-control/tests/release-manager.test.js` | Create | Release manager tests |
| `dashboard/src/views/VersionControl.jsx` | Modify | Add Releases section |
| `dashboard/src/api.js` | Modify | Add release API calls |
| `server/dashboard/router.js` | Modify | Add release REST routes |

---

## What This Does NOT Include

- GitHub release creation (Claude can run `gh release create` directly)
- Automated release triggers (no CI integration)
- Multi-package monorepo versioning
- Commit message linting/enforcement (Phase 1 handles conventional format generation)
- PR review assignment (reviewers array is empty — future feature)
