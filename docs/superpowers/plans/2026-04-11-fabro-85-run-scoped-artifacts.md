# Fabro #85: Run-Scoped Artifact Isolation (SuperAGI)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Every task run gets its own isolated **artifact directory** — intermediate files, scratch notes, tool outputs, screenshots. Two concurrent runs of the same workflow never collide on files. Artifacts are inspectable from the dashboard and automatically cleaned up (or promoted to permanent storage) based on retention policy. Inspired by SuperAGI's Resource Manager.

**Architecture:** On task start, the runtime creates `.torque/runs/<run_id>/` containing subdirectories `outputs/`, `inputs/`, `scratch/`, `screenshots/`. The path is exposed to the task as `$run_dir` (prompt interpolation) and as an env var. Tool handlers that write files default to `$run_dir/scratch/`. A retention policy deletes old run dirs on schedule or on domain-level retention (Plan 38). Dashboard adds a "Run artifacts" panel that lists files + previews.

**Tech Stack:** Node.js, fs. Builds on plans 27 (state), 34 (assets), 38 (domains), 85's successor Plan 55 (streaming artifacts).

---

## File Structure

**New files:**
- `server/migrations/0NN-run-artifacts.sql`
- `server/runs/run-dir-manager.js` — create/list/cleanup per-run dirs
- `server/tests/run-dir-manager.test.js`
- `dashboard/src/views/RunArtifacts.jsx`

**Modified files:**
- `server/execution/task-startup.js` — create run dir + set $run_dir
- `server/execution/task-finalizer.js` — index created files into `run_artifacts` table
- `server/maintenance/retention-cleanup.js` — sweep old run dirs
- `server/handlers/mcp-tools.js` — `list_run_artifacts`, `get_artifact`

---

## Task 1: Migration + manager

- [ ] **Step 1: Migration**

`server/migrations/0NN-run-artifacts.sql`:

```sql
CREATE TABLE IF NOT EXISTS run_artifacts (
  artifact_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  workflow_id TEXT,
  relative_path TEXT NOT NULL,
  absolute_path TEXT NOT NULL,
  size_bytes INTEGER,
  mime_type TEXT,
  promoted INTEGER NOT NULL DEFAULT 0,        -- 1 = moved to permanent store
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_run_artifacts_task ON run_artifacts(task_id);
```

- [ ] **Step 2: Tests**

Create `server/tests/run-dir-manager.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { setupTestDb } = require('./helpers/test-db');
const { createRunDirManager } = require('../runs/run-dir-manager');

describe('runDirManager', () => {
  let db, mgr, root;
  beforeEach(() => {
    db = setupTestDb();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-'));
    mgr = createRunDirManager({ db, rootDir: root });
    db.prepare(`INSERT INTO tasks (task_id, status) VALUES ('t1','running')`).run();
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('openRunDir creates the expected subdirectory layout', () => {
    const runDir = mgr.openRunDir('t1');
    expect(fs.existsSync(path.join(runDir, 'outputs'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'inputs'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'scratch'))).toBe(true);
  });

  it('openRunDir is idempotent', () => {
    const a = mgr.openRunDir('t1');
    const b = mgr.openRunDir('t1');
    expect(a).toBe(b);
  });

  it('indexFiles walks the run dir + records each file', async () => {
    const runDir = mgr.openRunDir('t1');
    fs.writeFileSync(path.join(runDir, 'outputs', 'a.txt'), 'hello');
    fs.writeFileSync(path.join(runDir, 'scratch', 'notes.md'), '# notes');
    await mgr.indexFiles('t1');
    const rows = db.prepare('SELECT * FROM run_artifacts WHERE task_id = ?').all('t1');
    expect(rows).toHaveLength(2);
    const names = rows.map(r => r.relative_path).sort();
    expect(names).toContain('outputs/a.txt');
    expect(names).toContain('scratch/notes.md');
  });

  it('promoteArtifact moves file to permanent store + marks promoted=1', async () => {
    const runDir = mgr.openRunDir('t1');
    fs.writeFileSync(path.join(runDir, 'outputs', 'final.txt'), 'result');
    await mgr.indexFiles('t1');
    const row = db.prepare('SELECT artifact_id FROM run_artifacts WHERE relative_path = ?').get('outputs/final.txt');
    const promotedPath = await mgr.promoteArtifact(row.artifact_id, { destPath: 'promoted/final-t1.txt' });
    expect(fs.existsSync(promotedPath)).toBe(true);
    const updated = db.prepare('SELECT promoted FROM run_artifacts WHERE artifact_id = ?').get(row.artifact_id);
    expect(updated.promoted).toBe(1);
  });

  it('sweepRunDir deletes only non-promoted files', async () => {
    const runDir = mgr.openRunDir('t1');
    fs.writeFileSync(path.join(runDir, 'outputs', 'keep.txt'), 'k');
    fs.writeFileSync(path.join(runDir, 'scratch', 'temp.txt'), 't');
    await mgr.indexFiles('t1');
    const keep = db.prepare(`SELECT artifact_id FROM run_artifacts WHERE relative_path = ?`).get('outputs/keep.txt');
    await mgr.promoteArtifact(keep.artifact_id, { destPath: 'promoted/keep.txt' });
    await mgr.sweepRunDir('t1');
    expect(fs.existsSync(path.join(runDir, 'scratch', 'temp.txt'))).toBe(false);
    // Run dir itself is gone if nothing left
    expect(fs.existsSync(runDir)).toBe(false);
  });
});
```

- [ ] **Step 3: Implement**

Create `server/runs/run-dir-manager.js`:

```js
'use strict';
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

function createRunDirManager({ db, rootDir, promotedDir = null }) {
  fs.mkdirSync(rootDir, { recursive: true });
  const promotedRoot = promotedDir || path.join(rootDir, '..', 'promoted');

  function runDirFor(taskId) { return path.join(rootDir, taskId); }

  function openRunDir(taskId) {
    const dir = runDirFor(taskId);
    for (const sub of ['outputs', 'inputs', 'scratch', 'screenshots']) {
      fs.mkdirSync(path.join(dir, sub), { recursive: true });
    }
    return dir;
  }

  async function indexFiles(taskId, { workflowId = null } = {}) {
    const dir = runDirFor(taskId);
    if (!fs.existsSync(dir)) return { count: 0 };
    const files = [];
    walk(dir, dir, files);
    const insert = db.prepare(`
      INSERT OR IGNORE INTO run_artifacts (artifact_id, task_id, workflow_id, relative_path, absolute_path, size_bytes, mime_type)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const f of files) {
      insert.run(
        `art_${randomUUID().slice(0, 12)}`, taskId, workflowId, f.rel, f.abs, f.size,
        f.rel.endsWith('.md') ? 'text/markdown'
          : f.rel.endsWith('.json') ? 'application/json'
          : f.rel.endsWith('.png') ? 'image/png'
          : 'application/octet-stream',
      );
    }
    return { count: files.length };
  }

  function walk(root, dir, out) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(root, full, out);
      else {
        out.push({
          rel: path.relative(root, full).split(path.sep).join('/'),
          abs: full,
          size: fs.statSync(full).size,
        });
      }
    }
  }

  async function promoteArtifact(artifactId, { destPath }) {
    const row = db.prepare('SELECT * FROM run_artifacts WHERE artifact_id = ?').get(artifactId);
    if (!row) throw new Error(`artifact not found: ${artifactId}`);
    fs.mkdirSync(promotedRoot, { recursive: true });
    const destAbs = path.join(promotedRoot, destPath);
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    fs.copyFileSync(row.absolute_path, destAbs);
    db.prepare(`UPDATE run_artifacts SET promoted = 1, absolute_path = ? WHERE artifact_id = ?`).run(destAbs, artifactId);
    return destAbs;
  }

  async function sweepRunDir(taskId) {
    const dir = runDirFor(taskId);
    if (!fs.existsSync(dir)) return { deleted: 0 };
    const rows = db.prepare(`SELECT relative_path, promoted FROM run_artifacts WHERE task_id = ?`).all(taskId);
    let deleted = 0;
    for (const r of rows) {
      if (!r.promoted) {
        const abs = path.join(dir, r.relative_path);
        if (fs.existsSync(abs)) { fs.unlinkSync(abs); deleted++; }
      }
    }
    // Remove empty directories + the run dir itself if empty
    removeEmptyDirs(dir);
    return { deleted };
  }

  function removeEmptyDirs(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (fs.statSync(full).isDirectory()) removeEmptyDirs(full);
    }
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  }

  return { openRunDir, indexFiles, promoteArtifact, sweepRunDir, runDirFor };
}

module.exports = { createRunDirManager };
```

Run tests → PASS. Commit: `feat(run-artifacts): per-run dir manager with index + promote + sweep`.

---

## Task 2: Wire into task lifecycle + MCP + dashboard

- [ ] **Step 1: Task startup opens run dir**

In `server/execution/task-startup.js`:

```js
const mgr = defaultContainer.get('runDirManager');
const runDir = mgr.openRunDir(taskId);
task.task_description = task.task_description.replace(/\$run_dir/g, runDir);
process.env.TORQUE_RUN_DIR = runDir;
```

In `server/execution/task-finalizer.js` on completion:

```js
await mgr.indexFiles(taskId, { workflowId: task.workflow_id });
```

- [ ] **Step 2: Retention sweep**

In `server/maintenance/retention-cleanup.js` extend the existing sweep: for each task past retention, also call `mgr.sweepRunDir(task.task_id)` — this removes the on-disk files for non-promoted artifacts.

- [ ] **Step 3: MCP + dashboard**

```js
list_run_artifacts: { description: 'List artifacts produced by a task run.', inputSchema: { type: 'object', required: ['task_id'], properties: { task_id: { type: 'string' } } } },
get_artifact: { description: 'Read the content of a specific run artifact.', inputSchema: { type: 'object', required: ['artifact_id'], properties: { artifact_id: { type: 'string' } } } },
promote_artifact: { description: 'Move an artifact from the ephemeral run dir to permanent storage.', inputSchema: { type: 'object', required: ['artifact_id', 'dest_path'], properties: { artifact_id: { type: 'string' }, dest_path: { type: 'string' } } } },
```

Dashboard `RunArtifacts.jsx` view: fetches `/api/tasks/:id/artifacts`, renders a file tree with preview (text files inline, images lazy-loaded, others as download links).

`await_restart`. Smoke: submit a task whose prompt is "Write a summary to `$run_dir/outputs/summary.md`", confirm task description shows absolute path, confirm the file is indexed after completion and visible in dashboard.

Commit: `feat(run-artifacts): wire into startup/finalizer + MCP + dashboard`.
