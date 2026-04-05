# TORQUE Quality Safeguards

TORQUE includes built-in quality safeguards that run automatically during task submission (`/torque-submit`) and review (`/torque-review`).

## Baselines

File snapshots are captured before task execution begins. After completion, the changed files are compared against baselines to detect regressions, unexpected deletions, or drastic size changes.

## Validation

Completed task output is scanned for:
- **Stub detection** — empty function bodies, placeholder implementations
- **Empty methods** — methods with no logic
- **Truncation** — output cut short or incomplete files
- **Tiny files** — suspiciously small output files that may indicate data loss

## Approval Gates

Automatic approval gates are triggered when:
- A file shrinks by more than 50% compared to its baseline
- Validation detects stubs, empty methods, or truncation
- Tasks are flagged with `needs_review: true` in metadata

Flagged tasks require manual diff review before changes are committed.

## Build Checks

After code tasks complete, TORQUE runs compile verification (e.g., `tsc --noEmit`, `dotnet build`) to confirm the output compiles. Build failures trigger the auto-verify-retry pipeline.

## Auto-Verify-Retry

When a `verify_command` is configured (via `set_project_defaults`), TORQUE automatically runs it after task completion. If verification fails, a targeted fix task is submitted with the error output as context. This is enabled by default for Codex providers.

## Rollback

If a task fails and baselines exist, TORQUE can restore the original file contents. Rollback is triggered automatically on task failure when baselines are available.

## Adaptive Retry

Failed tasks are automatically retried with provider fallback. The retry chain follows the configured fallback order (e.g., codex -> claude-cli -> deepinfra -> ollama). Each retry records the failure reason to avoid repeating the same provider for the same error type.

## Configuration

Quality gates are configured via `/torque-config safeguards` or the `set_project_defaults` MCP tool. Key settings:
- `verify_command` — shell command to run after task completion
- `auto_verify_on_completion` — enable/disable auto-verify-retry
- `baseline_extensions` — file extensions to snapshot before execution
