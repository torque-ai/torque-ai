# Project Versioning

TORQUE supports automated semver release management per project. When versioning is enabled, releases are cut automatically on task and workflow completion.

## Enabling Versioning

Enable via `project_metadata`:

- `versioning_enabled = true`
- `versioning_start = "1.0.0"` (default `0.1.0`)
- `versioning_auto_push = false` (set `true` to push the tag automatically after cut)

## `version_intent` (Required for Versioned Projects)

Every task, workflow, and schedule submission to a versioned project **must** include `version_intent`:

| Intent | Bump | Use |
|--------|------|-----|
| `feature` | minor | New functionality |
| `fix` | patch | Bug fixes |
| `breaking` | major | Breaking changes |
| `internal` | none | Docs, refactoring, tests |

## Auto-Release Behavior

- **Workflow completion** calculates the cumulative bump from accumulated intents (max of all child task intents), creates the git tag, and writes the changelog entry.
- **Standalone task completion** bumps immediately on terminal success.
- **Direct commits outside TORQUE** are auto-tracked via conventional commit prefixes (`feat:`, `fix:`, `chore:`, `docs:`, etc.). The completion pipeline scans for untracked commits and records them with the inferred intent.

## For Direct Claude / Codex Edits

When editing a versioned project outside the TORQUE task flow, **always use conventional commit messages**. The next completion-pipeline run will scan for untracked commits and record them automatically — but only if the commit message gives it a usable intent prefix.

Do **not** hand-edit `CHANGELOG.md`. TORQUE's release automation owns it; manual edits will be overwritten on the next bump.
