# Findings: fabric

**Tagline:** Human-readable prompt library with a Unix-style AI CLI.
**Stars:** 40.6k (GitHub, 2026-04-12)
**Language:** Go (71.3%)

## Feature 1: Filesystem-Native Pattern Library
**What it does:** Fabric keeps its prompt corpus as a directory tree of patterns, with one folder per task and prompt content stored in Markdown files such as `system.md`. It also supports a separate custom patterns directory whose entries override built-in patterns without modifying the upstream library.
**Why distinctive:** The prompt library is treated as content, not as hard-coded strings in app logic or opaque database rows. That makes the corpus easy to diff, fork, curate, and reuse outside Fabric itself.
**TORQUE relevance:** HIGH - TORQUE already has Plan 37 in `.torque/rules` and Plan 61 in `.torquefn`, but Fabric points to a complementary prompt-corpus layer optimized for humans. A separate Markdown prompt library would make reusable operator playbooks and domain-specific prompt assets easier to browse, version, and share.

## Feature 2: Markdown-First Prompt Authoring
**What it does:** Fabric patterns are authored directly in Markdown and usually center on a strong system prompt with explicit sections for identity, steps, and output instructions. The `extract_wisdom` pattern is representative: it is readable as plain text while still being the runtime artifact sent to the model.
**Why distinctive:** Markdown is serving as both authoring format and runtime prompt asset, so readability for humans and structure for models stay aligned. Fabric is opinionated about explicit instructions and output shape without hiding prompt engineering behind a builder UI.
**TORQUE relevance:** HIGH - This matches how teams already document procedures, which lowers the barrier to maintaining prompt assets next to plans and operational docs. TORQUE could benefit from keeping prompt recipes editable by operators without requiring code edits or a custom visual editor.

## Feature 3: Pipe-Friendly CLI and Pattern-as-Verb UX
**What it does:** Fabric is designed to read from stdin and write to stdout, so flows like `pbpaste | fabric --pattern summarize` or URL and YouTube ingestion into a named pattern are first-class. It also supports shell aliases that effectively turn each pattern into its own command and optional file-output flows for Markdown note vaults.
**Why distinctive:** Many AI frameworks want users inside their app or graph runtime. Fabric instead behaves like a Unix text filter, which makes AI augmentation composable with the rest of the shell.
**TORQUE relevance:** HIGH - TORQUE's workflow system handles long-running automation, but a tiny prompt-filter CLI layer would help with fast pre-processing and post-processing around tasks. That is especially relevant for logs, diffs, transcripts, notes, and other operator-generated artifacts.

## Feature 4: Templated Variables and Catalog Metadata
**What it does:** Fabric patterns support variables such as `{{input}}` and user-supplied placeholders passed through CLI `-v` flags or REST `variables` maps, with nested template and plugin expansion available inside patterns. Separately, `pattern_descriptions.json` stores short descriptions and tags so the library is searchable and UI-friendly instead of being just a pile of prompt files.
**Why distinctive:** This is a light structure layer rather than a heavy agent DSL. Prompts stay plain Markdown, but they can still be parameterized per invocation and cataloged with enough metadata for discovery, reuse, and interface selection.
**TORQUE relevance:** HIGH - TORQUE could adopt the same model to add task-scoped parameterization and searchable tags to prompt assets without inventing a new orchestration language. It is a practical bridge between freeform Markdown rules and more formal workflow definitions.

## Feature 5: Stitching and Helper-Tool Composition
**What it does:** Fabric supports composition through prompt strategies, helper binaries such as `code2context | fabric --pattern create_coding_feature` and `fabric --pattern write_latex | to_pdf`, and explicit stitched-pattern ideas where one step filters content before a later model step. Its REST API also separates extraction from pattern application, making it easy to run multiple downstream patterns on the same upstream artifact.
**Why distinctive:** Composition stays lightweight and legible. Instead of forcing users into a proprietary graph builder, Fabric lets them chain prompt assets and tools with normal shell and HTTP primitives.
**TORQUE relevance:** MEDIUM - TORQUE already has workflow orchestration for serious multi-step automation, so Fabric's stitching model is not a replacement. The relevant idea is the lighter adjacent mode: fast, transparent prompt pipelines that operators can assemble before deciding a flow deserves a full TORQUE DAG.

## Verdict
Fabric is most interesting not as another generic model wrapper, but as a curated, human-readable prompt corpus with just enough runtime around it: stdin/stdout CLI, variables, metadata, and lightweight composition. For TORQUE, the strongest takeaway is to separate prompt knowledge from execution rules by maintaining a Markdown-native pattern library that can be browsed, parameterized, and invoked from both the CLI and workflows. Its stitching model is simpler than TORQUE's DAGs, but that simplicity is exactly what makes it useful.
