# Findings: Smol-Developer

**Tagline:** Markdown-first junior developer that scaffolds apps, then improves them through a tight human feedback loop.
**Stars:** 12.2k (GitHub, 2026-04-11)
**Language:** Python (81.9%)

## Feature 1: Tiny Plan-Then-Generate Pipeline
**What it does:** Smol Developer reduces app generation to a small sequence: write a plan, derive file paths, then generate each file against that shared plan. In library mode these are exposed as `plan`, `specify_file_paths`, and `generate_code_sync`, so the "agent" is really a thin wrapper over a few composable primitives.
**Why distinctive:** Most agent frameworks add planners, tool routers, memory stores, and retry subsystems before they show useful output. Smol Developer is notable because the whole scaffold loop stays legible enough to fit in a small script and still produces multi-file apps.
**TORQUE relevance:** HIGH - TORQUE is richer and more operationally heavy, but this is a strong reminder that many workflows should collapse to a few explicit phases rather than a large agent graph. The design pressure here is toward thinner task contracts, clearer intermediate artifacts, and fewer hidden behaviors.

## Feature 2: `prompt.md` as Durable Product Spec
**What it does:** The repo's demo centers on a checked-in `prompt.md` file that holds the product brief, UI details, API contract snippets, error handling expectations, and even debugging notes. Instead of ephemeral chat context, the spec lives in markdown and can be edited, rerun, and versioned like any other source file.
**Why distinctive:** This turns prompt authoring into ordinary software work: diffable text, explicit requirements, and a durable artifact that survives model runs. The prompt is not just a description of the app; it becomes the main spec surface the rest of the loop depends on.
**TORQUE relevance:** HIGH - TORQUE already benefits from durable task descriptions and plans, and Smol Developer is a sharp example of taking that all the way down to a single spec file. A markdown-first spec artifact could simplify superpower planning, generated workflow inputs, and human review compared with burying intent inside transient chat.

## Feature 3: Shared-Dependencies Pass for Whole-App Coherence
**What it does:** Before file generation, Smol Developer asks the model to think through shared dependencies and then uses that artifact while writing each file. The goal is to keep filenames, exported names, DOM ids, message names, and cross-file references aligned across the generated codebase.
**Why distinctive:** This is a tiny but effective answer to the classic multi-file hallucination problem. Instead of a large memory system or deep code graph analysis, Smol Developer inserts one explicit coherence document between the spec and the code.
**TORQUE relevance:** HIGH - TORQUE workflows that fan out across files or agents often need a shared contract before implementation starts. A lightweight "shared dependencies" artifact could improve consistency across parallel tasks without requiring a full architectural document every time.

## Feature 4: Error-Paste Debugging Loop
**What it does:** The intended workflow is not one-shot generation; the human runs the code, finds missing requirements or errors, and pastes those findings back into the prompt. When that is not enough, `debugger.py` can read the generated codebase and suggest targeted changes.
**Why distinctive:** Smol Developer treats debugging as explicit feedback from the operator rather than as silent autonomous retries. That keeps the loop cheap, understandable, and resilient when the model needs concrete runtime evidence instead of more speculation.
**TORQUE relevance:** HIGH - TORQUE already has verify steps and operator checkpoints, so this maps well to failure-driven replan loops. The key transferable idea is to make user-observed errors first-class workflow input, not just terminal noise attached to a failed task.

## Feature 5: Embeddable Smol Primitives
**What it does:** Smol Developer can run as a repo-local script, as an importable Python library, or behind an Agent Protocol API server. The same README also positions it beside sibling prompt-driven tools like `smol-plugin`, while the broader smol.ai org reuses markdown-first control files in other small utilities such as `pod`'s `rawtext.md`.
**Why distinctive:** The project does not insist on being the only agent runtime in the room. Its useful unit is the primitive scaffold loop, which makes it easy to embed inside other products or pair with neighboring smol tools rather than forcing a full framework adoption.
**TORQUE relevance:** MEDIUM - TORQUE is already an orchestrator, so the direct lesson is not "become smaller" but "make the smallest useful units easier to compose." Smol Developer shows how a thin generation primitive can live underneath larger workflows instead of competing with them.

## Verdict
Smol Developer is still one of the clearest examples of agentic coding without agentic sprawl. Its best ideas for TORQUE are not autonomous breadth but disciplined narrowness: a durable markdown spec, a tiny plan-to-files-to-code pipeline, and a debugging loop that depends on explicit human feedback. As a counterweight to heavier workflow systems, it is a good reminder that some of the highest-leverage orchestration patterns are just well-chosen intermediate artifacts and rerunnable text files.
