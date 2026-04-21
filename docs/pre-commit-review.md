# Pre-Commit AI Review

Workflows with `auto_commit: true` can request an AI reviewer to inspect the staged diff before committing.

    pre_commit_review:
      enabled: true
      on_block: fail_workflow   # fail_workflow | require_approval | warn_only
      reviewer_provider: claude-cli

## What the reviewer sees

- Full `git diff --cached`
- (Optional) related files (callers/dependencies of changed files) - uses repo map from Plan 17 when available

## Verdicts

| Verdict | Meaning |
|---|---|
| `pass` | No significant issues. Commit proceeds. |
| `warn` | Minor issues. Commit proceeds. Issues recorded in workflow metadata + commit trailer. |
| `block` | Bugs, security issues, or missing tests. Behavior depends on `on_block`. |

## `on_block` modes

| Mode | Behavior |
|---|---|
| `warn_only` (default) | Log the verdict but commit anyway |
| `fail_workflow` | Cancel the commit, mark workflow as failed with reason |
| `require_approval` | Hold the commit, surface verdict as a pending approval |

## Failure modes

If the reviewer LLM is unavailable or returns malformed JSON, the verdict defaults to `pass` with an annotation. Pre-commit review is best-effort - never blocks a workflow because the reviewer crashed.
