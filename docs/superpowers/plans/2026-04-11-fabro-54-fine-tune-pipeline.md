# Fabro #54: Project-Scoped Fine-Tune Pipeline (Refact)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let a project fine-tune a local Ollama model on its own codebase, register the resulting LoRA adapter, and route per-project code tasks to the adapted model. Keeps specialization cheap and opt-in without requiring a separate MLOps system. Inspired by Refact's fine-tune-to-serve loop.

**Architecture:** A new `fine_tune_jobs` table tracks job state. A `fine-tune-runtime.js` coordinates: (1) ingest source files (filtered by glob), (2) build a JSONL training dataset, (3) invoke a configured training backend (`llama.cpp LoRA` or a remote HTTP endpoint), (4) poll progress, (5) register the resulting adapter file as a model alias like `qwen3-coder:30b-project-torque`. Smart routing + project defaults can then reference that alias for code tasks in that project.

**Tech Stack:** Node.js, better-sqlite3, execFile for invoking trainer, existing Ollama host management. Builds on plans 38 (domains), 50 (plugin catalog).

---

## File Structure

**New files:**
- `server/migrations/0NN-fine-tune-jobs.sql`
- `server/fine-tune/dataset-builder.js`
- `server/fine-tune/fine-tune-runtime.js`
- `server/fine-tune/backends/llama-cpp.js`
- `server/fine-tune/backends/remote-http.js`
- `server/tests/dataset-builder.test.js`
- `server/tests/fine-tune-runtime.test.js`

**Modified files:**
- `server/tool-defs/` — `start_fine_tune`, `list_fine_tune_jobs`, `cancel_fine_tune`
- `server/handlers/mcp-tools.js`
- `server/models/model-registry.js` — register LoRA-adapted aliases

---

## Task 1: Migration + dataset builder

- [ ] **Step 1: Migration**

`server/migrations/0NN-fine-tune-jobs.sql`:

```sql
CREATE TABLE IF NOT EXISTS fine_tune_jobs (
  job_id TEXT PRIMARY KEY,
  domain_id TEXT,
  name TEXT NOT NULL,
  base_model TEXT NOT NULL,
  backend TEXT NOT NULL,                 -- 'llama-cpp' | 'remote-http' | custom
  source_globs_json TEXT NOT NULL,
  dataset_path TEXT,
  adapter_path TEXT,
  model_alias TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  progress REAL NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_fine_tune_status ON fine_tune_jobs(status);
```

- [ ] **Step 2: Dataset builder tests**

Create `server/tests/dataset-builder.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { buildDataset } = require('../fine-tune/dataset-builder');

describe('buildDataset', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-'));
    fs.writeFileSync(path.join(dir, 'a.js'), 'function hello() { return 1; }');
    fs.writeFileSync(path.join(dir, 'b.py'), 'def world():\n    return 2');
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'node_modules', 'junk.js'), 'ignore me');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('outputs one JSONL line per matched file', async () => {
    const outPath = path.join(dir, 'train.jsonl');
    await buildDataset({
      workingDir: dir, globs: ['**/*.js', '**/*.py'], outputPath: outPath, ignore: ['node_modules/**'],
    });
    const lines = fs.readFileSync(outPath, 'utf8').trim().split('\n');
    expect(lines.length).toBe(2);
    const parsed = lines.map(l => JSON.parse(l));
    expect(parsed.every(r => r.prompt && r.completion)).toBe(true);
  });

  it('skips files matching ignore globs', async () => {
    const outPath = path.join(dir, 'train.jsonl');
    await buildDataset({ workingDir: dir, globs: ['**/*.js'], outputPath: outPath, ignore: ['node_modules/**'] });
    const lines = fs.readFileSync(outPath, 'utf8').trim().split('\n');
    expect(lines.length).toBe(1);
    expect(lines[0]).not.toMatch(/ignore me/);
  });

  it('skips files larger than maxFileBytes', async () => {
    fs.writeFileSync(path.join(dir, 'big.js'), 'x'.repeat(200 * 1024));
    const outPath = path.join(dir, 'train.jsonl');
    await buildDataset({ workingDir: dir, globs: ['**/*.js'], outputPath: outPath, maxFileBytes: 100 * 1024 });
    const contents = fs.readFileSync(outPath, 'utf8');
    expect(contents).not.toMatch(/big\.js/);
  });
});
```

- [ ] **Step 3: Implement**

Create `server/fine-tune/dataset-builder.js`:

```js
'use strict';
const fs = require('fs');
const path = require('path');
const fg = require('fast-glob');

async function buildDataset({ workingDir, globs, outputPath, ignore = [], maxFileBytes = 100 * 1024 }) {
  const files = await fg(globs, { cwd: workingDir, ignore, absolute: true });
  const out = fs.openSync(outputPath, 'w');
  let count = 0;
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      if (stat.size > maxFileBytes) continue;
      const content = fs.readFileSync(file, 'utf8');
      const rel = path.relative(workingDir, file);
      // Fill-in-the-middle-style: prompt = filename header, completion = content
      const record = {
        prompt: `// File: ${rel}\n`,
        completion: content,
        metadata: { path: rel, bytes: stat.size },
      };
      fs.writeSync(out, JSON.stringify(record) + '\n');
      count++;
    } catch (err) {
      // skip unreadable files
    }
  }
  fs.closeSync(out);
  return { outputPath, record_count: count };
}

module.exports = { buildDataset };
```

Run tests → PASS. Commit: `feat(fine-tune): dataset builder producing JSONL from code globs`.

---

## Task 2: Runtime with pluggable backend

- [ ] **Step 1: Tests**

Create `server/tests/fine-tune-runtime.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach, vi } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createFineTuneRuntime } = require('../fine-tune/fine-tune-runtime');

describe('fineTuneRuntime', () => {
  let db, runtime, backend;
  beforeEach(() => {
    db = setupTestDb();
    backend = {
      train: vi.fn(async ({ datasetPath, baseModel }) => ({ adapterPath: '/tmp/adapter.safetensors' })),
    };
    runtime = createFineTuneRuntime({ db, backends: { test: backend }, buildDataset: async () => ({ outputPath: '/tmp/ds.jsonl', record_count: 42 }) });
  });

  it('submit creates a job row in pending state', async () => {
    const jobId = await runtime.submit({
      name: 'my-ft', baseModel: 'qwen3:30b', backend: 'test',
      sourceGlobs: ['src/**/*.js'], workingDir: '/proj',
    });
    const row = db.prepare('SELECT * FROM fine_tune_jobs WHERE job_id = ?').get(jobId);
    expect(row.status).toBe('pending');
    expect(JSON.parse(row.source_globs_json)).toEqual(['src/**/*.js']);
  });

  it('execute runs dataset build + backend train + registers alias', async () => {
    const jobId = await runtime.submit({ name: 'x', baseModel: 'b', backend: 'test', sourceGlobs: ['*.js'], workingDir: '/' });
    const result = await runtime.execute(jobId, { registerAlias: (alias, spec) => ({ ok: true, alias }) });
    expect(result.model_alias).toMatch(/^b-project-x/);
    expect(backend.train).toHaveBeenCalled();
    const row = db.prepare('SELECT status, adapter_path, model_alias FROM fine_tune_jobs WHERE job_id = ?').get(jobId);
    expect(row.status).toBe('completed');
    expect(row.adapter_path).toBe('/tmp/adapter.safetensors');
  });

  it('marks job failed if backend throws', async () => {
    const bad = { train: vi.fn(async () => { throw new Error('boom'); }) };
    const rt = createFineTuneRuntime({ db, backends: { bad }, buildDataset: async () => ({ outputPath: '/x', record_count: 1 }) });
    const jobId = await rt.submit({ name: 'x', baseModel: 'b', backend: 'bad', sourceGlobs: ['*'], workingDir: '/' });
    await expect(rt.execute(jobId, { registerAlias: () => ({}) })).rejects.toThrow(/boom/);
    const row = db.prepare('SELECT status, error FROM fine_tune_jobs WHERE job_id = ?').get(jobId);
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/boom/);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/fine-tune/fine-tune-runtime.js`:

```js
'use strict';
const { randomUUID } = require('crypto');

function createFineTuneRuntime({ db, backends, buildDataset, logger = console }) {
  async function submit({ name, baseModel, backend, sourceGlobs, workingDir, domainId = null }) {
    if (!backends[backend]) throw new Error(`Unknown backend: ${backend}`);
    const jobId = `ft_${randomUUID().slice(0, 12)}`;
    db.prepare(`
      INSERT INTO fine_tune_jobs (job_id, domain_id, name, base_model, backend, source_globs_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(jobId, domainId, name, baseModel, backend, JSON.stringify(sourceGlobs));
    return jobId;
  }

  async function execute(jobId, { registerAlias }) {
    const job = db.prepare('SELECT * FROM fine_tune_jobs WHERE job_id = ?').get(jobId);
    if (!job) throw new Error(`Unknown job ${jobId}`);

    db.prepare(`UPDATE fine_tune_jobs SET status = 'running', started_at = datetime('now') WHERE job_id = ?`).run(jobId);

    try {
      const globs = JSON.parse(job.source_globs_json);
      const datasetOut = `/tmp/${jobId}.jsonl`;
      const dataset = await buildDataset({ workingDir: job.working_dir || process.cwd(), globs, outputPath: datasetOut });
      db.prepare(`UPDATE fine_tune_jobs SET dataset_path = ? WHERE job_id = ?`).run(dataset.outputPath, jobId);

      const { adapterPath } = await backends[job.backend].train({
        datasetPath: dataset.outputPath, baseModel: job.base_model, jobId,
        onProgress: (p) => { db.prepare('UPDATE fine_tune_jobs SET progress = ? WHERE job_id = ?').run(p, jobId); },
      });
      db.prepare(`UPDATE fine_tune_jobs SET adapter_path = ? WHERE job_id = ?`).run(adapterPath, jobId);

      const alias = `${job.base_model}-project-${job.name}`;
      registerAlias(alias, { baseModel: job.base_model, adapterPath });

      db.prepare(`
        UPDATE fine_tune_jobs SET model_alias = ?, status = 'completed', progress = 1.0, completed_at = datetime('now')
        WHERE job_id = ?
      `).run(alias, jobId);

      return { job_id: jobId, model_alias: alias, adapter_path: adapterPath, record_count: dataset.record_count };
    } catch (err) {
      db.prepare(`UPDATE fine_tune_jobs SET status = 'failed', error = ?, completed_at = datetime('now') WHERE job_id = ?`)
        .run(err.message, jobId);
      throw err;
    }
  }

  function list({ status = null } = {}) {
    const sql = status ? `SELECT * FROM fine_tune_jobs WHERE status = ? ORDER BY created_at DESC`
                        : `SELECT * FROM fine_tune_jobs ORDER BY created_at DESC`;
    return status ? db.prepare(sql).all(status) : db.prepare(sql).all();
  }

  function get(jobId) { return db.prepare('SELECT * FROM fine_tune_jobs WHERE job_id = ?').get(jobId); }

  return { submit, execute, list, get };
}

module.exports = { createFineTuneRuntime };
```

Run tests → PASS. Commit: `feat(fine-tune): runtime with pluggable backends + alias registration`.

---

## Task 3: llama.cpp backend (reference) + MCP tools

- [ ] **Step 1: Reference backend**

Create `server/fine-tune/backends/llama-cpp.js`:

```js
'use strict';
const { execFile } = require('child_process');
const { promisify } = require('util');
const pExec = promisify(execFile);
const path = require('path');

// Requires llama.cpp's `finetune` binary + a base GGUF model. Paths are configured
// via TORQUE_LLAMACPP_BIN and TORQUE_LLAMACPP_MODELS_DIR env vars.
async function train({ datasetPath, baseModel, jobId, onProgress }) {
  const bin = process.env.TORQUE_LLAMACPP_BIN || '/usr/local/bin/llama-finetune';
  const modelsDir = process.env.TORQUE_LLAMACPP_MODELS_DIR || '/var/torque/models';
  const basePath = path.join(modelsDir, `${baseModel}.gguf`);
  const adapterPath = path.join(modelsDir, 'adapters', `${jobId}.lora.gguf`);

  const args = [
    '--model-base', basePath,
    '--train-data', datasetPath,
    '--lora-out', adapterPath,
    '--sample-start', 'plain',
    '--epochs', '1',
  ];
  try {
    await pExec(bin, args, { timeout: 60 * 60 * 1000 });
    onProgress?.(1.0);
    return { adapterPath };
  } catch (err) {
    throw new Error(`llama-finetune failed: ${err.message}`);
  }
}

module.exports = { train };
```

- [ ] **Step 2: MCP tool defs**

In `server/tool-defs/`:

```js
start_fine_tune: {
  description: 'Start a fine-tune job for the current project. Builds a dataset from matching source files, trains a LoRA adapter, and registers the resulting model alias for per-project routing.',
  inputSchema: {
    type: 'object',
    required: ['name', 'base_model', 'source_globs'],
    properties: {
      name: { type: 'string' },
      base_model: { type: 'string' },
      backend: { type: 'string', default: 'llama-cpp' },
      source_globs: { type: 'array', items: { type: 'string' } },
      ignore: { type: 'array', items: { type: 'string' } },
      working_dir: { type: 'string' },
    },
  },
},
list_fine_tune_jobs: { description: 'List fine-tune jobs.', inputSchema: { type: 'object', properties: { status: { type: 'string' } } } },
get_fine_tune_job: { description: 'Get one job.', inputSchema: { type: 'object', required: ['job_id'], properties: { job_id: { type: 'string' } } } },
```

- [ ] **Step 3: Container + handlers**

```js
container.factory('fineTuneRuntime', (c) => {
  const { createFineTuneRuntime } = require('./fine-tune/fine-tune-runtime');
  const { buildDataset } = require('./fine-tune/dataset-builder');
  const llamaCpp = require('./fine-tune/backends/llama-cpp');
  return createFineTuneRuntime({
    db: c.get('db'),
    backends: { 'llama-cpp': llamaCpp },
    buildDataset,
    logger: c.get('logger'),
  });
});
```

Handlers dispatch to the runtime. `start_fine_tune` calls `submit` then `execute` (inline or via a worker queue for long jobs).

`await_restart`. Smoke: `start_fine_tune({name:'torque', base_model:'qwen3-coder:30b', source_globs:['server/**/*.js']})`. Confirm job row created, dataset written, backend invoked. If llama-cpp bin isn't installed, `list_fine_tune_jobs({status:'failed'})` shows the clear error.

Commit: `feat(fine-tune): llama.cpp backend + MCP submit/list/get tools`.
