# Fabro #79: Native Provider/Prompt Evaluator

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a minimal native evaluator that answers one question: *did provider/prompt A do better than provider/prompt B on the same task spec?* It runs entirely in-process against the existing TORQUE database, reuses the existing task-execution path for the per-variant runs, and feeds results back through the existing `provider-scoring` quality channel. No OTEL, no Promptfoo, no external eval framework.

**Architecture:** One module (`server/eval/experiment-runner.js`) plus three thin support files. Two new tables (`experiments`, `experiment_runs`). One new REST route pair (`POST /api/experiments`, `GET /api/experiments/:a/diff/:b`). One new dashboard panel embedded in the existing `Providers.jsx` view. Scorers are plain JS functions in `server/eval/scorers.js` — `exactMatch`, `regexMatch`, `lengthGte`, `containsAll`, `qualityFromProviderScoring`. The runner submits each variant as a real TORQUE task via `taskCore.createTask`, awaits completion through the existing event bus, runs each scorer against the captured output, and persists per-variant aggregate scores. Two experiments referencing the same `task_spec_id` can be diffed: aggregate scorer means and per-task pairwise deltas with a winner-by-mean readout.

**Tech Stack:** Node.js, better-sqlite3, vitest, existing `taskCore`, `providerScoring`, `eventBus` from `server/container.js`. No new deps.

**Branch:** `feat/fabro-79-eval-sdk` (worktree: `.worktrees/feat-fabro-79-eval-sdk/`)

**Verify command (remote):** `torque-remote npx vitest run server/tests/`

## What this plan is NOT

- **No OTEL, no traces, no spans.** No `@opentelemetry/*` package added. The evaluator reads from `tasks` and `task_results` rows directly.
- **No Promptfoo / Braintrust / hosted eval platform integration.** No HTTP egress, no API keys.
- **No "online scorer" hook on task completion.** Online scoring against arbitrary live tasks is out of scope; quality already flows into `provider_scores` via the existing close-handler. The evaluator only scores tasks it itself submitted.
- **No multi-row dataset replay against an LLM-as-judge.** Variants run on a single `task_spec` (description + working_directory + verify_command). Multi-row datasets are a future concern.
- **No new MCP tool surface.** A REST route + a dashboard panel is enough for the operator-facing question. MCP exposure can be layered later without rewriting the runner.
- **No changes to the close-handler pipeline.** The existing `provider-scoring` aggregate keeps updating exactly as today.

## Sandbox-tolerant verify fallback

Each task below has Run-tests steps. Execute in this priority order:

1. **Preferred:** `torque-remote npx vitest run <path/to/test>` — runs on the remote workstation.
2. **Fallback 1:** `npx vitest run <path/to/test> --pool=threads --no-coverage` — avoids the fork-pool that sometimes hits `spawn EPERM`.
3. **Fallback 2:** If both fail with spawn / access errors, note the exact error text, skip the run step, and proceed to the commit step. The host's post-task verification will surface regressions. Include "verify step skipped due to sandbox spawn restriction" in your final output.

Do not let a blocked vitest invocation prevent you from committing a correct code change.

---

## Task 1: Schema migration for `experiments` and `experiment_runs`

**Acceptance:** Two new tables exist after `runMigrations`. Both tolerate the minimal-schema test fixture (no foreign key to `tasks`). A test asserts the tables and their indexes are present.

**Files:**
- Modify: `server/db/migrations.js` (append a new migration entry — use the next available version)
- Test: `server/tests/eval-experiments-migration.test.js` (create)

- [ ] **Step 1.1: Write the failing test**

Create `server/tests/eval-experiments-migration.test.js`:

```javascript
import { describe, it, expect, beforeEach } from 'vitest';

const Database = require('better-sqlite3');
const { runMigrations } = require('../db/migrations');

describe('experiments + experiment_runs migration', () => {
  let db;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  it('creates experiments table with expected columns', () => {
    const cols = db.prepare("PRAGMA table_info('experiments')").all().map((c) => c.name);
    for (const required of ['experiment_id', 'name', 'task_spec_json', 'created_at', 'parent_experiment_id', 'status']) {
      expect(cols).toContain(required);
    }
  });

  it('creates experiment_runs table with expected columns', () => {
    const cols = db.prepare("PRAGMA table_info('experiment_runs')").all().map((c) => c.name);
    for (const required of [
      'run_id', 'experiment_id', 'variant_label', 'provider', 'prompt_template',
      'task_id', 'output_text', 'duration_ms', 'error', 'scores_json', 'created_at',
    ]) {
      expect(cols).toContain(required);
    }
  });

  it('creates the per-experiment index on experiment_runs', () => {
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='experiment_runs'").all();
    const names = idx.map((r) => r.name);
    expect(names.some((n) => n.includes('experiment'))).toBe(true);
  });
});
```

- [ ] **Step 1.2: Run test to verify it fails**

Run: `torque-remote npx vitest run server/tests/eval-experiments-migration.test.js`
Expected: FAIL — tables do not yet exist.

- [ ] **Step 1.3: Append the migration entry**

In `server/db/migrations.js`, append a new entry to the `MIGRATIONS` array. Use the next available `version` number (grep `version: ` in the file and add one). Mirror the table-create pattern used by migration 6 (`add_benchmark_results_table`) — emit the SQL as a string array joined with `\n`. This avoids touching `sqliteDb.exec` directly and keeps every statement visible at review time:

```javascript
{
  version: <NEXT>,
  name: 'add_eval_experiments_tables',
  up: [
    'CREATE TABLE IF NOT EXISTS experiments (',
    '  experiment_id TEXT PRIMARY KEY,',
    '  name TEXT NOT NULL,',
    '  task_spec_json TEXT NOT NULL,',
    '  parent_experiment_id TEXT,',
    "  status TEXT NOT NULL DEFAULT 'running',",
    "  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),",
    '  finished_at TEXT',
    ');',
    'CREATE TABLE IF NOT EXISTS experiment_runs (',
    '  run_id TEXT PRIMARY KEY,',
    '  experiment_id TEXT NOT NULL,',
    '  variant_label TEXT NOT NULL,',
    '  provider TEXT NOT NULL,',
    '  prompt_template TEXT,',
    '  task_id INTEGER,',
    '  output_text TEXT,',
    '  duration_ms INTEGER,',
    '  error TEXT,',
    '  scores_json TEXT,',
    "  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
    ');',
    'CREATE INDEX IF NOT EXISTS idx_experiment_runs_experiment ON experiment_runs(experiment_id);',
    'CREATE INDEX IF NOT EXISTS idx_experiment_runs_variant ON experiment_runs(experiment_id, variant_label);',
  ].join('\n'),
  down: [
    'DROP INDEX IF EXISTS idx_experiment_runs_variant',
    'DROP INDEX IF EXISTS idx_experiment_runs_experiment',
    'DROP TABLE IF EXISTS experiment_runs',
    'DROP TABLE IF EXISTS experiments',
  ].join(';\n'),
},
```

Do not add a foreign key from `experiment_runs.task_id` to `tasks.id`. The minimal-schema test fixture omits the `tasks` table; an FK would break unrelated tests.

- [ ] **Step 1.4: Run test to verify it passes**

Run: `torque-remote npx vitest run server/tests/eval-experiments-migration.test.js`
Expected: 3 passing tests.

- [ ] **Step 1.5: Commit**

```bash
git add server/db/migrations.js server/tests/eval-experiments-migration.test.js
git commit -m "feat(eval): migration for experiments + experiment_runs tables"
```

---

## Task 2: Pure scorer library

**Acceptance:** `server/eval/scorers.js` exports five named scorers and a `runScorers(scorerSpecs, ctx)` helper that returns `{ name, value, metadata? }[]`. All scorers are pure functions: no DB access, no I/O, no clock dependence. Tests cover happy path, edge inputs, and unknown-name rejection.

**Files:**
- Create: `server/eval/scorers.js`
- Test: `server/tests/eval-scorers.test.js`

- [ ] **Step 2.1: Write the failing test**

Create `server/tests/eval-scorers.test.js`:

```javascript
import { describe, it, expect } from 'vitest';

const { SCORERS, runScorers } = require('../eval/scorers');

describe('eval scorers', () => {
  it('exactMatch returns 1 when output matches expected, 0 otherwise', () => {
    expect(SCORERS.exactMatch.fn({ output: 'hi', expected: 'hi' }).value).toBe(1);
    expect(SCORERS.exactMatch.fn({ output: 'hi', expected: 'bye' }).value).toBe(0);
  });

  it('regexMatch returns 1 when output matches the supplied pattern', () => {
    expect(SCORERS.regexMatch.fn({ output: 'abc123', args: { pattern: '\\d+' } }).value).toBe(1);
    expect(SCORERS.regexMatch.fn({ output: 'abc',    args: { pattern: '\\d+' } }).value).toBe(0);
  });

  it('lengthGte returns 1 when output length is at least min', () => {
    expect(SCORERS.lengthGte.fn({ output: 'abcdef', args: { min: 5 } }).value).toBe(1);
    expect(SCORERS.lengthGte.fn({ output: 'ab',     args: { min: 5 } }).value).toBe(0);
  });

  it('containsAll returns 1 only when every needle appears in output', () => {
    expect(SCORERS.containsAll.fn({ output: 'foo bar baz', args: { needles: ['foo', 'baz'] } }).value).toBe(1);
    expect(SCORERS.containsAll.fn({ output: 'foo bar',     args: { needles: ['foo', 'baz'] } }).value).toBe(0);
  });

  it('runScorers returns an array shaped { name, value } for each spec', () => {
    const out = runScorers(
      [{ name: 'exactMatch' }, { name: 'lengthGte', args: { min: 1 } }],
      { output: 'hi', expected: 'hi' },
    );
    expect(out).toHaveLength(2);
    expect(out[0].name).toBe('exactMatch');
    expect(out[0].value).toBe(1);
    expect(out[1].value).toBe(1);
  });

  it('runScorers throws on unknown scorer name', () => {
    expect(() => runScorers([{ name: 'doesNotExist' }], { output: '' })).toThrow(/unknown scorer/i);
  });

  it('null/undefined output never throws — coerces to empty string', () => {
    expect(() => SCORERS.lengthGte.fn({ output: null, args: { min: 1 } })).not.toThrow();
    expect(SCORERS.lengthGte.fn({ output: null, args: { min: 1 } }).value).toBe(0);
  });
});
```

- [ ] **Step 2.2: Run test to verify it fails**

Run: `torque-remote npx vitest run server/tests/eval-scorers.test.js`
Expected: FAIL — `Cannot find module '../eval/scorers'`.

- [ ] **Step 2.3: Implement `scorers.js`**

Create `server/eval/scorers.js`. The module must define a `SCORERS` object whose keys are scorer names and whose values each have `{ name, description, fn }`. The `fn` takes a context object and returns `{ value, metadata? }`. Required scorers and their semantics:

- `exactMatch`: returns 1 if `String(output) === String(expected)`, else 0. Coerces `null`/`undefined` to `''`.
- `regexMatch`: builds a `RegExp` from `args.pattern` and tests against `output`. Returns 0 with `metadata.reason` on missing or invalid pattern. Never throws.
- `lengthGte`: returns 1 when `String(output).length >= args.min`. Returns 0 with `metadata.reason: 'invalid_min'` when `args.min` is not a finite number.
- `containsAll`: returns 1 only when every needle in `args.needles` is a substring of `output`. Returns 0 with `metadata.reason: 'no_needles'` when the needles array is empty.
- `qualityFromProviderScoring`: pure-by-injection. Reads `ctx.providerQuality` (a number in `[0, 1]` supplied by the runner) and clamps it. Returns 0 with `metadata.reason: 'no_quality_data'` when it is missing or non-finite.

`runScorers(scorerSpecs, baseCtx)` iterates the specs, looks each one up in `SCORERS`, throws `unknown scorer: <name>` for misses, and returns `[{ name, value, metadata? }]`. Pure — no DB, no clock, no I/O.

- [ ] **Step 2.4: Run test to verify it passes**

Run: `torque-remote npx vitest run server/tests/eval-scorers.test.js`
Expected: 7 passing tests.

- [ ] **Step 2.5: Commit**

```bash
git add server/eval/scorers.js server/tests/eval-scorers.test.js
git commit -m "feat(eval): pure scorer library with exact/regex/length/containsAll/quality"
```

---

## Task 3: `experiment-runner.js` — `runExperiment(taskSpec, variants)`

**Acceptance:** Module exports `createExperimentRunner({ db, taskCore, providerScoring, eventBus, logger })` returning `{ runExperiment, getExperiment, listExperiments }`. `runExperiment(taskSpec, variants, options)` creates an `experiments` row, submits one TORQUE task per variant via `taskCore.createTask`, awaits each task's terminal event, captures `output` + `duration_ms` + `error_message`, runs the configured scorers, persists one `experiment_runs` row per variant, and returns `{ experiment_id, variants: [{ variant_label, provider, scores, mean }] }`. Tests use a fake `taskCore`, fake `eventBus`, and an in-memory DB — no real LLM is called.

**Files:**
- Create: `server/eval/experiment-runner.js`
- Test: `server/tests/eval-experiment-runner.test.js`

- [ ] **Step 3.1: Write the failing test**

Create `server/tests/eval-experiment-runner.test.js`:

```javascript
import { describe, it, expect, beforeEach } from 'vitest';

const Database = require('better-sqlite3');
const { runMigrations } = require('../db/migrations');
const { createExperimentRunner } = require('../eval/experiment-runner');

function makeFakeTaskCore(scriptedOutputs) {
  let nextId = 100;
  const created = [];
  return {
    created,
    createTask: ({ description, provider }) => {
      const id = nextId++;
      created.push({ id, description, provider });
      return { id };
    },
    getTask: (id) => {
      const idx = id - 100;
      const scripted = scriptedOutputs[idx] || {};
      return {
        id,
        status: scripted.error ? 'failed' : 'completed',
        output: scripted.output ?? '',
        duration_ms: scripted.duration_ms ?? 1000,
        error_message: scripted.error || null,
      };
    },
  };
}

function makeFakeEventBus(scriptedOutputs) {
  // Synchronously fire terminal events when subscribed.
  return {
    onTaskTerminal: (taskId, cb) => {
      const idx = taskId - 100;
      const scripted = scriptedOutputs[idx] || {};
      queueMicrotask(() => cb({
        task_id: taskId,
        status: scripted.error ? 'failed' : 'completed',
      }));
      return () => {};
    },
  };
}

describe('experiment-runner', () => {
  let db, runner, fakeTaskCore;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    const scriptedOutputs = [
      { output: 'hello world', duration_ms: 500 },
      { output: 'hi',          duration_ms: 200 },
    ];
    fakeTaskCore = makeFakeTaskCore(scriptedOutputs);
    runner = createExperimentRunner({
      db,
      taskCore: fakeTaskCore,
      eventBus: makeFakeEventBus(scriptedOutputs),
      providerScoring: { getProviderScore: () => ({ quality_score: 0.8 }) },
      logger: { info() {}, warn() {}, error() {} },
    });
  });

  it('creates one experiments row and one experiment_runs row per variant', async () => {
    const result = await runner.runExperiment(
      { description: 'Say hello', working_directory: '/tmp' },
      [
        { label: 'A', provider: 'codex',  prompt_template: 'verbose' },
        { label: 'B', provider: 'ollama', prompt_template: 'terse' },
      ],
      { scorers: [{ name: 'lengthGte', args: { min: 5 } }] },
    );

    expect(result.experiment_id).toMatch(/^exp_/);
    const exp = db.prepare('SELECT * FROM experiments WHERE experiment_id = ?').get(result.experiment_id);
    expect(exp.status).toBe('completed');
    const runs = db.prepare('SELECT * FROM experiment_runs WHERE experiment_id = ? ORDER BY variant_label').all(result.experiment_id);
    expect(runs).toHaveLength(2);
    expect(runs[0].variant_label).toBe('A');
    expect(runs[0].provider).toBe('codex');
    expect(runs[1].provider).toBe('ollama');
  });

  it('runs the requested scorers and persists scores_json', async () => {
    const result = await runner.runExperiment(
      { description: 'Say hello', working_directory: '/tmp' },
      [{ label: 'A', provider: 'codex' }, { label: 'B', provider: 'ollama' }],
      { scorers: [{ name: 'lengthGte', args: { min: 5 } }] },
    );
    const variantA = result.variants.find((v) => v.variant_label === 'A');
    const variantB = result.variants.find((v) => v.variant_label === 'B');
    expect(variantA.scores.lengthGte).toBe(1); // 'hello world' >= 5
    expect(variantB.scores.lengthGte).toBe(0); // 'hi' < 5
  });

  it('captures task errors without aborting sibling variants', async () => {
    const scriptedOutputs = [{ error: 'boom' }, { output: 'ok output' }];
    const localTaskCore = makeFakeTaskCore(scriptedOutputs);
    const localRunner = createExperimentRunner({
      db,
      taskCore: localTaskCore,
      eventBus: makeFakeEventBus(scriptedOutputs),
      providerScoring: { getProviderScore: () => null },
      logger: { info() {}, warn() {}, error() {} },
    });
    const result = await localRunner.runExperiment(
      { description: 'X', working_directory: '/tmp' },
      [{ label: 'A', provider: 'codex' }, { label: 'B', provider: 'ollama' }],
      { scorers: [{ name: 'lengthGte', args: { min: 1 } }] },
    );
    const runs = db.prepare('SELECT variant_label, error FROM experiment_runs WHERE experiment_id = ? ORDER BY variant_label').all(result.experiment_id);
    expect(runs[0].error).toMatch(/boom/);
    expect(runs[1].error).toBeNull();
  });

  it('listExperiments returns experiments newest-first', async () => {
    await runner.runExperiment({ description: 'first',  working_directory: '/tmp' }, [{ label: 'A', provider: 'codex' }], { scorers: [] });
    await runner.runExperiment({ description: 'second', working_directory: '/tmp' }, [{ label: 'A', provider: 'codex' }], { scorers: [] });
    const rows = runner.listExperiments({ limit: 10 });
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0].task_spec_json).description).toBe('second');
  });
});
```

- [ ] **Step 3.2: Run test to verify it fails**

Run: `torque-remote npx vitest run server/tests/eval-experiment-runner.test.js`
Expected: FAIL — `Cannot find module '../eval/experiment-runner'`.

- [ ] **Step 3.3: Implement `experiment-runner.js`**

Create `server/eval/experiment-runner.js`. Required behavior:

- Factory `createExperimentRunner({ db, taskCore, providerScoring, eventBus, logger })`. Must throw if `db`, `taskCore`, or `eventBus` is missing.
- `runExperiment(taskSpec, variants, options)`:
  1. Validate `taskSpec.description` and `variants.length >= 1`.
  2. Generate `experiment_id` like `exp_<uuid12>`. Insert into `experiments` with `status='running'`, `task_spec_json = JSON.stringify(taskSpec)`, `name = options.name || taskSpec.description.slice(0, 80)`, optional `parent_experiment_id`.
  3. For each variant in order:
     - Apply `options.applyPromptTemplate?(taskSpec.description, variant.prompt_template)` if provided, else prefix with `[template:<name>]\n` when the variant carries a template, else use the description as-is.
     - Call `taskCore.createTask({ description, working_directory, provider, verify_command, version_intent: 'internal' })`. On throw, persist a failed `experiment_runs` row with `error = <message>` and continue.
     - Subscribe via `eventBus.onTaskTerminal(taskId, cb)` and `await` resolution.
     - Read `taskCore.getTask(taskId)`. Capture `output` (string), `duration_ms`, `error_message` (or synthesize `task <status>` for non-completed).
     - When there is no error and `options.scorers?.length > 0`, build `ctx = { output, expected: taskSpec.expected, ctx: { providerQuality } }` where `providerQuality` comes from `providerScoring.getProviderScore(variant.provider)?.quality_score`. Call `runScorers(options.scorers, ctx)`. Wrap in try/catch — log a warning but never throw.
     - Insert one `experiment_runs` row with `run_id = run_<uuid12>`, the score results JSON-encoded.
  4. Update `experiments` to `status='completed'` and `finished_at = now()`.
  5. Return `{ experiment_id, variants: [{ variant_label, provider, scores: {name -> value}, mean, error }] }` where `mean` is the arithmetic mean of all numeric score values for the variant, or 0 when no scorers ran.
- `getExperiment(experimentId)`: returns the `experiments` row plus its `runs` array, or `null` when missing.
- `listExperiments({ limit = 50 } = {})`: returns experiments ordered by `created_at DESC`.

The runner must not import the container directly. All dependencies arrive via the factory argument so tests stay deterministic.

- [ ] **Step 3.4: Run test to verify it passes**

Run: `torque-remote npx vitest run server/tests/eval-experiment-runner.test.js`
Expected: 4 passing tests.

- [ ] **Step 3.5: Commit**

```bash
git add server/eval/experiment-runner.js server/tests/eval-experiment-runner.test.js
git commit -m "feat(eval): runExperiment submits per-variant tasks and persists per-variant scores"
```

---

## Task 4: `experiment-diff.js` — winner-by-mean comparator

**Acceptance:** `diffExperiments(db, aId, bId)` returns `{ a, b, summary: { [scorer_name]: { a_mean, b_mean, delta, winner } }, per_variant: {...} }`. The two experiments must reference the same `task_spec_json` (or the function returns `{ error: 'task_spec_mismatch' }` — fail-loud, not fail-silent). Tests cover happy path (one wins), tie, mismatched spec, and missing-experiment.

**Files:**
- Create: `server/eval/experiment-diff.js`
- Test: `server/tests/eval-experiment-diff.test.js`

- [ ] **Step 4.1: Write the failing test**

Create `server/tests/eval-experiment-diff.test.js`:

```javascript
import { describe, it, expect, beforeEach } from 'vitest';

const Database = require('better-sqlite3');
const { runMigrations } = require('../db/migrations');
const { diffExperiments } = require('../eval/experiment-diff');

function seedExperiment(db, id, taskSpec, runs) {
  db.prepare("INSERT INTO experiments (experiment_id, name, task_spec_json, status) VALUES (?, ?, ?, 'completed')")
    .run(id, id, JSON.stringify(taskSpec));
  for (const r of runs) {
    db.prepare(
      'INSERT INTO experiment_runs (run_id, experiment_id, variant_label, provider, output_text, duration_ms, scores_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(r.run_id, id, r.label, r.provider, r.output || '', r.duration_ms || 0, JSON.stringify(r.scores || []));
  }
}

describe('experiment-diff', () => {
  let db;
  const sameSpec = { description: 'Say hello', working_directory: '/tmp' };

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  it('reports the experiment with the higher mean score as the winner per scorer', () => {
    seedExperiment(db, 'exp_a', sameSpec, [
      { run_id: 'r1', label: 'A', provider: 'codex',  scores: [{ name: 'exactMatch', value: 1 }] },
      { run_id: 'r2', label: 'B', provider: 'ollama', scores: [{ name: 'exactMatch', value: 1 }] },
    ]);
    seedExperiment(db, 'exp_b', sameSpec, [
      { run_id: 'r3', label: 'A', provider: 'codex',  scores: [{ name: 'exactMatch', value: 0 }] },
      { run_id: 'r4', label: 'B', provider: 'ollama', scores: [{ name: 'exactMatch', value: 0 }] },
    ]);
    const d = diffExperiments(db, 'exp_a', 'exp_b');
    expect(d.summary.exactMatch.a_mean).toBe(1);
    expect(d.summary.exactMatch.b_mean).toBe(0);
    expect(d.summary.exactMatch.winner).toBe('a');
  });

  it('reports tie when means are equal', () => {
    seedExperiment(db, 'exp_a', sameSpec, [
      { run_id: 'r1', label: 'A', provider: 'codex', scores: [{ name: 'exactMatch', value: 1 }] },
    ]);
    seedExperiment(db, 'exp_b', sameSpec, [
      { run_id: 'r2', label: 'A', provider: 'codex', scores: [{ name: 'exactMatch', value: 1 }] },
    ]);
    const d = diffExperiments(db, 'exp_a', 'exp_b');
    expect(d.summary.exactMatch.winner).toBe('tie');
  });

  it('returns task_spec_mismatch when the two experiments target different specs', () => {
    seedExperiment(db, 'exp_a', sameSpec, []);
    seedExperiment(db, 'exp_b', { description: 'different', working_directory: '/tmp' }, []);
    const d = diffExperiments(db, 'exp_a', 'exp_b');
    expect(d.error).toBe('task_spec_mismatch');
  });

  it('returns missing_experiment when an id does not exist', () => {
    seedExperiment(db, 'exp_a', sameSpec, []);
    const d = diffExperiments(db, 'exp_a', 'nope');
    expect(d.error).toBe('missing_experiment');
  });
});
```

- [ ] **Step 4.2: Run test to verify it fails**

Run: `torque-remote npx vitest run server/tests/eval-experiment-diff.test.js`
Expected: FAIL — `Cannot find module '../eval/experiment-diff'`.

- [ ] **Step 4.3: Implement `experiment-diff.js`**

Create `server/eval/experiment-diff.js`. Required behavior:

- `diffExperiments(db, aId, bId)`:
  1. Load each experiment row plus its `experiment_runs`. If either is missing, return `{ error: 'missing_experiment', a_found, b_found }`.
  2. Compare the two `task_spec_json` strings. On mismatch return `{ error: 'task_spec_mismatch' }`.
  3. For each side, parse every run's `scores_json` and aggregate per-scorer `{ sum, count }`, then compute the mean.
  4. For each scorer name appearing on either side, compute `delta = b_mean - a_mean` and pick `winner`: `'tie'` when `|delta| <= 1e-9`, else `'b'` when delta > 0, else `'a'`.
  5. Build `per_variant`: index each side's runs by `variant_label` and align by label so the operator can see pairwise output differences.
  6. Return `{ a: aExp, b: bExp, summary: { [name]: { a_mean, b_mean, delta, winner } }, per_variant }`.

- [ ] **Step 4.4: Run test to verify it passes**

Run: `torque-remote npx vitest run server/tests/eval-experiment-diff.test.js`
Expected: 4 passing tests.

- [ ] **Step 4.5: Commit**

```bash
git add server/eval/experiment-diff.js server/tests/eval-experiment-diff.test.js
git commit -m "feat(eval): diffExperiments returns winner-by-mean per scorer"
```

---

## Task 5: DI registration + REST routes

**Acceptance:** `experimentRunner` is registered in `server/container.js` (lazy factory, not a `registerValue`). Two REST routes are added: `POST /api/experiments` (run one) and `GET /api/experiments/:a/diff/:b` (compare two). Tests use the existing route-test scaffolding pattern (mirror `dashboard-infrastructure-routes.test.js`).

**Files:**
- Modify: `server/container.js` — register `experimentRunner` in the existing factory block, alongside `providerScoring`
- Create: `server/api/routes-experiments.js`
- Modify: whichever file mounts route modules under `/api` (grep `app.use('/api'` to find it)
- Test: `server/tests/eval-routes.test.js` (create, modeled after `server/tests/dashboard-infrastructure-routes.test.js`)

- [ ] **Step 5.1: Find the existing route-mount pattern**

Run: `grep -n "app.use('/api" server/api*.js server/index.js 2>/dev/null`
Note the convention. Mount `routes-experiments.js` the same way. If routes are registered as a function call like `registerExperimentsRoutes(app, deps)`, follow that pattern.

- [ ] **Step 5.2: Find the existing DI factory-block pattern**

Run: `grep -nB1 -A5 "register.*providerScoring" server/container.js`
Register `experimentRunner` in the same block, not via `registerValue`. Reference: `feedback_di_factory_registration.md` in user memory — factories run lazily and re-resolve when the container is reset for tests.

- [ ] **Step 5.3: Write the failing test**

Create `server/tests/eval-routes.test.js` modeled after an existing route test (e.g. `server/tests/dashboard-infrastructure-routes.test.js`). At minimum the test must:
- Build the express app via the project's existing test scaffold.
- Stub `experimentRunner` via `defaultContainer.registerValue('experimentRunner', stub)` so the routes resolve a deterministic fake.
- Send `POST /api/experiments` with `{ task_spec, variants, scorers }` and assert the response body contains `experiment_id`.
- Send `GET /api/experiments/:a/diff/:b` and assert one of the documented responses (200 with summary, 404 missing, 422 mismatched spec).

Mirror the assertion shape from the closest neighbour route test rather than inventing a new harness.

- [ ] **Step 5.4: Implement the route module + DI registration**

Create `server/api/routes-experiments.js` that exports a registration function matching the repo's existing route-module convention (look at `server/api/routes-passthrough.js` for the shape). Handlers:
- `POST /api/experiments` — body: `{ task_spec, variants, scorers, name?, parent_experiment_id? }`. Calls `experimentRunner.runExperiment(task_spec, variants, { scorers, name, parentExperimentId })`. Returns the result. On validation error, respond 400.
- `GET /api/experiments/:a/diff/:b` — calls `diffExperiments(db, a, b)`. Maps `error: 'missing_experiment'` to 404 and `error: 'task_spec_mismatch'` to 422.
- `GET /api/experiments/:id` — returns `experimentRunner.getExperiment(id)` or 404.
- `GET /api/experiments` — returns `experimentRunner.listExperiments({ limit })`.

In `server/container.js`, register the runner alongside `providerScoring`. Resolve `db` via the container facade and unwrap to the raw better-sqlite3 instance — see `feedback_di_container_db_facade_unwrap.md` in user memory. Resolve `taskCore`, `providerScoring`, `eventBus`, and `logger` from the container as well. Do not capture the resolved values at registration time; resolve them lazily inside the factory so test resets see fresh dependencies.

- [ ] **Step 5.5: Run tests to verify**

Run: `torque-remote npx vitest run server/tests/eval-routes.test.js`
Expected: tests pass.

- [ ] **Step 5.6: Commit**

```bash
git add server/eval/ server/container.js server/api/routes-experiments.js server/tests/eval-routes.test.js
git commit -m "feat(eval): DI factory + REST routes for run + diff"
```

(Adjust the `git add` list to include only files actually modified in your route-mount edit.)

---

## Task 6: Dashboard panel — "Provider A vs B" inside `Providers.jsx`

**Acceptance:** A new section in `dashboard/src/views/Providers.jsx` lets the operator pick two providers, paste a task description, run an experiment, and see the winner-per-scorer table. No new route, no new top-level view — embedded in the existing Providers page, behind a "Run A/B" button. Test asserts the form renders and submits to `POST /api/experiments`.

**Files:**
- Modify: `dashboard/src/views/Providers.jsx` (add the panel)
- Test: `dashboard/src/views/Providers.test.jsx` (extend existing test or add a new `describe('A/B experiment panel', ...)`)

- [ ] **Step 6.1: Read the current `Providers.jsx`**

Run: `wc -l dashboard/src/views/Providers.jsx` and read the file. Identify the natural insertion point (likely after the provider stats table). Use the existing `api.js` helpers — do not introduce a new fetch wrapper. Reference: `dashboard/src/api.js`.

- [ ] **Step 6.2: Write the failing test**

Extend `Providers.test.jsx` (or create a new test file alongside) asserting:
- The panel renders a textarea, two provider dropdowns, and a "Run A/B" button.
- Clicking the button calls the API helper that wraps `POST /api/experiments` with the form values.
- After the response resolves, the panel renders a winner-per-scorer table.

Use `@testing-library/react` and `vi.mock` on the `api.js` module — mirror the pattern used by `RoutingTemplates.test.jsx` and `ProjectSettings.test.jsx`.

- [ ] **Step 6.3: Implement the panel**

Add the panel component inside `Providers.jsx`. Two provider `<select>` elements wired to the existing provider list, a `<textarea>` for the task description, a `<button>` that posts to `/api/experiments` with both providers as variants, and a results table that renders `summary[scorer].winner`. Default scorers: `lengthGte` (min: 50) — concrete enough to prove the loop works without an LLM-as-judge.

- [ ] **Step 6.4: Run dashboard tests**

Run: `torque-remote bash -c 'cd dashboard && npx vitest run src/views/Providers.test.jsx'`
Expected: existing tests + the new ones pass.

- [ ] **Step 6.5: Visual verify (peek)**

After committing, capture the live dashboard to confirm the panel renders:

    peek_ui({ process: 'TORQUE Dashboard' })  # or peek_ui({ title: 'Providers' })

If the panel does not render or the form does not submit, fix before moving to Task 7.

- [ ] **Step 6.6: Commit**

```bash
git add dashboard/src/views/Providers.jsx dashboard/src/views/Providers.test.jsx
git commit -m "feat(eval): Providers view A/B experiment panel"
```

---

## Task 7: End-to-end verification — compare two routing templates

**Acceptance:** A scripted operator-style verification proves the full pipeline works against a real task. Two routing templates (`Cost Saver` vs `Quality First`) are compared on the same task spec; the diff endpoint returns a clear winner per scorer; the dashboard panel renders the same result.

**Files:**
- Create: `server/tests/eval-end-to-end.test.js` (gated behind an env var so it only runs when explicitly requested — this test calls real LLMs and costs money/time)
- Update: `docs/findings/<date>-fabro-79-verification.md` (operator-written report; do not generate via an LLM)

- [ ] **Step 7.1: Write the gated end-to-end test**

Create `server/tests/eval-end-to-end.test.js`:

```javascript
import { describe, it, expect } from 'vitest';

const RUN = process.env.RUN_EVAL_E2E === '1';
const maybe = RUN ? describe : describe.skip;

maybe('eval end-to-end (gated by RUN_EVAL_E2E=1)', () => {
  it('runs two variants of the same task on two providers and reports a winner', async () => {
    const { defaultContainer } = require('../container');
    const runner = defaultContainer.get('experimentRunner');
    const { diffExperiments } = require('../eval/experiment-diff');
    const db = defaultContainer.get('db').getDbInstance();

    const taskSpec = {
      description: 'Write a one-paragraph plain-English description of the TORQUE smart routing system.',
      working_directory: process.cwd(),
    };

    const expA = await runner.runExperiment(taskSpec, [
      { label: 'A', provider: 'ollama' },
      { label: 'B', provider: 'codex' },
    ], { name: 'Cost Saver A/B', scorers: [{ name: 'lengthGte', args: { min: 200 } }] });

    const expB = await runner.runExperiment(taskSpec, [
      { label: 'A', provider: 'ollama' },
      { label: 'B', provider: 'codex' },
    ], { name: 'Quality First A/B', scorers: [{ name: 'lengthGte', args: { min: 200 } }] });

    const diff = diffExperiments(db, expA.experiment_id, expB.experiment_id);
    expect(diff.error).toBeUndefined();
    expect(diff.summary.lengthGte).toBeDefined();
    expect(['a', 'b', 'tie']).toContain(diff.summary.lengthGte.winner);
    // eslint-disable-next-line no-console
    console.log('verification result:', JSON.stringify(diff.summary, null, 2));
  }, 600_000);
});
```

- [ ] **Step 7.2: Run the gated test (operator action)**

```bash
RUN_EVAL_E2E=1 torque-remote npx vitest run server/tests/eval-end-to-end.test.js
```

Capture the JSON output and the experiment IDs.

- [ ] **Step 7.3: Open the dashboard, hit "Run A/B" with the same task**

Confirm the panel reports the same winner. Use `peek_ui({ process: 'TORQUE Dashboard' })` to capture proof.

- [ ] **Step 7.4: Write the verification doc**

Create `docs/findings/<date>-fabro-79-verification.md` summarizing:
- The two experiment IDs.
- The diff payload (paste the JSON).
- A screenshot of the dashboard panel (optional — peek_ui output can be referenced by file path).
- A one-line verdict: which variant won, and by how much.

- [ ] **Step 7.5: Commit**

```bash
git add server/tests/eval-end-to-end.test.js docs/findings/
git commit -m "test(eval): gated end-to-end + verification report comparing two routing templates"
```

---

## Task 8: Docs

**Acceptance:** `docs/factory.md` (or wherever provider docs live — grep for `provider_scoring` to find the right home) gains a short "Native Evaluator" section pointing at the REST routes, the dashboard panel, and the gated test. No marketing copy — just where the surfaces are.

**Files:**
- Modify: `docs/factory.md` or the analogous existing doc

- [ ] **Step 8.1: Append the section**

```markdown
## Native Evaluator (Fabro #79)

The native evaluator answers a single question: did provider/prompt A do better
than provider/prompt B on the same task? It runs in-process against the existing
`tasks` and `provider_scores` tables. No OTEL, no Promptfoo, no external eval
platform.

- **Run an experiment:** `POST /api/experiments` with `{ task_spec, variants, scorers }`
- **Diff two experiments:** `GET /api/experiments/:a/diff/:b` (returns winner-per-scorer)
- **Dashboard panel:** Providers view -> "Run A/B" button
- **Schema:** `experiments` + `experiment_runs` (migration <NEXT>)
- **Code:** `server/eval/experiment-runner.js`, `server/eval/scorers.js`, `server/eval/experiment-diff.js`
- **Gated end-to-end test:** `RUN_EVAL_E2E=1 torque-remote npx vitest run server/tests/eval-end-to-end.test.js`

Scorers ship pure: `exactMatch`, `regexMatch`, `lengthGte`, `containsAll`,
`qualityFromProviderScoring`. Add new scorers by extending `SCORERS` in
`server/eval/scorers.js`.
```

- [ ] **Step 8.2: Commit**

```bash
git add docs/factory.md
git commit -m "docs(eval): native evaluator surfaces and where to find them"
```

---

## Task 9: Full-suite regression

**Acceptance:** The full server test suite passes remotely. Dashboard tests pass. No new pre-existing failures.

- [ ] **Step 9.1: Run the full server suite**

Run: `torque-remote npx vitest run server/tests/`
Expected: all tests pass. If new failures appear, root-cause and fix before merging — do not weaken assertions to make them pass.

- [ ] **Step 9.2: Run the dashboard suite**

Run: `torque-remote bash -c 'cd dashboard && npx vitest run'`
Expected: all tests pass.

- [ ] **Step 9.3: Run the DB-query audit**

Run: `torque-remote bash -c 'cd server && npm run audit:db -- --strict'`
Expected: no new uncovered WHEREs. Migration <NEXT> already covers `experiment_runs(experiment_id)` and `experiment_runs(experiment_id, variant_label)`.

---

## Post-plan operator rollout

1. Cut over via `scripts/worktree-cutover.sh fabro-79-eval-sdk`.
2. Run the gated end-to-end test (Task 7.2) once on `main` to confirm the production wiring works.
3. Add a second batch of scorers (e.g. `cosineSimilarity` if and when an embedding source lands; today's pure-string scorers cover the operator-relevant questions).
4. If the panel sees real use, expose `runExperiment` as an MCP tool — but only after the REST and dashboard surface has been used in anger for at least a week. Premature MCP exposure adds rollback cost without providing operator value the dashboard does not already provide.

`version_intent`: `feature`.
