# Findings: Mentat

**Tagline:** Archived Python CLI coding assistant built around explicit context control and human-approved edits.
**Stars:** 2.6k (GitHub, 2026-04-11)
**Language:** Python (87.9%)

## Feature 1: Hybrid Context Selection
**What it does:** Mentat lets users add or remove files manually, include only line ranges from a file, and optionally turn on auto-context so each request pulls in additional code up to a token budget. Its context engine also mixes in diff references and semantic search results, so the prompt can be narrowed without throwing the whole repo at the model.
**Why distinctive:** The design is opinionated about not over-including code. Instead of treating "the repo" as context, it treats context as a curated working set that can be grown manually, searched semantically, or expanded automatically per request.
**TORQUE relevance:** HIGH - TORQUE workflows already have the notion of targeted files, verify commands, and task-local context. Mentat's line-range includes, diff-aware context, and per-request auto-context budget are strong patterns for reducing prompt bloat in autonomous runs while still letting operators steer what the model sees.

## Feature 2: Human-in-the-Loop Edit Gates
**What it does:** After the model proposes edits, Mentat asks whether to apply all changes, reject them, inspect them interactively, or provide feedback instead of applying. In inspect mode it drills down through file creation, deletion, rename, and individual replacement hunks with explicit keep/discard prompts, and it also warns before overwriting files that changed while the model was generating.
**Why distinctive:** This is a much tighter approval loop than a single global "apply patch" step. The user can progressively narrow the accepted change set without abandoning the conversation, which makes multi-file edits safer and keeps the model in a correction loop instead of a one-shot patch loop.
**TORQUE relevance:** HIGH - This is the clearest pattern TORQUE should borrow. Per-file or per-hunk confirmation gates would make autonomous workflows safer, especially around cross-file edits, generated diffs, and cases where a human wants to approve only the risky subset before execution continues.

## Feature 3: Transcript Viewer and Replayable Logs
**What it does:** Mentat logs transcripts as structured per-session files and exposes them through `/viewer`, which opens the conversation in a browser. The viewer can show the conversation from the model's perspective and lets the operator move through prior conversations, turning raw chat history into an inspectable execution record.
**Why distinctive:** Many coding CLIs show only the live terminal stream. Mentat separates operational logs from a replayable transcript view, which makes it easier to debug bad prompts, inspect what context the model actually saw, and reuse sessions as examples.
**TORQUE relevance:** HIGH - TORQUE already tracks task state, but a prompt-level transcript viewer would improve task review, provider debugging, and postmortems. This is especially relevant for long workflows where operators need to understand not just outputs, but what instructions and context produced them.

## Feature 4: Terminal-Native CLI Ergonomics
**What it does:** Mentat evolved into a full terminal app with a sidebar that shows included files, diff context, token usage, and session cost while the chat continues in the main pane. It also layers in command autocomplete, prompt history, slash commands like `/run`, `/search`, `/save`, `/load`, `/undo`, `/amend`, and `/screenshot`, and a search UI for adding snippets directly to context.
**Why distinctive:** The CLI is not just a text box on top of an LLM. It behaves more like an operations console for an editing session, keeping context state and control commands visible instead of burying them in prose.
**TORQUE relevance:** MEDIUM - TORQUE is broader than a coding CLI, but the UI pattern is strong. A terminal or dashboard surface that keeps workflow context, cost, pending approvals, and quick control actions visible would reduce operator friction without changing the underlying runtime.

## Feature 5: Parser-Pluggable Multi-File Edit Protocol
**What it does:** Mentat tells the model to emit edits in a structured format and supports multiple parser strategies, including block-based and unified-diff style outputs. Those parsers can represent multi-file edits, file creation, deletion, and rename operations before the tool validates and applies them.
**Why distinctive:** The editing boundary is explicit and configurable rather than hidden inside free-form prose. That makes it easier to validate model output, display proposed changes cleanly, and evolve the edit protocol without rewriting the whole product.
**TORQUE relevance:** HIGH - TORQUE already benefits from explicit contracts between planners, executors, and verifiers. Mentat's parser boundary suggests a clean way to standardize model-authored code changes before they hit file mutation or workflow execution paths.

## Verdict
Mentat's CLI is archived, so it is not a good upstream dependency or living product benchmark. The ideas are still strong: hybrid context selection, explicit edit parsers, transcript replay, and especially the apply-all / reject-all / inspect flow are all directly relevant to TORQUE. If TORQUE borrows one concept first, it should be Mentat's fine-grained human approval gate for multi-file edits inside otherwise autonomous workflows.
