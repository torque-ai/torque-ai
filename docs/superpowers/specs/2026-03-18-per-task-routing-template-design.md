# Per-Task Routing Template Selection

**Date:** 2026-03-18
**Status:** Approved
**Scope:** Add `routing_template` parameter to submit_task, create_workflow, and add_workflow_task. Update LLM-facing documentation so Claude/Codex always use it.

## Problem

Routing templates can only be set globally — one template for the entire system. This means all concurrent tasks use the same cost/quality/speed tradeoff. Users can't run test generation with "Cost Saver" while simultaneously running a security audit with "Quality First."

Additionally, LLM agents (Claude, Codex) don't know routing templates exist and never specify them when submitting tasks. The feature is invisible to the primary users.

## Solution

Add an optional `routing_template` parameter to task and workflow submission. Store it in task metadata. Resolve it during routing before falling back to the global template. Update all LLM-facing documentation to advertise the feature.

## Design

### Parameter

New optional parameter on three MCP tools:

```
submit_task({ ..., routing_template: "Cost Saver" })
create_workflow({ ..., routing_template: "Quality First" })
add_workflow_task({ ..., routing_template: "Free Speed" })
```

Accepts template name (`"Cost Saver"`) or ID (`"preset-cost-saver"`). Resolved via `resolveTemplateByNameOrId()` which tries ID lookup first, falls back to name lookup.

### Resolution Order

When a task enters `analyzeTaskForRouting`:

1. **Explicit `provider` on task** → use directly, skip all template routing
2. **Task-level `routing_template`** (from `task.metadata._routing_template`) → resolve template, use its chain
3. **Workflow-level `routing_template`** (inherited by tasks without their own) → resolve template, use its chain
4. **Global active template** (from `config.active_routing_template`) → existing behavior
5. **Hardcoded routing rules** → fallback
6. **Default provider** → last resort

Steps 2-3 are new. Everything else is existing behavior.

### Storage

**Task-level:** Stored in `task.metadata._routing_template` as a string (name or ID). Set by `submit_task` handler when the parameter is provided.

**Workflow-level:** Stored in `workflow.metadata._routing_template`. When `add_workflow_task` creates a task, it inherits the workflow's `_routing_template` into the task's metadata unless the task specifies its own.

**Per-step override:** `add_workflow_task({ routing_template: "Free Speed" })` sets `_routing_template` on that specific task, overriding the workflow default.

### Template Resolution Function

New function in `routing/template-store.js`:

```js
function resolveTemplateByNameOrId(value) {
  if (!value || !db) return null;
  // Try ID first (exact match)
  const byId = getTemplate(value);
  if (byId) return byId;
  // Fall back to name (case-insensitive)
  const byName = getTemplateByName(value);
  if (byName) return byName;
  return null;
}
```

### Routing Integration

In `provider-routing-core.js` `analyzeTaskForRouting`, before the global template check:

```js
// Per-task routing template (overrides global)
const taskMeta = options.taskMetadata || {};
const taskTemplateName = taskMeta._routing_template;
if (taskTemplateName && categoryClassifier && templateStore) {
  const taskTemplate = templateStore.resolveTemplateByNameOrId(taskTemplateName);
  if (taskTemplate) {
    const category = categoryClassifier.classify(taskDescription, files);
    const complexity = hostManagementFns?.determineTaskComplexity
      ? hostManagementFns.determineTaskComplexity(taskDescription, files)
      : 'normal';
    const resolved = templateStore.resolveProvider(taskTemplate, category, complexity);
    if (resolved) {
      const providerConfig = getProvider(resolved.provider);
      if (providerConfig && providerConfig.enabled) {
        return maybeApplyFallback({
          provider: resolved.provider,
          model: resolved.model,
          chain: resolved.chain,
          rule: null,
          complexity,
          reason: `Task template '${taskTemplate.name}': ${category} -> ${resolved.provider}`,
        });
      }
    }
  }
}
```

This block goes BEFORE the existing global template block (lines ~459-493).

### Workflow Inheritance

In the workflow task creation handler (`handlers/workflow-handlers.js` or equivalent), when creating a task for a workflow step:

```js
// Inherit routing_template from workflow if task doesn't specify one
if (workflow.metadata?._routing_template && !taskMetadata._routing_template) {
  taskMetadata._routing_template = workflow.metadata._routing_template;
}
```

### MCP Tool Definition Updates

**submit_task** — add to `properties`:
```js
routing_template: {
  type: 'string',
  description: 'Name or ID of a routing template for provider selection (e.g. "Cost Saver", "Quality First", "Free Agentic"). Controls which provider+model fallback chain is used. If omitted, uses the globally active template. Available presets: System Default (codex for hard, free for easy), Quality First (codex primary), Cost Saver (free first, codex last resort), Cloud Sprint (cerebras speed), Free Agentic (zero-cost chains), Free Speed (sub-second + codex safety net), All Local (privacy).',
}
```

**create_workflow** — add same parameter.

**add_workflow_task** — add same parameter with note: "Overrides the workflow-level routing template for this specific task."

### smart_submit_task

The `smart_submit_task` tool already calls `analyzeTaskForRouting`. It should pass through `routing_template` if provided:

```js
// In smart_submit_task handler:
if (params.routing_template) {
  taskMetadata._routing_template = params.routing_template;
}
```

### LLM-Facing Documentation

#### MCP Tool Descriptions (in tool-defs)

The `submit_task` description already explains providers. Add routing template guidance:

```
Submit a task for execution. By default uses smart routing to select
the optimal provider. Set routing_template to control the provider
fallback chain (e.g. "Quality First" for codex-primary, "Cost Saver"
for free-first).
```

#### CLAUDE.md Section

Add to the project's CLAUDE.md under TORQUE usage:

```markdown
## TORQUE Routing Templates

When submitting tasks via TORQUE, choose a routing template that matches the work:

| Template | Strategy | Use For |
|----------|----------|---------|
| "Quality First" | Codex primary, 675B-1T free fallback | Security audits, architecture, complex features |
| "Cost Saver" | Free models first, codex last resort | Tests, docs, simple edits, batch operations |
| "Free Speed" | Sub-second cerebras/groq, codex safety net | Quick fixes, batch processing, simple tasks |
| "System Default" | Codex for hard, free for easy | General daily work |
| "Free Agentic" | Zero-cost, 5 free providers, no codex | Budget-zero operations |

**Usage:**
- `submit_task({ task: "...", routing_template: "Cost Saver" })`
- `create_workflow({ ..., routing_template: "Quality First" })`
- `add_workflow_task({ ..., routing_template: "Free Speed" })` — overrides workflow default

**When to use which:**
- Writing tests → "Cost Saver" (free models handle tests well)
- Security/architecture → "Quality First" (codex for accuracy)
- Batch of simple edits → "Free Speed" (sub-second turnaround)
- Complex feature implementation → "Quality First" or "System Default"
- Budget-conscious batch → "Free Agentic" (zero cost)
```

#### TORQUE Plugin CLAUDE.md

If TORQUE has its own plugin CLAUDE.md (read by Claude at session start), add the same table there.

## File Structure

| File | Change |
|------|--------|
| `server/routing/template-store.js` | Add `resolveTemplateByNameOrId`, export it |
| `server/db/provider-routing-core.js` | Add per-task template resolution block before global template block |
| `server/tool-defs/task-defs.js` | Add `routing_template` parameter to `submit_task` |
| `server/tool-defs/automation-defs.js` | Add `routing_template` to `smart_submit_task` |
| `server/tool-defs/workflow-defs.js` | Add `routing_template` to `create_workflow` and `add_workflow_task` |
| `server/handlers/task-handlers.js` | Store `routing_template` in task metadata on submission |
| `server/handlers/workflow-handlers.js` | Store on workflow, inherit to tasks |
| `server/tests/agentic-routing.test.js` | Add per-task template resolution tests |
| `CLAUDE.md` (project) | Add routing template guidance section |

## Testing Strategy

- Unit test: `resolveTemplateByNameOrId` resolves by name, by ID, returns null for unknown
- Unit test: task with `_routing_template` in metadata uses that template instead of global
- Unit test: workflow `_routing_template` inherited by tasks without their own
- Unit test: per-step override takes priority over workflow default
- Unit test: explicit `provider` on task bypasses template entirely
- Integration test: submit task with `routing_template: "Free Speed"`, verify it routes to cerebras

## What Doesn't Change

- Global template activation (`activate_routing_template`) — still works, serves as default
- Template schema — no changes to `routing_templates` table
- Chain resolution — `resolveProvider` unchanged
- Fallback retry — `executeWithFallback` unchanged
- Dashboard — existing UI unchanged (per-task templates are set via MCP, not dashboard)
