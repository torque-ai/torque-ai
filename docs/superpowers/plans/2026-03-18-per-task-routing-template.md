# Per-Task Routing Template Selection Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let tasks and workflows specify which routing template to use, so concurrent work can have different cost/quality/speed tradeoffs — and update LLM-facing documentation so Claude/Codex always use the feature.

**Architecture:** Add `routing_template` parameter to submit_task, smart_submit_task, create_workflow, and add_workflow_task. Store in task metadata. `analyzeTaskForRouting` checks task-level template before global. Add `resolveTemplateByNameOrId` to template-store.js. Update CLAUDE.md and tool descriptions.

**Tech Stack:** Node.js (CommonJS), Vitest

**Spec:** `docs/superpowers/specs/2026-03-18-per-task-routing-template-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `server/routing/template-store.js` | Add `resolveTemplateByNameOrId` — resolves by ID first, name fallback |
| `server/tool-defs/task-submission-defs.js` | Add `routing_template` parameter to `submit_task` |
| `server/tool-defs/integration-defs.js` | Add `routing_template` parameter to `smart_submit_task` |
| `server/tool-defs/workflow-defs.js` | Add `routing_template` to `create_workflow` and `add_workflow_task` |
| `server/handlers/task/core.js` | Pass `routing_template` through to smart routing and store in metadata |
| `server/handlers/integration/routing.js` | Pass `routing_template` to `analyzeTaskForRouting` via options |
| `server/handlers/workflow/index.js` | Store `routing_template` on workflow, inherit to tasks |
| `server/db/provider-routing-core.js` | Add per-task template resolution before global template block |
| `server/tests/agentic-routing.test.js` | Add per-task template resolution tests |
| `CLAUDE.md` (SpudgetBooks project) | Add routing template guidance section |

---

### Task 1: resolveTemplateByNameOrId

**Files:**
- Modify: `server/routing/template-store.js`
- Modify: `server/tests/agentic-routing.test.js`

- [ ] **Step 1: Write failing tests**

Append to `server/tests/agentic-routing.test.js`:

```js
describe('resolveTemplateByNameOrId', () => {
  it('resolves a template by exact ID', () => { ... });
  it('resolves a template by name', () => { ... });
  it('prefers ID match over name match', () => { ... });
  it('returns null for unknown value', () => { ... });
  it('returns null for null/undefined/empty', () => { ... });
});
```

Use the existing test setup pattern — `template-store.js` needs a DB mock. Read how existing `resolveProvider` tests initialize the store.

- [ ] **Step 2: Implement resolveTemplateByNameOrId**

Add to `server/routing/template-store.js` before `module.exports`:

```js
function resolveTemplateByNameOrId(value) {
  if (!value || !db) return null;
  // Try ID first (exact match)
  const byId = getTemplate(value);
  if (byId) return byId;
  // Fall back to name
  const byName = getTemplateByName(value);
  if (byName) return byName;
  return null;
}
```

Add to `module.exports`: `resolveTemplateByNameOrId`.

- [ ] **Step 3: Run tests**

Run: `cd C:/Users/Werem/Projects/torque-public && npx vitest run server/tests/agentic-routing.test.js`

- [ ] **Step 4: Commit**

```bash
cd C:/Users/Werem/Projects/torque-public
git add server/routing/template-store.js server/tests/agentic-routing.test.js
git commit -m "feat(routing): add resolveTemplateByNameOrId for per-task template lookup"
```

---

### Task 2: Add routing_template to MCP Tool Definitions

**Files:**
- Modify: `server/tool-defs/task-submission-defs.js`
- Modify: `server/tool-defs/integration-defs.js`
- Modify: `server/tool-defs/workflow-defs.js`

- [ ] **Step 1: Add to submit_task**

In `server/tool-defs/task-submission-defs.js`, add to `properties` (after `tuning`, before the closing `}`):

```js
"routing_template": {
  "type": "string",
  "description": "Name or ID of a routing template for provider selection (e.g. 'Cost Saver', 'Quality First', 'Free Agentic'). Controls which provider+model fallback chain is used for this task. If omitted, uses the globally active template. Available presets: System Default (codex for hard, free for easy), Quality First (codex primary), Cost Saver (free first, codex last resort), Cloud Sprint (cerebras speed), Free Agentic (zero-cost chains), Free Speed (sub-second + codex safety net), All Local (privacy)."
}
```

- [ ] **Step 2: Add to smart_submit_task**

In `server/tool-defs/integration-defs.js`, find the `smart_submit_task` tool definition (line ~430). Add the same `routing_template` property to its `inputSchema.properties`.

- [ ] **Step 3: Add to create_workflow**

In `server/tool-defs/workflow-defs.js`, find `create_workflow` (line ~84). Add to its properties:

```js
routing_template: {
  type: 'string',
  description: 'Default routing template for all tasks in this workflow. Individual tasks can override via add_workflow_task. Accepts template name or ID.',
}
```

- [ ] **Step 4: Add to add_workflow_task**

In `server/tool-defs/workflow-defs.js`, find `add_workflow_task`. Add:

```js
routing_template: {
  type: 'string',
  description: 'Routing template for this specific task (overrides workflow default). Accepts template name or ID.',
}
```

- [ ] **Step 5: Commit**

```bash
cd C:/Users/Werem/Projects/torque-public
git add server/tool-defs/task-submission-defs.js server/tool-defs/integration-defs.js server/tool-defs/workflow-defs.js
git commit -m "feat(routing): add routing_template parameter to submit_task, smart_submit_task, create_workflow, add_workflow_task"
```

---

### Task 3: Wire routing_template Through Handlers

**Files:**
- Modify: `server/handlers/task/core.js`
- Modify: `server/handlers/integration/routing.js`
- Modify: `server/handlers/workflow/index.js`

- [ ] **Step 1: Pass through in handleSubmitTask**

In `server/handlers/task/core.js` `handleSubmitTask` (line 177), the auto_route branch delegates to `handleSmartSubmitTask` (lines 182-192). Add `routing_template` to the passthrough:

```js
return handleSmartSubmitTask({
  task: args.task,
  working_directory: args.working_directory,
  timeout_minutes: args.timeout_minutes,
  priority: args.priority,
  model: args.model,
  files: args.files,
  context_stuff: args.context_stuff,
  context_depth: args.context_depth,
  tuning: args.tuning,
  routing_template: args.routing_template,  // NEW
});
```

For the non-auto-route path (explicit provider), store `routing_template` in task metadata if provided:

```js
// After taskId creation (~line 210), build metadata:
const metadata = {};
if (args.routing_template) metadata._routing_template = args.routing_template;
```

Include `metadata: Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : undefined` in the task insert.

- [ ] **Step 2: Pass through in handleSmartSubmitTask**

In `server/handlers/integration/routing.js` `handleSmartSubmitTask` (line 264):

1. Destructure `routing_template` from args (line 271)
2. Pass it to `analyzeTaskForRouting` via options:
   ```js
   const routingResult = analyzeTaskForRouting(task, working_directory, files, {
     ...existingOptions,
     taskMetadata: { _routing_template: routing_template },
   });
   ```
3. Store in task metadata when creating the task record

- [ ] **Step 3: Wire workflow creation**

In `server/handlers/workflow/index.js` `handleCreateWorkflow` (line 565):

1. Read `args.routing_template`
2. Store it in workflow metadata:
   ```js
   const workflowMetadata = {};
   if (args.routing_template) workflowMetadata._routing_template = args.routing_template;
   ```
3. Pass metadata to workflow creation

For `add_workflow_task` handler: if `args.routing_template` is set, store in task metadata. If not, inherit from workflow's `_routing_template`.

- [ ] **Step 4: Commit**

```bash
cd C:/Users/Werem/Projects/torque-public
git add server/handlers/task/core.js server/handlers/integration/routing.js server/handlers/workflow/index.js
git commit -m "feat(routing): wire routing_template through task and workflow handlers"
```

---

### Task 4: Per-Task Template Resolution in Routing

**Files:**
- Modify: `server/db/provider-routing-core.js`
- Modify: `server/tests/agentic-routing.test.js`

- [ ] **Step 1: Write failing tests**

Append to `server/tests/agentic-routing.test.js`:

```js
describe('per-task routing template', () => {
  it('task with _routing_template uses that template instead of global', () => { ... });
  it('task without _routing_template falls through to global template', () => { ... });
  it('resolves template by name from task metadata', () => { ... });
  it('resolves template by ID from task metadata', () => { ... });
  it('unknown template name falls through to global', () => { ... });
});
```

These tests need to mock `templateStore.resolveTemplateByNameOrId` and `analyzeTaskForRouting`.

- [ ] **Step 2: Add per-task template block to analyzeTaskForRouting**

In `server/db/provider-routing-core.js`, in `analyzeTaskForRouting` (line 261), add the per-task template block BEFORE the existing global template block (lines ~459-493):

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
      const provConfig = getProvider(resolved.provider);
      if (provConfig && provConfig.enabled) {
        return maybeApplyFallback({
          provider: resolved.provider,
          model: resolved.model,
          chain: resolved.chain,
          rule: null,
          complexity,
          reason: `Task template '${taskTemplate.name}': ${category} -> ${resolved.provider}`,
        });
      }
      // Primary unavailable — try chain fallback
      if (resolved.chain && resolved.chain.length > 1) {
        for (let i = 1; i < resolved.chain.length; i++) {
          const fb = resolved.chain[i];
          const fbConfig = getProvider(fb.provider);
          if (fbConfig && fbConfig.enabled) {
            return maybeApplyFallback({
              provider: fb.provider, model: fb.model, chain: resolved.chain,
              rule: null, complexity,
              reason: `Task template '${taskTemplate.name}': ${category} -> ${resolved.provider} (unavailable), chain fallback to ${fb.provider}`,
            });
          }
        }
      }
    }
    // Template found but no provider available — fall through to global
  }
  // Template not found — fall through to global
}
```

- [ ] **Step 3: Run tests**

Run: `cd C:/Users/Werem/Projects/torque-public && npx vitest run server/tests/agentic-routing.test.js`

- [ ] **Step 4: Commit**

```bash
cd C:/Users/Werem/Projects/torque-public
git add server/db/provider-routing-core.js server/tests/agentic-routing.test.js
git commit -m "feat(routing): per-task template resolution in analyzeTaskForRouting"
```

---

### Task 5: LLM-Facing Documentation

**Files:**
- Modify: `C:/Users/Werem/Projects/SpudgetBooks/CLAUDE.md`

- [ ] **Step 1: Add routing template section to CLAUDE.md**

In the SpudgetBooks project `CLAUDE.md`, add after the "Agent Surface (MCP / SOS)" section:

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
| "Cloud Sprint" | Cerebras everywhere, codex fallback | Maximum speed batches |
| "All Local" | Local ollama, codex for complex only | Privacy-sensitive work |

**Usage:**
```powershell
# Per-task:
submit_task({ task: "...", routing_template: "Cost Saver" })
smart_submit_task({ task: "...", routing_template: "Quality First" })

# Per-workflow (all tasks inherit):
create_workflow({ name: "...", routing_template: "Cost Saver", tasks: [...] })

# Per-step override:
add_workflow_task({ workflow_id: "...", task: "...", routing_template: "Quality First" })
```

**Guidelines:**
- Always specify `routing_template` when submitting tasks — don't rely on the global default
- Use "Cost Saver" or "Free Speed" for test generation, documentation, and batch edits
- Use "Quality First" for security, architecture, and complex feature work
- Use "System Default" when unsure — it balances codex for hard work with free for easy
```

- [ ] **Step 2: Commit**

```bash
cd C:/Users/Werem/Projects/SpudgetBooks
git add CLAUDE.md
git commit -m "docs: add TORQUE routing template guidance to CLAUDE.md"
```

---

### Task 6: Integration Test and Verification

- [ ] **Step 1: Run all agentic tests**

Run: `cd C:/Users/Werem/Projects/torque-public && npx vitest run server/tests/agentic-routing.test.js`
Expected: all tests pass including new per-task template tests.

- [ ] **Step 2: Restart TORQUE and verify live**

Restart TORQUE, then submit a task with `routing_template`:

```
submit_task({
  task: "Use list_directory to list tests/",
  working_directory: "C:/Users/Werem/Projects/SpudgetBooks",
  routing_template: "Free Speed"
})
```

Verify: routing decision says "Task template 'Free Speed'" (not global template).

- [ ] **Step 3: Verify workflow inheritance**

```
create_workflow({
  name: "test-routing",
  routing_template: "Cost Saver",
  tasks: [{ task: "list tests/", working_directory: "C:/Users/Werem/Projects/SpudgetBooks" }]
})
```

Verify: task inherits "Cost Saver" routing.

- [ ] **Step 4: Push**

```bash
cd C:/Users/Werem/Projects/torque-public && git push
```
