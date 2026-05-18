# Documented Plan Exhaustion Features

This note summarizes the plan-file backlog items shipped in the plan exhaustion pass.

## Retrospectives

Completed workflows can generate stored retrospectives with deterministic stats and narrative text. The generator does not submit internal LLM work, so it does not consume Codex quota or fall back to Ollama.

Tools and routes:

- `get_retrospective`, `list_retrospectives`, `generate_retrospective`
- `GET /api/v2/workflows/:workflow_id/timeline` for related event replay

## Experience Memory

Completed task summaries are recorded in `task_experiences`. Future task prompts can receive a small `Related past experiences` block using deterministic local embeddings.

Tools:

- `record_experience`
- `find_related_experiences`

## Scoped Rules

Projects can add Markdown rules under `.torque/rules/*.md`. Optional frontmatter fields include `id`, `title`, `applies_to`, `tags`, and `enabled`. Matching rules are injected into execution prompts before task text.

Tools:

- `list_project_rules`
- `preview_project_rules`

## Workflow Gates And Fan-Out

Workflow task metadata now supports:

- `goal_gate: true` to fail a workflow when a required node fails.
- `kind: "parallel_fanout"` with `max_parallel`.
- `kind: "merge"` with `join_policy: "wait_all"` or `"first_success"`.
- `cacheable`, `cache_version`, and `cache_ttl_seconds` for exact task-result reuse.

Workflow events include `workflow.state_patched` and `workflow.dependency_unblocked`, and timeline reads include a replay sequence.

## Native Eval

Native prompt/provider evaluation has deterministic scorers for exact match, regex match, contains-all, and minimum length checks.

Tools and routes:

- `score_native_eval`
- `diff_native_eval_runs`
- `POST /api/v2/experiments/native-score`
- `POST /api/v2/experiments/native-diff`

## Workstation Legacy Projection

Unified workstations can be projected into legacy `ollama_hosts`, `peek_hosts`, and `remote_agents` row shapes through `server/db/legacy-workstation-projection.js`.
