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

## Auto-Verify-Retry and the Close-Handler Pipeline

The post-task pipeline runs in numbered phases. The two safeguard-relevant ones are:

- **Phase 6** — build verification and test verification, automatically routed to the configured remote workstation when one is available with `test_runners` capability.
- **Phase 6.5** — auto-verify-retry. If `verify_command` is set and verification fails, TORQUE auto-submits a targeted fix task with the verifier's error output as context. Default on for `codex` / `codex-spark`; opt-in for other providers via `auto_verify_on_completion` in `set_project_defaults`.

The stall, retry, fallback, and auto-verify-retry subsystems are independent — they each maintain their own attempt counters and don't share budgets. See `docs/stall-and-retry.md` for the full classifier matrix, cross-subsystem invariants, and 12 open risks.

## Operational Governance

Enforceable operational rules are managed by the governance engine (separate from the quality safeguards above). View and configure rules in the dashboard under **Operations > Governance**, or via MCP tools: `get_governance_rules`, `set_governance_rule_mode`, `toggle_governance_rule`.

**Built-in rules:**

| Rule | What it enforces |
|------|------------------|
| `block-visible-providers` | Refuses task submission to providers the operator has explicitly disabled in the dashboard |
| `inspect-before-cancel` | Requires `task_info` / `check_status` / `get_result` before `cancel_task` so callers see what they're destroying |
| `require-push-before-remote` | Refuses `torque-remote` runs from branches whose HEAD isn't reachable from origin (prevents testing state the remote can't sync) |
| `no-local-tests` | Refuses local-only execution of `verify_command` / test runners when a remote workstation is configured (forces remote execution for parity) |
| `verify-diff-after-codex` | Requires a diff inspection step after Codex / Codex-Spark task completion before auto-commit can fire |

Each rule has a **mode** (`enforce`, `warn`, `shadow`, `disabled`) so operators can roll changes out gradually. Shadow mode logs would-be violations without blocking.

### Judgment Policies (not machine-enforced)

These belong to Claude's / Codex's session judgment and cannot be reduced to rules. They live in `CLAUDE.md` and `CODEX.md`, not in the governance engine:

- Claude is architect + orchestrator, not batch worker — never manually implement what TORQUE should produce.
- On TORQUE failure: diagnose → fix root cause → resubmit. Don't bypass by writing the work by hand.
- Investigate before deleting unknown files — they may be work products from other sessions.
- Prefer structural / semantic edit tools over raw search-replace when TORQUE offers them.

## Configuration

Quality gates are configured via `/torque-config safeguards` or the `set_project_defaults` MCP tool. Key settings:
- `verify_command` — shell command to run after task completion
- `auto_verify_on_completion` — enable/disable auto-verify-retry
- `baseline_extensions` — file extensions to snapshot before execution
