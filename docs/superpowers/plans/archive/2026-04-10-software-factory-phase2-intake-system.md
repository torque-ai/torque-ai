# Software Factory Phase 2: Intake System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the factory's front door — a work item queue that accepts input from any source (conversational, GitHub issues, scouts, CI failures, webhooks) and normalizes it into a uniform internal representation that the Architect agent will prioritize in Phase 3.

**Architecture:** New DB table `factory_work_items` stores all incoming work. A DB module (`server/db/factory-intake.js`) provides CRUD with priority ordering, status transitions, and title-based deduplication. MCP tools expose `create_work_item`, `list_work_items`, `update_work_item`, `reject_work_item`, and `intake_from_findings`. Dashboard gets an intake queue section in the Factory view.

**Tech Stack:** better-sqlite3 (existing), vitest (existing), React (dashboard)

---

## File Structure

```
server/db/factory-intake.js            # Work item CRUD, deduplication, status transitions
server/handlers/factory-handlers.js    # Modify: add intake handler functions
server/tool-defs/factory-defs.js       # Modify: add intake tool definitions
server/db/migrations.js                # Modify: migration v14 for factory_work_items table
server/database.js                     # Modify: wire factory-intake into init chain
server/container.js                    # Modify: register factory-intake in DI container
server/core-tools.js                   # Modify: add intake tools to tiers
server/tool-annotations.js             # Modify: add annotations for intake tools
server/api-server.core.js              # Modify: add intake REST routes
dashboard/src/views/Factory.jsx        # Modify: add IntakeQueue section
dashboard/src/api.js                   # Modify: add intake API methods
server/tests/factory-intake.test.js    # Unit + integration tests
```

### Task 1: Database Migration v14

Append migration to `server/db/migrations.js`. Creates `factory_work_items` table with columns: id, project_id, source, origin_json, title, description, priority, requestor, constraints_json, status, reject_reason, linked_item_id, batch_id, created_at, updated_at. Indexes on project+status, status+priority, source, and linked_item_id. Add table name to ALLOWED_MIGRATION_TABLES in `server/database.js`.

### Task 2: Factory Intake DB Module

Create `server/db/factory-intake.js` with setDb pattern. Exports: createWorkItem, getWorkItem, listWorkItems (priority-sorted), updateWorkItem, rejectWorkItem, findDuplicates (exact + partial title match), linkItems, getIntakeStats, createFromFindings (bulk import). Wire into database.js and container.js.

### Task 3: MCP Tool Definitions + Handlers

Add 5 tools to factory-defs.js: create_work_item, list_work_items, update_work_item, reject_work_item, intake_from_findings. Add 5 handlers to factory-handlers.js. Wire into core-tools.js tiers and tool-annotations.js.

### Task 4: REST API Routes

Add 5 routes to FACTORY_V2_ROUTES in api-server.core.js.

### Task 5: Dashboard Intake Queue

Add intake API methods to dashboard api.js. Add IntakeQueue section to Factory.jsx showing work items with source/status badges and reject buttons.

### Task 6: Tests

14 tests covering CRUD, priority ordering, deduplication, bulk findings import, handler integration, and status transitions.

---

See full implementation code in the Phase 2 design notes. Each task is independent except Task 3 depends on Tasks 1-2, Task 4 depends on Task 3, Task 5 depends on Task 4, Task 6 depends on all.
