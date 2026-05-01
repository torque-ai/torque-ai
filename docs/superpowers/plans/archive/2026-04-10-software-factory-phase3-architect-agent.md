# Software Factory Phase 3: Architect Agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the factory's product mind — a scheduled reasoning process that reads the health model and intake queue, applies product-sense judgment, and produces a prioritized backlog with scope budgets and reasoning visible on the dashboard.

**Architecture:** New DB table `factory_architect_cycles` stores prioritization cycles (input snapshot, reasoning, backlog output). A prompt builder (`server/factory/architect-prompt.js`) assembles context from health scores, intake items, project brief, and work history. An architect runner (`server/factory/architect-runner.js`) executes the prompt and parses structured output into prioritized backlog entries that update the intake queue. MCP tools expose `trigger_architect`, `architect_backlog`, and `architect_log`.

**Tech Stack:** better-sqlite3 (existing), vitest (existing), LLM prompt execution via TORQUE task submission

---

## File Structure

```
server/db/migrations.js                  # Modify: migration v15 for factory_architect_cycles
server/db/factory-architect.js           # Architect cycle CRUD, backlog storage, reasoning log
server/factory/architect-prompt.js       # Builds the structured prompt from health + intake + brief
server/factory/architect-runner.js       # Executes prompt, parses output, updates intake queue
server/handlers/factory-handlers.js      # Modify: add architect handler functions
server/tool-defs/factory-defs.js         # Modify: add architect tool definitions
server/database.js                       # Modify: wire factory-architect into init chain
server/container.js                      # Modify: register factory-architect in DI container
server/core-tools.js                     # Modify: add architect tools to tiers
server/tool-annotations.js              # Modify: add annotations
server/api-server.core.js               # Modify: add architect REST routes
dashboard/src/views/Factory.jsx          # Modify: add Architect Log tab
dashboard/src/api.js                     # Modify: add architect API methods
server/tests/factory-architect.test.js   # Tests
```

---

### Task 1: Database Migration v15 — Architect Cycles Table

**Files:**
- Modify: `server/db/migrations.js` (append v15)
- Modify: `server/database.js` (ALLOWED_MIGRATION_TABLES)

Add migration v15 `add_factory_architect_cycles` creating table:
- id INTEGER PRIMARY KEY AUTOINCREMENT
- project_id TEXT NOT NULL REFERENCES factory_projects(id)
- input_snapshot_json TEXT NOT NULL (health scores + intake items at time of cycle)
- reasoning TEXT NOT NULL (human-readable prioritization explanation)
- backlog_json TEXT NOT NULL (ordered array of prioritized work items with scope budgets)
- flags_json TEXT (items the architect is uncertain about)
- status TEXT NOT NULL DEFAULT 'completed' (completed | failed | in_progress)
- trigger TEXT NOT NULL DEFAULT 'manual' (manual | scheduled | event)
- created_at TEXT NOT NULL DEFAULT (datetime('now'))

Index on project_id + created_at.

Also add `factory_architect_cycles` to ALLOWED_MIGRATION_TABLES in database.js.

After making the edits, stop.

---

### Task 2: Architect DB Module

**Files:**
- Create: `server/db/factory-architect.js`
- Modify: `server/database.js` (require + setDb + facade export)
- Modify: `server/container.js` (registerValue)

Create `server/db/factory-architect.js` with setDb pattern. Exports:

- `createCycle({ project_id, input_snapshot, reasoning, backlog, flags, trigger })` — INSERT, return the cycle
- `getCycle(id)` — SELECT by id, parse JSON fields
- `getLatestCycle(project_id)` — SELECT latest by created_at DESC
- `listCycles(project_id, limit)` — SELECT ordered by created_at DESC, limit default 10
- `getBacklog(project_id)` — get latest cycle's backlog_json parsed as array
- `getReasoningLog(project_id, limit)` — get last N cycles' reasoning text + created_at

Wire into database.js (_wireAllModules, facade export) and container.js (registerValue).

After making the edits, stop.

---

### Task 3: Architect Prompt Builder

**Files:**
- Create: `server/factory/architect-prompt.js`

Create the prompt builder that assembles context for the architect LLM call. Export a single function:

`buildArchitectPrompt({ project, healthScores, intakeItems, previousBacklog, previousReasoning })` returns a string.

The prompt must include:

1. **System context:** "You are the Architect for a software factory. Your job is to prioritize work items based on project health, product sense, and user intent."

2. **Project brief:** The project's `brief` field from factory_projects.

3. **Health scores:** All 10 dimensions with current scores and balance. Highlight the weakest dimension.

4. **Intake queue:** All pending work items with their source, priority, and description.

5. **Previous cycle:** If available, the last backlog and reasoning (for continuity — avoid oscillation).

6. **Product-sense questions:** 
   - "What does a new user encounter first? Is that path solid?"
   - "What breaks the experience if it fails? Is that hardened?"
   - "What has been over-invested relative to its importance? What has been neglected?"
   - "If this shipped today, what would embarrass you?"

7. **Output format instructions:** Ask for JSON output with structure:
   ```
   {
     "reasoning": "Human-readable explanation of prioritization decisions...",
     "backlog": [
       {
         "work_item_id": "id or null for new items",
         "title": "What to do",
         "why": "Which health dimension, user journey, or risk",
         "expected_impact": { "dimension": "score_delta" },
         "scope_budget": 5,
         "priority_rank": 1
       }
     ],
     "flags": [
       { "item": "description", "reason": "why uncertain" }
     ]
   }
   ```

The prompt should be under 4000 tokens to leave room for the response. Truncate intake items if there are more than 20 (keep highest priority).

After creating the file, stop.

---

### Task 4: Architect Runner

**Files:**
- Create: `server/factory/architect-runner.js`

The runner orchestrates a single architect cycle:

`runArchitectCycle(project_id, trigger)` — async function that:

1. Reads the project from factoryHealth.getProject
2. Gets latest health scores via factoryHealth.getLatestScores
3. Gets pending intake items via factoryIntake.listWorkItems({ project_id, status: 'intake' })
4. Gets previous cycle via factoryArchitect.getLatestCycle(project_id) (if any)
5. Builds the prompt via architectPrompt.buildArchitectPrompt
6. For now (Phase 3), returns a **deterministic prioritization** based on health scores — NOT an LLM call. The LLM integration comes in a future phase when we have the factory loop running. The deterministic version:
   - Sorts intake items by: user_override priority first, then by which health dimension they target (weakest dimension items rank highest), then by creation date
   - Generates reasoning text explaining the priority ordering
   - Assigns scope budgets (3-8 tasks based on item complexity heuristic)
7. Records the cycle via factoryArchitect.createCycle
8. Updates intake items to status 'prioritized' via factoryIntake.updateWorkItem
9. Returns the cycle data

Export: `runArchitectCycle`, `prioritizeByHealth` (the deterministic sorter, for testing)

After creating the file, stop.

---

### Task 5: MCP Tools + Handlers + Wiring

**Files:**
- Modify: `server/tool-defs/factory-defs.js` (add 3 tools)
- Modify: `server/handlers/factory-handlers.js` (add 3 handlers)
- Modify: `server/core-tools.js` (add to tiers)
- Modify: `server/tool-annotations.js` (add annotations)
- Modify: `server/api-server.core.js` (add REST routes)

Add 3 tools:

**`trigger_architect`** — Run an architect prioritization cycle for a project. Reads health + intake, produces ranked backlog with reasoning.
- Input: `{ project: string }`
- Calls `runArchitectCycle(project_id, 'manual')`
- Returns: the cycle data (reasoning + backlog + flags)

**`architect_backlog`** — Get the current prioritized backlog for a project (from latest architect cycle).
- Input: `{ project: string }`
- Returns: ordered backlog array with reasoning summary

**`architect_log`** — Get the architect's reasoning history for a project.
- Input: `{ project: string, limit?: number }`
- Returns: last N reasoning entries with timestamps

Add handlers in factory-handlers.js. These use `resolveProject` (already exists) and the new modules.

Add `trigger_architect` and `architect_backlog` to TIER_1 (core). Add `architect_log` to TIER_2 (extended).

Add annotations: `trigger_architect` → DISPATCH, `architect_backlog` → READONLY, `architect_log` → READONLY.

Add REST routes to FACTORY_V2_ROUTES:
```
POST /api/v2/factory/projects/:id/architect  → trigger_architect
GET  /api/v2/factory/projects/:id/backlog    → architect_backlog
GET  /api/v2/factory/projects/:id/architect/log → architect_log
```

After making the edits, stop.

---

### Task 6: Dashboard — Architect Section

**Files:**
- Modify: `dashboard/src/views/Factory.jsx`
- Modify: `dashboard/src/api.js`

Add architect API methods to the factory client:
```js
triggerArchitect: (projectId, opts = {}) => requestV2(`/factory/projects/${projectId}/architect`, { method: 'POST', ...opts }),
backlog: (projectId, opts = {}) => requestV2(`/factory/projects/${projectId}/backlog`, opts),
architectLog: (projectId, opts = {}) => requestV2(`/factory/projects/${projectId}/architect/log`, opts),
```

Add an Architect section to Factory.jsx (after the intake queue section). When a project is selected:
- Show the current backlog as an ordered list (rank, title, why, scope budget, expected impact)
- Show the latest reasoning text in a collapsible panel
- Show flags as warning badges
- "Run Architect" button that calls triggerArchitect and refreshes
- Loading state while architect runs

Use search_files to find the insertion point in Factory.jsx (after the intake section, before the closing fragment). Read 30 lines of context, then use replace_lines.

After making the edits, stop.

---

### Task 7: Tests

**Files:**
- Create: `server/tests/factory-architect.test.js`

Tests using in-memory SQLite with direct table creation (factory_projects + factory_work_items + factory_health_snapshots + factory_health_findings + factory_architect_cycles). Do NOT use runMigrations.

Test scenarios:
- createCycle stores and returns a cycle with parsed JSON fields
- getLatestCycle returns most recent cycle for a project
- listCycles returns ordered by created_at DESC
- getBacklog returns parsed backlog array from latest cycle
- getReasoningLog returns reasoning text entries
- buildArchitectPrompt includes health scores, intake items, and product-sense questions
- buildArchitectPrompt truncates intake to 20 items max
- prioritizeByHealth sorts items by weakest dimension alignment
- runArchitectCycle creates a cycle and updates intake items to prioritized
- Handler: handleTriggerArchitect returns cycle with reasoning and backlog
- Handler: handleArchitectBacklog returns ordered backlog
- Handler: handleArchitectLog returns reasoning history

After creating the file, stop.

---

## Post-Plan Notes

### What This Phase Delivers

- Architect cycle storage (input snapshot, reasoning, backlog, flags)
- Prompt builder that assembles context from health + intake + project brief
- Deterministic prioritizer that ranks by health balance (weakest dimension first)
- 3 MCP tools (trigger_architect, architect_backlog, architect_log)
- REST API routes for all 3
- Dashboard architect section with backlog, reasoning, flags, and "Run Architect" button
- 12 tests

### Design Decision: Deterministic First, LLM Later

The architect runner uses deterministic prioritization (sort by health weakness) rather than an LLM call. This is intentional:
- It makes the system testable and predictable
- It produces real, useful backlog ordering based on health data
- LLM-based prioritization can be swapped in later by replacing `prioritizeByHealth` with an LLM call that uses the same prompt
- The prompt builder is already written for the LLM path — it just isn't called yet

### Next Phase

Phase 4: Trust & Policy Framework — configurable autonomy levels, policy overrides, kill switches.
