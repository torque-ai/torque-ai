# Findings: gptme

**Tagline:** Tiny terminal agent built around editable local chat logs and explicit tool calls.
**Stars:** 4.3k (GitHub, 2026-04-12)
**Language:** Python (96.6%)

## Feature 1: Editable Local Conversation Logs
**What it does:** gptme persists each chat in a local `conversation.jsonl` log and exposes utilities to list, read, search, and summarize past conversations. It also lets the operator run `/edit`, which converts the history to TOML in `$EDITOR`, validates the edits, and reapplies them.
**Why distinctive:** The transcript is not an opaque memory layer or hosted backend artifact; it is the working state of the assistant and can be manually repaired. That makes history durable, grep-able, and recoverable with ordinary text tooling.
**TORQUE relevance:** HIGH - TORQUE already records task outputs and status, but not a similarly lightweight user-editable conversation substrate. A local transcript artifact for agent and task runs would improve resume flows, debugging, and postmortems without adding much runtime complexity.

## Feature 2: Patch-As-Tool Editing
**What it does:** gptme gives the model an explicit `patch` tool that applies incremental edits using adapted git conflict markers with `ORIGINAL` and `UPDATED` blocks. The docs push small scoped patches, and the implementation returns detailed errors when a patch no longer matches.
**Why distinctive:** File mutation is a first-class contract, not hidden behind prose or whole-file rewrites. That keeps the editing primitive legible, reviewable, and easier to recover from when the model drifts.
**TORQUE relevance:** HIGH - TORQUE already benefits from explicit tool contracts, and gptme is a strong confirmation that patch-first edits scale better than ad hoc rewrite loops. The main lesson is to keep edit protocols narrow and textual so providers, reviewers, and recovery logic all share the same unit of change.

## Feature 3: Guarded Stateful Shell Tool
**What it does:** The `shell` tool runs commands in a stateful bash session, supports background jobs with `bg`, `jobs`, `output`, and `kill`, and feeds command output back into the loop. Its confirmation design also adds hook-based approval, including a shell allowlist hook that auto-confirms safe commands and falls through for the rest.
**Why distinctive:** Many agents either over-trust shell execution or wall it off behind generic sandboxing. gptme treats shell as a powerful local capability but still gives operators a concrete confirmation boundary.
**TORQUE relevance:** HIGH - TORQUE's tool surface would benefit from the same split between safe auto-approve paths and explicit approval for risky commands. The background-job pattern is also directly relevant for long-running local tools, dev servers, and iterative verification.

## Feature 4: TTY-First Control Surface
**What it does:** The product centers the terminal interface rather than treating CLI as a thin wrapper over a web UI: the README highlights diff and syntax highlighting, tab completion, and command history. The command surface also includes `/log`, `/edit`, `/replay`, `/model`, `/tokens`, `/context`, and keyboard shortcuts like `Ctrl+X Ctrl+E` and `Ctrl+J`.
**Why distinctive:** This feels like an operator console for long-lived local sessions, not just a chat box in a terminal. Model switching, transcript inspection, and context and cost introspection stay in-band terminal actions instead of moving into settings panels or dashboards.
**TORQUE relevance:** MEDIUM - TORQUE already spans CLI, MCP, and dashboard surfaces, so it cannot be as terminal-pure as gptme. But the lesson is strong: high-frequency operator controls should stay one command away in the shell instead of being buried in web-only flows.

## Feature 5: Tiny-Core Architecture as a Product Constraint
**What it does:** gptme has an explicit "Are we tiny?" page that tracks startup time and per-file LOC, and it keeps major behavior concentrated in relatively small modules such as `gptme/chat.py` at 395 LOC and `gptme/tools/base.py` at 574 LOC. The project states directly that keeping the codebase small and simple is a core goal because simpler code is easier for both humans and AI to work with.
**Why distinctive:** Most agent projects talk about extensibility and power, then accept framework sprawl as inevitable. gptme treats smallness itself as an architectural feature and measures it publicly.
**TORQUE relevance:** MEDIUM - TORQUE is solving a broader orchestration problem and will not collapse to gptme's size envelope. The useful takeaway is narrower: keep local agent loops, edit primitives, and transcript management in compact modules that stay inspectable without a full system tour.

## Verdict
gptme is worth studying less as a feature superset and more as a lower bound for how small a serious local agent can stay. The best ideas for TORQUE are the editable on-disk transcript, the patch-first edit contract, and the guarded shell model with allowlist-based confirmation. Its clearest challenge to larger systems is architectural discipline: keep state visible, tool boundaries explicit, and the core small enough that an operator can still understand it.
