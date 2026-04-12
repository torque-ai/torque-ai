# Findings: Continue

**Tagline:** Config-first coding assistant stack that turns rules, prompts, context, and tools into reusable agent surfaces across IDE, CLI, and CI.
**Stars:** 32.5k (GitHub, 2026-04-11)
**Language:** TypeScript (84.4%)

## Feature 1: Rule blocks instead of a single rules file
**What it does:** Continue's current answer to `.continuerules`-style project guidance is a `.continue/rules` directory of Markdown files with YAML frontmatter. Those rules are concatenated into the system message for Agent, Chat, and Edit, and can also be referenced from Mission Control with `uses:`.
**Why distinctive:** Instead of one monolithic rules blob, rules can be scoped with `globs`, `regex`, `description`, and `alwaysApply`, then loaded in deterministic order. That makes policy modular, versioned, and selectively activated by file context rather than treated as one global instruction slab.
**TORQUE relevance:** HIGH - TORQUE already has repo-local commands in `.claude/commands/`, but not an equally clean file-backed rule layer. Continue's rule-block model suggests a way to give TORQUE persistent project guidance that can be auto-selected by file type, workflow, or runtime context.

## Feature 2: Prompt files that become slash commands and workflows
**What it does:** Prompt files are Markdown documents with frontmatter like `name`, `description`, and `invokable`. When `invokable: true`, they show up as `/` commands in Chat, Plan, and Agent, and the same prompt can be called from `config.yaml` or from `cn --prompt` in TUI and headless runs.
**Why distinctive:** Continue treats prompts as reusable content assets instead of hardcoded command handlers. The same prompt artifact can live in Git, be shared from Mission Control through `uses:`, and run across IDE, CLI, and workflow entrypoints with very little translation.
**TORQUE relevance:** HIGH - This is close to TORQUE's `.claude/commands/`, but with a stronger packaging and reuse story. A TORQUE prompt/command layer that works identically in dashboard, CLI, MCP, and scheduled automation would reduce duplicated command definitions.

## Feature 3: Context providers as a pluggable `@` surface
**What it does:** Continue's `context:` array defines what appears behind `@`, including built-ins like file, code, diff, terminal, problems, debugger, and repo-map, plus custom HTTP providers that return `ContextItem` payloads. MCP servers can also expose context, and the docs now steer custom context work toward HTTP and MCP instead of older one-off provider types.
**Why distinctive:** This makes context a first-class plugin boundary rather than a side effect of embeddings or chat memory. Teams can start with built-ins, add thin HTTP adapters, and then graduate to MCP without changing the user interaction model.
**TORQUE relevance:** HIGH - TORQUE already has MCP and a broad tool surface, but its context story is less uniform. Continue's provider model suggests a cleaner way to expose repo state, dashboard telemetry, workflow artifacts, and remote-system summaries as selectable context blocks.

## Feature 4: One YAML manifest for agents, prompts, rules, and MCP
**What it does:** `config.yaml` is the assembly manifest for Continue agents: models, context, rules, prompts, docs indexes, MCP servers, and data sinks all live in one specification. The same file also handles model roles, prompt templates, system-message overrides, and Hub/local composition with `uses:` references.
**Why distinctive:** Continue collapses agent construction into data plus Markdown blocks, rather than scattering it across JSON, plugin code, and per-surface settings. That makes the configuration portable, composable, and much easier to version-review than a mostly imperative extension model.
**TORQUE relevance:** HIGH - TORQUE currently spreads behavior across server config, routing policy, MCP setup, and `.claude/commands/`. A unified manifest could make TORQUE environments easier to reproduce, diff, publish, and load across local and hosted runtimes.

## Feature 5: Shared backend with layered modes and tool policies
**What it does:** Continue separates model roles from interaction modes: models can serve `chat`, `edit`, `apply`, `embed`, and `rerank`, while the UI exposes Chat, Plan, and Agent as capability layers with no tools, read-only tools, or full tools. Agent mode can use native tool calling or Continue's XML-based system-message tools, and tool policies let users mark tools as ask-first, automatic, or excluded.
**Why distinctive:** That split keeps capability gating orthogonal to provider choice. Continue can present conversation, planning, editing, and autonomous tool use on the same backend without redefining the underlying model/config stack for each surface.
**TORQUE relevance:** HIGH - TORQUE already has provider routing and command execution, but it could benefit from a clearer capability ladder on top of the same core runtime. Continue's separation of roles, modes, and tool policies is a strong template for exposing TORQUE as chat, review, planning, and autonomous execution without fragmenting the backend.

## Verdict
Continue's most exportable idea is not any single feature but the way its configuration primitives compose: YAML declares the graph, Markdown files hold behavioral content, and modes decide how much agency to expose. For TORQUE, the strongest borrowings are modular rule/prompt files and a stricter capability ladder across chat, planning, and autonomous execution. Even though the project now spans IDE, CLI, and CI surfaces, the reusable substrate underneath is the same config-first agent platform.
