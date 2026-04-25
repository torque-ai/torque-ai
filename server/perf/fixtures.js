'use strict';

const Database = require('better-sqlite3');
const { createTables } = require('../db/schema-tables');
const { runMigrations } = require('../db/migrations');

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
  createTables(db, nullLogger);
  runMigrations(db);

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
