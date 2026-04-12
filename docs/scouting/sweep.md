# Findings: Sweep

**Tagline:** AI coding assistant that began as an "AI-powered junior developer" for GitHub issues, but whose current repo/docs are positioned around JetBrains.
**Stars:** 7.7k
**Language:** Python

## Feature 1: IDE agent with planning, checkpoints, and built-in verification
**What it does:** Sweep's Agent supports Ask, Agent, and Planning modes; it can search the codebase, edit files, run terminal commands like `git`, and use JetBrains linter/static analysis as a verification tool. It also lets users accept/reject diffs and roll back via checkpoints.
**Why distinctive:** The agent loop is tied to IDE-native analysis instead of a plain shell session, and rollback is treated as a first-class control instead of a manual git cleanup step.
**TORQUE relevance:** MEDIUM - planning, review, and rollback ideas transfer well, but the implementation is editor-centric rather than workflow-orchestrator-centric.

## Feature 2: MCP server integration with selective tool exposure
**What it does:** Sweep supports both local MCP servers and remote SSE-based MCP servers, including authenticated remote endpoints. The docs explicitly recommend enabling only the exact tools needed for a workflow, using PR review as the main example.
**Why distinctive:** Sweep is unusually opinionated that too many tools make agents worse, so it pushes users to avoid duplicate filesystem/shell capabilities and trim the tool surface aggressively.
**TORQUE relevance:** HIGH - TORQUE already has a broad MCP/tool surface, so Sweep's "fewer tools, sharper affordances" guidance is directly applicable.

## Feature 3: AI code review before commit
**What it does:** Sweep can review pending local changes inside JetBrains, reading both the diff and related dependencies to flag bugs, issues, or improvements before commit.
**Why distinctive:** It shifts review left into the inner dev loop instead of waiting for PRs or CI failures, while still looking beyond the raw diff.
**TORQUE relevance:** HIGH - this maps closely to TORQUE verify gates and suggests a useful pre-submit review stage for routed tasks.

## Feature 4: Rules files, custom prompts, and skills
**What it does:** Sweep supports `SWEEP.md`, custom prompts, and skills for persistent project instructions. The rules file can store build/test/lint commands, style conventions, architecture notes, and business rules; docs also say Sweep can fall back to `CLAUDE.md` or `AGENTS.md`.
**Why distinctive:** Persistent repo guidance is treated as a core operating surface, not just ad hoc prompt text, and Sweep acknowledges existing agent-instruction conventions instead of forcing a closed format.
**TORQUE relevance:** HIGH - TORQUE already depends on repo-specific instructions, verify commands, and agent policy, so this is a close conceptual fit.

## Feature 5: Next-edit autocomplete
**What it does:** Sweep predicts the next edit and can move the cursor to the next likely change location, so repetitive edits can be accepted or navigated with `Tab`.
**Why distinctive:** This is not just text completion; it predicts edit intent plus navigation, which makes it feel more like an editing copilot than a chat wrapper.
**TORQUE relevance:** LOW - strong IDE ergonomics, but not especially relevant to TORQUE's orchestration, routing, dashboard, or MCP governance model.

## Verdict
Sweep is worth studying more as a product and operator-experience reference than as a direct TORQUE analogue. The current repo/docs have clearly pivoted from the original GitHub-issue "junior developer" framing toward a JetBrains-first assistant, so the strongest takeaways for TORQUE are MCP tool-surface discipline, earlier review/verification, and first-class repo instruction files.
