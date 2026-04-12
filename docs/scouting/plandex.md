# Plandex Review: Feature Cross-Reference for TORQUE Software Factory

**Source:** [plandex-ai/plandex](https://github.com/plandex-ai/plandex)
**Tagline:** "An AI coding agent designed for large tasks and real world projects."
**Reviewed:** 2026-04-11
**Status:** Research / planning only

---

## Executive summary

Plandex is not primarily a workflow orchestrator in the TORQUE sense. Its distinctive strength is that it treats a coding effort as a long-lived, versioned plan with its own context state, branch history, pending diffs, and execution artifacts. The most valuable ideas for TORQUE are the ones that make experimentation and review first-class: branchable plan state, step-scoped context loading, and a review sandbox that separates generated changes from the real worktree until approval.

---

## Docs reviewed

Priority docs for this pass:

- [README.md](https://github.com/plandex-ai/plandex/blob/main/README.md)
- [docs/docs/core-concepts/branches.md](https://github.com/plandex-ai/plandex/blob/main/docs/docs/core-concepts/branches.md)
- [docs/docs/core-concepts/context-management.md](https://github.com/plandex-ai/plandex/blob/main/docs/docs/core-concepts/context-management.md)
- [docs/docs/core-concepts/reviewing-changes.md](https://github.com/plandex-ai/plandex/blob/main/docs/docs/core-concepts/reviewing-changes.md)

Supporting docs used to validate behavior:

- [docs/docs/core-concepts/version-control.md](https://github.com/plandex-ai/plandex/blob/main/docs/docs/core-concepts/version-control.md)
- [docs/docs/core-concepts/execution-and-debugging.md](https://github.com/plandex-ai/plandex/blob/main/docs/docs/core-concepts/execution-and-debugging.md)
- [docs/docs/core-concepts/plans.md](https://github.com/plandex-ai/plandex/blob/main/docs/docs/core-concepts/plans.md)

---

## Distinctive features worth stealing

### 1. Plan-native branching and rewindable history

**What it does:** Plandex version-controls nearly every meaningful plan mutation: prompts, responses, context updates, model changes, pending changes, and applies. Branches let the user fork the full plan state to compare prompting strategies, context choices, model settings, or rewind experiments without losing the original path.

**Why it's distinctive:** This goes beyond git-style file branching or simple task retries. The branch point includes conversation state, context state, pending diffs, and model configuration, which makes alternative reasoning paths first-class instead of disposable reruns.

**Relevance to TORQUE:** HIGH. TORQUE already has strong DAG execution and retries, but it does not yet preserve alternative workflow trajectories as branch-local state that can be inspected, compared, and resumed later.

### 2. Sliding context window with project maps

**What it does:** Plandex builds a tree-sitter project map, uses it to auto-select relevant context for planning, and then narrows context again for each implementation step so only directly relevant files are loaded. Manual context can be layered on top, and non-file inputs like URLs, notes, images, and piped command output are treated as first-class context.

**Why it's distinctive:** The important idea is not just "large context support." It is step-by-step context shrinking and expansion inside one long-running plan, with a clear model for mixing automatic and manual context without losing control.

**Relevance to TORQUE:** HIGH. TORQUE has context stuffing and repo study support, but Plandex's step-scoped sliding window is a stronger pattern for long workflows where cost, latency, and focus degrade when every node inherits too much prior material.

### 3. Version-controlled pending-change sandbox

**What it does:** Generated edits do not go straight into project files. They accumulate as pending changes inside a version-controlled sandbox, where the user can inspect terminal or browser diffs, reject specific files, and only then apply the accepted changes to the real project.

**Why it's distinctive:** This is more than a final review step. It creates an incremental review layer where AI edits are a separate artifact that can be inspected and partially rejected before they mutate the worktree.

**Relevance to TORQUE:** HIGH. TORQUE has verification gates after execution, but a pending-diff layer would provide a cleaner human approval surface for risky tasks, especially for large multi-file changes or autonomous repair loops.

### 4. Command sandbox plus rollback-driven auto-debug loop

**What it does:** Plandex accumulates inferred execution steps in a special `_apply.sh` artifact alongside file changes. After apply, it can run those commands, roll back on failure, feed the failure output back to the model, and retry until success or a configured limit.

**Why it's distinctive:** Execution is treated as a reviewable, reversible part of plan state rather than an unstructured side effect. The rollback-and-retry loop binds code edits and verification output into one controlled state machine.

**Relevance to TORQUE:** HIGH. TORQUE already has verify commands, retries, and remediation patterns, but Plandex's explicit execution sandbox suggests a more inspectable apply/verify/debug pipeline for autonomous tasks.

### 5. Plan-scoped workspace as the unit of work

**What it does:** A Plandex plan is a persistent workspace that contains conversation, context, and pending changes, and it can be created at the repo root or inside subdirectories. Subdirectory-scoped plans help constrain automatic context selection and reduce project-map scope.

**Why it's distinctive:** Many automation systems treat each task as mostly stateless aside from logs and artifacts. Plandex instead makes the stateful workspace itself the product primitive, with directory placement acting as a focusing control.

**Relevance to TORQUE:** MEDIUM. TORQUE already has `working_directory` on tasks and workflows, but it does not yet expose a persistent workspace abstraction that carries focused context and review state across many interactions.

---

## Bottom line for TORQUE

The biggest ideas are not about model choice or terminal UX. They are about state management:

- Branch the full workflow state, not just file outputs.
- Shrink and expand context at the step level, not only at task start.
- Separate generated diffs and execution scripts from the live worktree until approval.
- Treat execution and debugging artifacts as reversible workflow state.

Plandex is strongest where it makes long-running AI work inspectable, rewindable, and branchable. Those are directly relevant to TORQUE's software factory direction.
