# Backlog: Project Dependency Graph for File-Level Task Coordination

**Priority:** High
**Depends on:** Existing `scan_project`, `submit_task`, `create_workflow`, and `await_workflow` task lifecycle hooks

## Problem

TORQUE can run parallel tasks that modify the same files. When that happens, tasks clobber each other's changes unless the orchestrator manually detects overlap before submission.

Today that check is done by hand during task authoring by inspecting file paths and reasoning about likely overlap. That does not scale:

- It is easy to miss conflicts in large projects.
- It must be re-done for every workflow.
- It depends on the orchestrator having fresh project context.
- It does not capture indirect coupling between files that read from, import, or modify one another.

The result is avoidable merge conflicts, broken task assumptions, and serial reasoning work that TORQUE should handle as a core coordination feature.

## Proposed Solution

Add a project-level file dependency graph that TORQUE maintains per repository. TORQUE should use that graph to:

1. Detect file conflicts between parallel tasks before submission.
2. Sequence tasks that touch the same files or tightly coupled files.
3. Warn when one task may invalidate another task's assumptions.

This moves conflict analysis out of manual orchestration and into a persistent project capability.

## Graph Structure

The graph is file-level and scoped per project.

### Nodes

- One node per project file.
- Optional future extension: generated files, config groups, or virtual nodes for directories and build outputs.

### Edges

- `imports_from`: static import or require relationship.
- `modifies`: explicit write relationship recorded from task execution.
- `depends_on`: broader non-import dependency used when a file's behavior relies on another file, even if the language does not expose a clean import edge.

### Node Metadata

- `last_modified_by`: task ID that most recently changed the file.
- `last_verified`: timestamp of the most recent graph verification or scan.
- Optional future metadata: language, hash, owner, confidence score, generated/manual classification.

## Core Behaviors

### Conflict Detection

Before TORQUE submits tasks in parallel, it checks each task's declared or inferred `files_modified` set against other active workflow nodes. Direct overlap should block parallel execution or force serialization.

### Dependency-Aware Sequencing

If two tasks do not modify the same file but one modifies a file that another reads, imports, or depends on, TORQUE should warn and optionally sequence them in dependency order.

### Assumption Drift Warnings

When a completed task modifies a file that another pending or running task previously read, TORQUE should flag that the second task may be working from stale assumptions.

## Integration Points

### `scan_project`

- Build or refresh the dependency graph using project import analysis.
- Record discovered file nodes and static edges.
- Mark nodes as verified at scan time.

### `submit_task`

- Accept or infer `files_read` and `files_modified`.
- Attach those file sets to the task record.
- Use them to check for direct overlap and nearby dependency risks before dispatch.

### `create_workflow`

- Compare planned DAG nodes using the graph.
- Auto-detect file conflicts between sibling nodes.
- Sequence nodes that touch the same files.
- Warn when nodes are independent in the DAG but coupled through file dependencies.

### `await_workflow`

- After task completion, verify the actual modified files against the expected file set.
- Detect unexpected writes that were not declared at submission time.
- Re-check downstream nodes for newly introduced conflicts or stale assumptions.

## Enforcement Options

### Hook-Based

Use a post-task hook to update the graph after every completed task.

Pros:

- Keeps the graph close to runtime truth.
- Reduces reliance on manual follow-through.

Risks:

- Adds lifecycle complexity.
- Requires reliable capture of actual modified files.

### Policy-Based

Require file declarations in orchestration policy, such as `CLAUDE.md`, before task submission.

Pros:

- Simple to adopt.
- Easy to explain and audit.

Risks:

- Still depends on human discipline.
- Declarations may be incomplete or stale.

### Automated

Have TORQUE inspect task output and update the graph automatically.

Pros:

- Lowest manual burden.
- Best foundation for scaling across orchestrators.

Risks:

- Output may be ambiguous.
- Requires strong file change detection to avoid false confidence.

### Hybrid

Combine automated detection with explicit policy requirements.

Pros:

- Best balance of safety and usability.
- Lets declarations act as intent and automation act as verification.

Risks:

- More moving parts.
- Needs clear conflict resolution rules when declared and observed file sets differ.

## Open Questions

1. Should the graph be rebuilt on every scan, which is more expensive but always fresh, or maintained incrementally, which is cheaper but can drift?
2. Should the orchestrator be required to declare `files_modified` before submission, or should TORQUE infer file writes from task output and filesystem diffs?
3. How should graph updates be enforced: post-task hook, pre-commit hook, orchestration policy, or some combination?
4. Should dependency detection be language-aware, such as parsing Python imports and C# `using` statements, or start with simpler regex-based heuristics?

## Suggested Direction

The lowest-risk path is a hybrid model:

- Start with explicit `files_read` and `files_modified` declarations on `submit_task`.
- Add automated post-task verification to detect actual writes and update the graph.
- Use `scan_project` to maintain static import edges.
- Treat unexpected overlaps as warnings first, then escalate to enforced sequencing once the graph proves reliable.

This keeps the first version operationally simple while creating a path toward stronger automatic scheduling and conflict prevention.
