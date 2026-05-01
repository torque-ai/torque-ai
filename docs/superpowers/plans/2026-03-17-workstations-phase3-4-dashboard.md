# Workstations Migration Completion Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `workstations` the single canonical store for host metadata. Today the table exists, an adapter layer exists, REST + MCP endpoints exist, and the dashboard's `Hosts.jsx` already imports `workstationsApi`. But the three legacy tables (`ollama_hosts`, `peek_hosts`, `remote_agents`) are still the primary write target for runtime mutations. They are only kept in sync with `workstations` by `migrateExistingHostsToWorkstations` running once at server startup, so any host registered or updated during a single server run is invisible to consumers that read through the workstation adapter until the next restart.

This plan flips that direction — runtime writes land in `workstations` first, legacy table rows are produced as a backward-compatible projection during a deprecation window, and finally the legacy tables are dropped. No new feature surface is added; the dashboard work in the original plan is dropped because `Hosts.jsx` already reads workstation data and the REST/MCP layer is already in place.

**Architecture:** `workstations` becomes the source of truth. `host-management.js` (`addOllamaHost`/`updateOllamaHost`/`removeOllamaHost`) writes through `workstation/model.js` and emits the legacy `ollama_hosts` row from a deterministic projection function. Reads in `host-management.js`, `host-selection.js`, `host-benchmarking.js`, `host-capacity.js`, `provider-routing-core.js`, and `benchmark.js` keep their existing SQL — but the SQL targets a SQLite VIEW named `ollama_hosts_view` that is recreated from `workstations` on startup. Same pattern for `peek_hosts_view` (consumed by `db/email-peek.js`) and `remote_agents_view` (consumed by `plugins/remote-agents/agent-registry.js`). After two server releases without view-vs-table drift in production, the physical legacy tables are dropped and the views are renamed back to `ollama_hosts` / `peek_hosts` / `remote_agents` so existing query strings keep working unchanged.

**Tech Stack:** Node.js (CommonJS), better-sqlite3 (views are first-class in SQLite), vitest, no dashboard work required.

**Strategy choice — finish the migration, do not formalize dual-write.** Dual-write at runtime is the worst of both worlds: every mutation site has to know about both schemas, the test fixture surface doubles, and a missed call site silently desyncs. Running the data through one writer and exposing legacy shapes as views localizes the schema knowledge to two places (`workstation/model.js` and the view DDL) and lets every existing read site keep its query string. The cost is one schema migration plus ~6 file edits in the write path.

**`version_intent`:** `internal`. This plan moves no user-visible behavior — the same hosts continue to be listed, the same MCP tools continue to work, the same dashboard view continues to render. It is pure data-layer cleanup that retires three deprecated tables.

**Source spec:** `docs/superpowers/specs/2026-03-16-unified-workstations-design.md` (phases 3-4 of the original unification design).

**Out of scope:**
- Dashboard `Workstations.jsx` view + wizard — the original plan's Chunk 3. `Hosts.jsx` already consumes `workstationsApi`; a dedicated view is a separate UX decision, not a migration blocker.
- New REST endpoints — `/api/v2/workstations` GET/POST/DELETE/toggle/probe are already wired (`server/api/routes.js:1129`).
- Removing the `host-credentials` `host_type CHECK` workaround — already handled by `relaxHostCredentialsConstraint()` in `workstation/migration.js`.
- Renaming `remote_agent_id` columns / config keys — separate config-deprecation cycle.

---

## File structure

```
server/db/
  schema-migrations.js          MODIFY: add views creation block after the workstations
                                CREATE TABLE; add legacy-table drop in a guarded
                                DEPRECATION_GATE migration (off by default)
  host-management.js            MODIFY: rewrite add/update/remove to call workstation
                                model + projector; reads keep their SQL but target the
                                view (no string change required if view name matches)
  email-peek.js                 MODIFY: same pattern for peek_hosts CRUD (registerPeekHost,
                                unregisterPeekHost, updatePeekHost)

server/db/legacy-projection.js  NEW: projectWorkstationToOllamaHost(ws),
                                projectWorkstationToPeekHost(ws),
                                projectWorkstationToRemoteAgent(ws). Pure functions.

server/workstation/
  model.js                      MODIFY: add upsertFromOllamaHost(host) +
                                upsertFromPeekHost(host) + upsertFromRemoteAgent(agent)
                                helpers; existing CRUD untouched
  migration.js                  MODIFY: keep migration on first install but switch from
                                INSERT OR IGNORE INTO workstations to creating the views
                                after the row backfill (so views see the live data)

server/plugins/remote-agents/
  agent-registry.js             MODIFY: register() + remove() write through the
                                workstation model; reads keep targeting remote_agents
                                (which becomes a view)

server/tests/
  legacy-projection.test.js     NEW: pure-function tests for the three projectors
  workstation-views.test.js     NEW: writes via host-management.addOllamaHost,
                                reads via 'SELECT * FROM ollama_hosts' return the same
                                row; same for peek_hosts and remote_agents
  host-management.test.js       MODIFY: existing tests already use raw SQL on
                                ollama_hosts. Update fixtures so the table is
                                actually a view (drop CREATE TABLE inserts in fixtures
                                that bypass workstations)
```

**Why views and not triggers:** SQLite triggers fire per row and need INSTEAD OF on a view to make INSERT/UPDATE/DELETE work — that effectively rebuilds the dual-write logic at the SQL layer. Views are read-only here; writes go through the JS write path (`host-management.addOllamaHost` etc.) and the views just project. This keeps the schema dumb and the test surface predictable.

---

## Task 1: Legacy projection module

**Files:**
- Create: `server/db/legacy-projection.js`
- Test: `server/tests/legacy-projection.test.js`

Pure functions that turn a workstation row into the shape the legacy tables expose. No DB access; just object reshaping. The view DDL in Task 2 will SELECT the same columns these functions return, so any drift between view and projector becomes a test failure rather than a runtime crash.

- [ ] **Step 1: Write the failing test**

Create `server/tests/legacy-projection.test.js`. Cover:
- `projectWorkstationToOllamaHost(ws)` returns `{id, name, url, enabled, status, consecutive_failures, last_health_check, last_healthy, running_tasks, models_cache, models_updated_at, memory_limit_mb, max_concurrent, priority, settings, gpu_metrics_port, vram_factor, created_at}` — matches the columns `host-management.js` queries today.
- URL is reconstructed as `http://${ws.host}:${ws.ollama_port || 11434}`.
- Non-ollama workstations (capabilities lack `ollama`) return `null`.
- `projectWorkstationToPeekHost(ws)` returns `{name, url, ssh, is_default, platform, enabled, created_at}` and uses `ui_capture` capability to gate.
- `projectWorkstationToRemoteAgent(ws)` returns `{id, name, host, port, secret, enabled, status, consecutive_failures, last_health_check, last_healthy, max_concurrent, metrics, tls, rejectUnauthorized, os_platform, created_at}` and uses `command_exec` capability to gate.

Run `npx vitest run server/tests/legacy-projection.test.js` — expect failure.

- [ ] **Step 2: Implement projectors**

Create `server/db/legacy-projection.js` exporting the three functions. Capability check via `JSON.parse(ws.capabilities)`. Default port fallbacks must match the view DDL in Task 2 exactly.

- [ ] **Step 3: Run tests on remote**

```bash
torque-remote bash -c "cd server && npx vitest run tests/legacy-projection.test.js"
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/db/legacy-projection.js server/tests/legacy-projection.test.js
git commit -m "feat(workstations): pure projector for legacy-table row shapes"
```

---

## Task 2: Replace legacy tables with views

**Files:**
- Modify: `server/db/schema-migrations.js`
- Modify: `server/workstation/migration.js`
- Test: `server/tests/workstation-views.test.js` (new)

This is the load-bearing migration. Existing legacy tables get backed up, dropped, and recreated as views over `workstations`.

- [ ] **Step 1: Write the failing integration test**

Create `server/tests/workstation-views.test.js`:
- Boot a fresh in-memory DB, run all migrations.
- Call `addOllamaHost({id, name, url, max_concurrent: 4})`.
- Read back via `db.prepare('SELECT * FROM ollama_hosts WHERE id = ?').get(id)` — expect non-null.
- Call `model.updateWorkstation(id, {status: 'healthy'})` directly, then read via legacy SELECT — expect updated status.
- Same flow for peek_hosts (register via `email-peek.registerPeekHost`) and remote_agents (register via `agent-registry.register`).

Expected: failure (views don't exist yet, writes go to physical legacy tables).

- [ ] **Step 2: Add view DDL to schema-migrations.js**

In `server/db/schema-migrations.js`, after the `migrateExistingHostsToWorkstations(db)` call (currently around line 779), add a new step that:

1. Detects whether `ollama_hosts`/`peek_hosts`/`remote_agents` are physical tables (query `sqlite_master`).
2. If physical: `ALTER TABLE ollama_hosts RENAME TO ollama_hosts_legacy_backup_<timestamp>` then `CREATE VIEW ollama_hosts AS SELECT ... FROM workstations WHERE json_extract(capabilities, '$.ollama.detected') = 1`.
3. The SELECT projects exactly the columns `legacy-projection.projectWorkstationToOllamaHost` returns. URL is built via `'http://' || host || ':' || COALESCE(ollama_port, 11434)`.
4. Same flow for `peek_hosts` (capability `ui_capture`) and `remote_agents` (capability `command_exec`).
5. The backup tables stay around for one release cycle in case rollback is needed; Task 6 drops them.

The migration is idempotent — if the view already exists, do nothing. If both view and backup exist (re-running), do nothing.

- [ ] **Step 3: Adjust workstation/migration.js ordering**

`migrateExistingHostsToWorkstations` currently reads from `ollama_hosts`/`peek_hosts`/`remote_agents` via `db.prepare('SELECT * FROM ollama_hosts').all()`. This runs *before* the view conversion in Step 2 and works against the still-physical tables. Confirm by reading lines 38, 95, 151 of `server/workstation/migration.js`. No code change needed if Task 2 Step 2 runs the view conversion *after* `migrateExistingHostsToWorkstations` returns — preserve that ordering.

- [ ] **Step 4: Run integration test on remote**

```bash
torque-remote bash -c "cd server && npx vitest run tests/workstation-views.test.js tests/host-management.test.js"
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/db/schema-migrations.js server/workstation/migration.js server/tests/workstation-views.test.js
git commit -m "feat(workstations): replace legacy host tables with workstation-backed views"
```

---

## Task 3: Route host-management.js writes through workstation model

**Files:**
- Modify: `server/db/host-management.js`
- Modify: `server/workstation/model.js`

After Task 2, `INSERT INTO ollama_hosts ...` will fail because the target is a view. This task rewrites the three mutating functions to use `workstation/model.js`.

- [ ] **Step 1: Add upsertFromOllamaHost to workstation/model.js**

Add `upsertFromOllamaHost(host)` that:
- Generates a UUID if `host.id` is missing.
- Parses `host.url` (use the existing `parseUrlHost` helper from `migration.js` — extract it to a shared util).
- Builds capabilities `{ollama: {detected: true, port}}` via existing capability merge logic.
- Calls `model.createWorkstation` if no row with the ID exists, otherwise `model.updateWorkstation`.
- Returns the legacy-projection shape via `legacy-projection.projectWorkstationToOllamaHost`.

- [ ] **Step 2: Rewrite host-management.addOllamaHost / updateOllamaHost / removeOllamaHost**

In `server/db/host-management.js`:
- `addOllamaHost(host)` — replace the `INSERT INTO ollama_hosts` (line 89) with `wsModel.upsertFromOllamaHost(host)`.
- `updateOllamaHost(hostId, updates)` — replace the `UPDATE ollama_hosts SET ... WHERE id = ?` (line 219) with `wsModel.updateWorkstation(hostId, updates)`. Filter `updates` to the same allowed-fields list.
- `removeOllamaHost(hostId)` — replace the `DELETE FROM ollama_hosts WHERE id = ?` (line 233) with `wsModel.deleteWorkstation(hostId)`.
- `cleanupNullIdHosts()` — change the SQL to operate against `workstations` directly (`DELETE FROM workstations WHERE id IS NULL OR id = ''` — but workstations.id is `TEXT PRIMARY KEY NOT NULL`, so this clean-up is no-op after migration; leave the SQL but add a comment).
- `getOllamaHost`, `getOllamaHostByUrl`, `listOllamaHosts` — unchanged. They `SELECT FROM ollama_hosts`, which is now the view.

The `models_cache` repair branch in `getOllamaHost` (lines 119-122) currently issues `UPDATE ollama_hosts SET models_cache = NULL WHERE id = ?` — that will fail against a view. Replace with `wsModel.updateWorkstation(hostId, {models_cache: null})`.

- [ ] **Step 3: Run host-management tests on remote**

```bash
torque-remote bash -c "cd server && npx vitest run tests/host-management.test.js tests/db-host-selection.test.js tests/host-distribution.test.js tests/host-capacity.test.js tests/db-host-benchmarking.test.js"
```

Existing fixtures that do `rawDb().prepare('DELETE FROM ollama_hosts').run()` need to switch to `DELETE FROM workstations` because the view is non-deletable. Update each test file flagged by the run.

Expected: PASS after fixture updates.

- [ ] **Step 4: Commit**

```bash
git add server/db/host-management.js server/workstation/model.js server/tests/host-management.test.js [other touched test files]
git commit -m "feat(workstations): host-management writes route through workstation model"
```

---

## Task 4: Route email-peek.js writes through workstation model

**Files:**
- Modify: `server/db/email-peek.js`
- Modify: `server/workstation/model.js` (add `upsertFromPeekHost`)

Symmetric to Task 3, smaller surface.

- [ ] **Step 1: Add upsertFromPeekHost to model.js**

Capability `{ui_capture: {detected: true, has_display: true}}`. Honors `is_default` flip — if the new row is default, clear `is_default` on the previous default workstation in the same transaction.

- [ ] **Step 2: Rewrite email-peek mutators**

In `server/db/email-peek.js`:
- `registerPeekHost(name, url, ssh, isDefault, platform)` — line 141. Replace the `UPDATE peek_hosts SET is_default = 0` + `INSERT OR REPLACE INTO peek_hosts ...` block with `wsModel.upsertFromPeekHost({name, url, ssh, is_default: isDefault, platform})`.
- `unregisterPeekHost(name)` — line 148. Replace the `DELETE FROM peek_hosts WHERE name = ?` with `wsModel.deletePeekHostByName(name)` (new method that finds the workstation by name + ui_capture capability and deletes; returns boolean).
- `updatePeekHost(name, updates)` — line 167. Replace with `wsModel.updatePeekHostByName(name, updates)` filtering to the existing `allowedFields` list.
- `listPeekHosts`, `getDefaultPeekHost`, `getPeekHost` — unchanged. They read from the `peek_hosts` view.

- [ ] **Step 3: Run tests on remote**

```bash
torque-remote bash -c "cd server && npx vitest run tests/db-email-peek.test.js tests/integration-infra.test.js"
```

The mock-DB tests in `db-email-peek.test.js` intercept SQL strings — they need updating to mock the workstation model calls instead. Convert these to use a real in-memory better-sqlite3 fixture (faster, more accurate, and matches the workstation-views test pattern).

- [ ] **Step 4: Commit**

```bash
git add server/db/email-peek.js server/workstation/model.js server/tests/db-email-peek.test.js
git commit -m "feat(workstations): email-peek host writes route through workstation model"
```

---

## Task 5: Route remote-agents plugin writes through workstation model

**Files:**
- Modify: `server/plugins/remote-agents/agent-registry.js`
- Modify: `server/workstation/model.js` (add `upsertFromRemoteAgent`)

The remote-agents plugin owns its own table today. After this task it stops being its own owner and becomes a workstation consumer.

- [ ] **Step 1: Add upsertFromRemoteAgent to model.js**

Capability `{command_exec: true, git_sync: true, test_runners: true}`. Note: `secret` is stored as scrypt hash by the plugin; preserve that — `model.upsertFromRemoteAgent` does not re-hash, just stores whatever the caller passed (the plugin already hashes before calling).

- [ ] **Step 2: Rewrite agent-registry mutators**

In `server/plugins/remote-agents/agent-registry.js`:
- `register(...)` — replace the `INSERT OR REPLACE INTO remote_agents` (search around line 60-85) with `wsModel.upsertFromRemoteAgent({...})`.
- `remove(id)` — line 111. Replace `DELETE FROM remote_agents WHERE id = ?` with `wsModel.deleteWorkstation(id)`.
- `runHealthChecks` updates `status`/`last_healthy`/`metrics` via `UPDATE remote_agents` — replace with `wsModel.updateWorkstation(id, {...})`.
- All read SELECTs (`get`, `getAll`, `getAvailable`, `runHealthChecks` initial fetch) keep their SQL — they hit the `remote_agents` view.

- [ ] **Step 3: Run tests on remote**

```bash
torque-remote bash -c "cd server && npx vitest run plugins/remote-agents/tests/agent-registry.test.js plugins/remote-agents/tests/remote-routing.test.js plugins/remote-agents/tests/routing.test.js tests/remote-test-routing.test.js"
```

Expected: PASS. The `dashboard-routes.test.js` fixture at line 675 mocks the SELECT — confirm it still passes; if it filters on `WHERE`, it will still match the view's SQL because the column list is identical.

- [ ] **Step 4: Commit**

```bash
git add server/plugins/remote-agents/agent-registry.js server/workstation/model.js [test files]
git commit -m "feat(workstations): remote-agents plugin writes route through workstation model"
```

---

## Task 6: Drop legacy backup tables behind a release gate

**Files:**
- Modify: `server/db/schema-migrations.js`

The Task 2 view conversion preserves `ollama_hosts_legacy_backup_<ts>`, `peek_hosts_legacy_backup_<ts>`, and `remote_agents_legacy_backup_<ts>` in case rollback is needed. After one release cycle without view-vs-projector drift reports, drop them.

- [ ] **Step 1: Add a guarded migration step**

Add a new step in `schema-migrations.js` that:
- Reads the env flag `TORQUE_DROP_LEGACY_HOST_BACKUPS=1` (off by default).
- When set, finds any table matching the pattern `(ollama_hosts|peek_hosts|remote_agents)_legacy_backup_*` and drops it.
- Logs the drop at info level: `Dropped legacy backup table: <name>`.

This stays opt-in for the next release. The release after that, flip the default to on (separate one-line PR).

- [ ] **Step 2: Run the full server suite on remote**

```bash
torque-remote bash -c "cd server && TORQUE_DROP_LEGACY_HOST_BACKUPS=1 npx vitest run"
```

Expected: PASS, identical to the un-flagged run.

- [ ] **Step 3: Commit**

```bash
git add server/db/schema-migrations.js
git commit -m "feat(workstations): opt-in migration drops legacy host backup tables"
```

---

## Verification

A migration is "complete" when these grep checks return only the expected residual call sites:

```bash
# Writes against legacy tables — should match ONLY workstation/migration.js
# (the initial-data backfill) and test fixture cleanup.
grep -rn "INSERT INTO ollama_hosts\|INSERT INTO peek_hosts\|INSERT INTO remote_agents\|UPDATE ollama_hosts\|UPDATE peek_hosts\|UPDATE remote_agents\|DELETE FROM ollama_hosts\|DELETE FROM peek_hosts\|DELETE FROM remote_agents" server/ --include="*.js"
```

Expected matches after Task 5 ships:
- `server/workstation/migration.js` (one-shot backfill from physical tables before they are dropped)
- `server/tests/**` (fixture teardown that uses raw SQL)

Reads against the views are fine and expected — the views will still match `FROM ollama_hosts`, `FROM peek_hosts`, `FROM remote_agents`.

```bash
# Full server test suite must pass on remote.
torque-remote bash -c "cd server && npx vitest run"
```

Expected: 0 failures.

```bash
# Boot the server on a fresh DB, register hosts via MCP, restart, confirm
# the rows survive (proves writes hit workstations, not the views).
node server/index.js &
# (use add_workstation MCP tool, then list_ollama_hosts, then restart)
```

Expected: `list_ollama_hosts` returns the workstation registered in the previous boot.

```bash
# DB query audit must not regress.
torque-remote bash -c "cd server && npx vitest run tests/audit-db-queries.test.js"
```

Expected: PASS (audit treats views as their underlying table for index purposes; the existing audit assertions for `ollama_hosts` / `peek_hosts` / `remote_agents` continue to apply against `workstations`).

---

## Risks

**1. SQLite views are read-only by default.** Any code path that does `INSERT`/`UPDATE`/`DELETE` against the view name will fail at runtime with `cannot modify ollama_hosts because it is a view`. Tasks 3-5 cover the known write sites; the verification grep above is the safety net for missed call sites.

**2. View column drift.** If `legacy-projection.js` and the view DDL fall out of sync (different column lists, different default values), code that destructures rows will get `undefined` for the missing column. The Task 1 unit tests assert the projector's output keys; the Task 2 integration tests assert the view's row shape matches. Keep both in lockstep — same SELECT projection, same defaults.

**3. host-management mock fixtures.** `server/tests/host-management.test.js` and several others build a mock DB that intercepts SQL strings (e.g., `if (sql === 'DELETE FROM peek_hosts WHERE name = ?')`). After Tasks 3-5, those exact strings are no longer issued — the test sees `wsModel.deleteWorkstation` calls instead. These fixtures need to switch to a real in-memory better-sqlite3 instance. Time cost: ~30 minutes per file, four files affected.

**4. host-credentials FK-like constraints.** The `host_credentials.host_type` CHECK accepts `'ollama' | 'peek' | 'workstation'` after `relaxHostCredentialsConstraint`. After Task 6, only `'workstation'` will produce new rows in practice — but the existing rows referencing `'ollama'`/`'peek'` keep working because the CHECK still accepts them. Don't tighten the CHECK in this plan; that is a follow-up housekeeping pass.

**5. `data-dir.js` legacy-DB import.** `server/data-dir.js` lines 296-298 read from a *previous* `ollama_hosts` table during data-dir migration (cross-process upgrade path). That code reads from a separate SQLite file via its own `legacySql` connection — that file's schema is untouched by this plan, so the SELECT still works. No change needed.

**6. `benchmark.js` and `provider-routing-core.js` reads.** Both issue `SELECT ... FROM ollama_hosts` (benchmark.js:31, provider-routing-core.js:716). After Task 2 these hit the view. The view exposes the same columns, so query strings keep working. No code changes required, but include both files in the Task 3 test sweep to confirm.

**7. Backup tables disk usage.** Task 2 leaves `*_legacy_backup_<ts>` tables in place until Task 6 ships. On a long-running production DB the largest is `ollama_hosts` (typically <100 rows) so the disk cost is negligible. Documented here so it isn't a surprise during a DB inspection.
