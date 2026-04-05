# Documentation Sweep Findings

**Date:** 2026-04-05
**Scope:** `CLAUDE.md`, `docs/`, `server/docs/`
**Scanner:** documentation variant

## Summary

Five new documentation issues were found in the scoped files.

Items already fixed earlier this session were not re-reported here: the `~590` total tool count update, the 14-command `CLAUDE.md` table, the recent snapscope table refresh, and the `server/docs/README.md` count fix.

I did not find any new broken local markdown links inside the scoped files.

## Findings

### F-DOC-09: `server/docs/api/tool-reference.md` no longer matches the live MCP surface (HIGH)

**Location:** `server/docs/api/tool-reference.md:3-5`, `server/docs/api/tool-reference.md:382-383`, `server/docs/api/tool-reference.md:456-457`, `server/docs/api/tool-reference.md:710`

**Problem:** The file still presents itself as a complete tool reference, but it now includes removed tools and omits many current core tools.

**Evidence:**
- The document header says it is a "Complete reference for all TORQUE MCP tools."
- It still lists removed tools: `run_llm_safeguards`, `configure_llm_safeguards`, `link_github_issue`, `list_github_issues`, and `subscribe_task_events`.
- Current Tier 1 tools in `server/core-tools.js:18-34` include `await_restart`, `unlock_tier`, `task_info`, `await_workflow`, `await_task`, `submit_scout`, `create_diffusion_plan`, and `get_context`, but none of those appear in the reference.
- `server/tools.js:26` builds the live built-in tool list from the registered tool-definition modules. Comparing the backticked tool names in the markdown file against `server/tools.js` shows 5 doc-only tool names and 178 live tool names missing from the document.

**Impact:** The published reference is not reliable for onboarding or automation clients. Readers can be directed to tools that no longer exist while missing current core control-plane tools.

**Status:** ACTIONABLE

### F-DOC-10: `server/docs/api/rest-api.md` only documents a legacy slice of the API and misses the current discovery and v2 surfaces (HIGH)

**Location:** `server/docs/api/rest-api.md:54-320`

**Problem:** The REST reference covers a small legacy subset plus old dashboard routes, but it omits the discovery endpoints and the current v2/control-plane API surface.

**Evidence:**
- The file has no documented coverage for `GET /api/openapi.json`, `GET /api/version`, `GET /api/tools`, or generic `POST /api/tools/:tool_name`.
- Those endpoints are live in `server/api-server.core.js:823-833` and `server/api-server.core.js:929-940`.
- The current route table also exposes the v2 surface beginning at `server/api/routes.js:107` (`/api/v2/inference`) and `server/api/routes.js:203` (`/api/v2/tasks`), with additional provider, workflow, governance, analytics, routing, and infrastructure routes throughout the same file.
- Counting the exported route table shows 428 `/api/v2/*` routes, while `server/docs/api/rest-api.md` contains no `/api/v2` coverage at all.

**Impact:** External integrations have no published path to the OpenAPI document, tool discovery endpoint, generic REST tool bridge, or the v2 control-plane API that the server actually exposes.

**Status:** ACTIONABLE

### F-DOC-11: REST and provider-guide examples no longer validate against current schemas and routes (HIGH)

**Locations:**
- `server/docs/api/rest-api.md:19-21`
- `server/docs/api/rest-api.md:91-97`
- `docs/guides/providers.md:116-121`
- `docs/guides/providers.md:207-209`

**Problem:** Several copy/paste examples use retired providers, nonexistent endpoints, or the wrong request field names.

**Evidence:**
- `server/docs/api/rest-api.md` says to set an API key with `configure { key: "api_key", value: "your-secret-key" }`, but the `configure` tool schema in `server/tool-defs/task-defs.js:8-24` only exposes `max_concurrent` and `default_timeout`, and `handleConfigure` in `server/handlers/task/core.js:1190-1210` only processes those fields.
- The same REST reference uses `provider: "hashline-ollama"` in its submit example, but the live provider enum in `server/tool-defs/task-submission-defs.js:44-56` no longer includes `hashline-ollama`.
- `docs/guides/providers.md` tells readers to enable DeepInfra with `POST /api/providers/deepinfra`, but the live routes are `POST /api/providers/configure` and the v2 provider control-plane routes in `server/api/routes.js:93-97` and `server/api/routes.js:659-671`. There is no `POST /api/providers/:provider` route.
- The same guide shows `smart_submit_task { description: "...", routing_template: "Cost Saver" }`, but the `smart_submit_task` schema uses `task`, not `description` (`server/tool-defs/integration-defs.js:430-435`, `server/tool-defs/integration-defs.js:501`).

**Impact:** These examples fail when used verbatim and are likely to create false bug reports from first-time integrators.

**Status:** ACTIONABLE

### F-DOC-12: `server/docs/guides/setup.md` has stale runtime, storage, and provider-default onboarding details (HIGH)

**Location:** `server/docs/guides/setup.md:7`, `server/docs/guides/setup.md:48`, `server/docs/guides/setup.md:96`, `server/docs/guides/setup.md:106`, `server/docs/guides/setup.md:200-202`, `server/docs/guides/setup.md:237`

**Problem:** The setup guide still describes an older runtime and storage model.

**Evidence:**
- It says Node.js `18.0+`, but both package manifests require Node `>=20.0.0` (`package.json:18`, `server/package.json:48`).
- It says the database/data directory lives under `~/.local/share/torque/`, but the live default resolution order uses `~/.torque` (`server/data-dir.js:9-13`, `server/data-dir.js:28`).
- It lists `hashline-ollama` as both `default_provider` and `smart_routing_default_provider`, but `hashline-ollama` is no longer part of the live provider registry or task-submission enum (`server/providers/registry.js:22-30`, `server/tool-defs/task-submission-defs.js:44-56`).
- It still points readers to "All 462+ MCP tools" even though the live surface is 590 total tools.

**Impact:** This is a first-run onboarding document. Wrong runtime requirements and wrong data-path/provider defaults are likely to break installs or mislead operators during setup and migration.

**Status:** ACTIONABLE

### F-DOC-13: Both provider guides still teach the removed Hashline provider model instead of the current provider roster (MEDIUM)

**Location:** `server/docs/guides/providers.md:7-16`, `server/docs/guides/providers.md:35-44`, `server/docs/guides/providers.md:183-196`, `server/docs/guides/providers.md:264-289`; `docs/guides/providers.md:7-11`, `docs/guides/providers.md:50-56`, `docs/guides/providers.md:174-176`, `docs/guides/providers.md:223`

**Problem:** The provider guides still present `hashline-ollama` / Hashline-Ollama as a current first-class provider and routing target, even though it has been removed from the live provider set.

**Evidence:**
- `server/docs/guides/providers.md` still lists `hashline-ollama` in the provider table, the default routing rules, fallback chains, instruction-template example, and provider-stats example.
- `docs/guides/providers.md` still has a dedicated `Hashline-Ollama` section and describes fallback/concurrency behavior around it.
- The current live providers are `ollama`, `codex`, `codex-spark`, `claude-cli`, `anthropic`, `groq`, `hyperbolic`, `deepinfra`, `ollama-cloud`, `cerebras`, `google-ai`, and `openrouter` (`server/providers/registry.js:22-30`, `server/tool-defs/task-submission-defs.js:44-56`).

**Impact:** Provider-selection docs are steering users toward a removed provider and simultaneously hiding several current providers, especially `codex-spark`, `cerebras`, `google-ai`, `ollama-cloud`, and `openrouter`.

**Status:** ACTIONABLE
