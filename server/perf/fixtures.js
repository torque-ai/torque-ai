'use strict';

// NOTE for metric authors: db modules that hold module-scope handles
// (e.g., db/task-core.js setDb) are GLOBAL — two metrics calling setDb
// in the same perf-run process will collide. Either share fixtures or
// arrange teardown explicitly. Phase 0 v0 metrics that touch task-core
// (#2 task-core-create, #9 db-list-tasks if it lands using listTasks's
// module-scope path) coordinate via lazy-load + cached singleton.

const Database = require('better-sqlite3');
const { createTables } = require('../db/schema/tables');

// Tiny seedable PRNG so fixtures are deterministic across runs.
function mulberry32(seed) {
  let a = seed;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildFixture(opts = {}) {
  const tasks = opts.tasks ?? 1000;
  const projectId = opts.projectId ?? 'perf-fixture';
  const seed = opts.seed ?? 1;
  const rng = mulberry32(seed);

  const db = new Database(':memory:');
  // Null logger — base schema calls logger.info/warn/debug but we don't need output.
  const nullLogger = { info() {}, warn() {}, error() {}, debug() {}, child() { return nullLogger; } };
  // createTables already includes all columns we need (tags, project, etc. are in the
  // base schema). Skipping runMigrations avoids hitting tables (model_family_templates,
  // model_registry, routing_templates) that only exist in a seeded production DB.
  createTables(db, nullLogger);

  // Patch migration-added columns that aren't in the base CREATE TABLE statements.
  // Wrapped in try/catch so we silently no-op if the base schema already includes
  // them in the future. This mirrors what schema-migrations.js does via safeAddColumn.
  const safeAddCol = (table, colDef) => {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef}`); } catch (_e) { /* already exists */ }
  };

  // tasks.server_epoch — required by createTask (added by schema-migrations.js)
  safeAddCol('tasks', 'server_epoch INTEGER');

  // tasks.archived — queried by listTasks WHERE archived = 0 (buildTaskFilterConditions default)
  safeAddCol('tasks', 'archived INTEGER DEFAULT 0');

  // token_usage.project — queried by getProjectStats WHERE project = ?
  safeAddCol('token_usage', 'project TEXT');

  // pipelines.project — queried by getProjectStats WHERE project = ?
  safeAddCol('pipelines', 'project TEXT');

  // scheduled_tasks.project — queried by getProjectStats WHERE project = ?
  safeAddCol('scheduled_tasks', 'project TEXT');

  const insertTask = db.prepare(
    `INSERT INTO tasks (id, project, status, task_description, created_at, tags, files_modified, context)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const tx = db.transaction(() => {
    for (let i = 0; i < tasks; i++) {
      const id = `perf-task-${seed}-${i.toString().padStart(6, '0')}`;
      const status = rng() < 0.7 ? 'completed' : 'failed';
      insertTask.run(
        id,
        projectId,
        status,
        `Fixture task ${i} for perf measurement`,
        new Date(Date.now() - i * 1000).toISOString(),
        JSON.stringify(['perf', `bucket-${i % 5}`]),
        JSON.stringify([`src/file-${i % 20}.js`]),
        JSON.stringify({ note: 'seeded' })
      );
    }
  });
  tx();

  return { db, projectId, close: () => db.close() };
}

module.exports = { buildFixture, mulberry32 };
