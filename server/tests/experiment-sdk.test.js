'use strict';

/**
 * Comprehensive Experiment SDK tests — covers:
 *   - Scorer reuse (fromFunction, fromTraceScorer, createScorer interop)
 *   - Experiment immutability
 *   - Diff behavior (same dataset, different datasets, edge cases)
 *   - Score-store persistence (DB round-trip)
 *   - Invalid input errors for all SDK entry points
 */

const { createScorer, fromFunction, fromTraceScorer } = require('../evals/scorer');
const { composeScorers } = require('../evals/compose-scorers');
const { createSolver, chainSolvers } = require('../evals/solver');
const { createTaskSpec } = require('../evals/task-spec');
const { runExperiment, diffExperiments, computeDatasetIdentity } = require('../evals/experiment');
const { runSample, runSamples } = require('../evals/run-sample');

// ── Scorer Reuse ──

describe('scorer reuse (fromFunction)', () => {
  it('wraps a numeric-returning function into a scorer', async () => {
    const fn = (sample, result) => result.output === sample.expected ? 1 : 0;
    const scorer = fromFunction(fn, 'exact_match');

    expect(scorer.kind).toBe('exact_match');
    const s1 = await scorer.score({ expected: 'yes' }, { output: 'yes' });
    expect(s1.value).toBe(1);
    expect(s1.kind).toBe('exact_match');

    const s2 = await scorer.score({ expected: 'yes' }, { output: 'no' });
    expect(s2.value).toBe(0);
  });

  it('wraps an object-returning function into a scorer', async () => {
    const fn = (sample, result) => ({
      value: result.output.length > 10 ? 1 : 0.5,
      detail: 'length check',
    });
    const scorer = fromFunction(fn, 'length');
    const s = await scorer.score({}, { output: 'short' });
    expect(s.value).toBe(0.5);
    expect(s.detail).toBe('length check');
    expect(s.kind).toBe('length');
  });

  it('defaults kind to "custom" when omitted', async () => {
    const scorer = fromFunction(() => 1);
    const s = await scorer.score({}, { output: 'x' });
    expect(s.kind).toBe('custom');
  });

  it('throws when fn is not a function', () => {
    expect(() => fromFunction('not a function')).toThrow(/fn must be a function/);
    expect(() => fromFunction(null)).toThrow(/fn must be a function/);
    expect(() => fromFunction(42)).toThrow(/fn must be a function/);
  });

  it('throws when scorer returns invalid result', async () => {
    const scorer = fromFunction(() => 'bad');
    await expect(scorer.score({}, { output: '' })).rejects.toThrow(/invalid result/);
  });

  it('supports async scorer functions', async () => {
    const scorer = fromFunction(async (sample, result) => {
      await new Promise((r) => setTimeout(r, 1));
      return result.output === sample.expected ? 1 : 0;
    });
    const s = await scorer.score({ expected: 'ok' }, { output: 'ok' });
    expect(s.value).toBe(1);
  });

  it('receives context as third argument', async () => {
    let capturedContext = null;
    const scorer = fromFunction((sample, result, ctx) => {
      capturedContext = ctx;
      return 1;
    });
    await scorer.score({}, { output: '' }, { task: { name: 'test-task' } });
    expect(capturedContext).toEqual({ task: { name: 'test-task' } });
  });

  it('is composable with createScorer via composeScorers', async () => {
    const builtIn = createScorer({ kind: 'match', target: () => 'x' });
    const custom = fromFunction((sample, result) => result.output === 'x' ? 1 : 0);
    const composed = composeScorers([builtIn, custom], { reduce: 'mean' });

    const s = await composed.score({}, { output: 'x' });
    expect(s.value).toBe(1);
    expect(s.components).toHaveLength(2);
  });

  it('is reusable across multiple score calls with different inputs', async () => {
    const scorer = fromFunction((sample, result) => result.output === sample.expected ? 1 : 0);

    const results = [];
    for (const expected of ['a', 'b', 'c']) {
      results.push(await scorer.score({ expected }, { output: 'b' }));
    }
    expect(results.map((r) => r.value)).toEqual([0, 1, 0]);
  });
});

describe('scorer reuse (fromTraceScorer)', () => {
  it('maps eval triple to production trace shape', async () => {
    let capturedTrace = null;
    const fn = (traceRecord) => {
      capturedTrace = traceRecord;
      return traceRecord.output === traceRecord.expected ? 1 : 0;
    };
    const scorer = fromTraceScorer(fn, 'trace_match');

    const sample = { input: 'hello', expected: 'hello', metadata: { source: 'test' } };
    const result = { output: 'hello', trace: { steps: [1, 2] } };
    const context = { task: { name: 'my-task' } };

    const s = await scorer.score(sample, result, context);
    expect(s.value).toBe(1);
    expect(s.kind).toBe('trace_match');

    // Verify the trace record shape
    expect(capturedTrace.input).toBe('hello');
    expect(capturedTrace.output).toBe('hello');
    expect(capturedTrace.expected).toBe('hello');
    expect(capturedTrace.metadata.source).toBe('test');
    expect(capturedTrace.metadata.task_name).toBe('my-task');
    expect(capturedTrace.trace).toEqual({ steps: [1, 2] });
  });

  it('handles missing optional fields gracefully', async () => {
    const scorer = fromTraceScorer((tr) => tr.output === 'ok' ? 1 : 0);

    // sample without explicit input/expected/metadata
    const s = await scorer.score({ value: 'data' }, { output: 'ok' });
    expect(s.value).toBe(1);
    expect(s.kind).toBe('trace');
  });

  it('handles sample as raw input when no input field exists', async () => {
    let capturedTrace = null;
    const scorer = fromTraceScorer((tr) => {
      capturedTrace = tr;
      return 1;
    });
    await scorer.score('raw-string', { output: 'x' });
    expect(capturedTrace.input).toBe('raw-string');
    expect(capturedTrace.expected).toBeUndefined();
  });

  it('throws when fn is not a function', () => {
    expect(() => fromTraceScorer(null)).toThrow(/fn must be a function/);
    expect(() => fromTraceScorer(42)).toThrow(/fn must be a function/);
  });

  it('throws when trace scorer returns invalid result', async () => {
    const scorer = fromTraceScorer(() => 'invalid');
    await expect(scorer.score({}, { output: '' })).rejects.toThrow(/invalid result/);
  });

  it('preserves object return metadata', async () => {
    const scorer = fromTraceScorer((tr) => ({
      value: 0.75,
      reason: 'partial match',
      confidence: 0.9,
    }));
    const s = await scorer.score({}, { output: '' });
    expect(s.value).toBe(0.75);
    expect(s.reason).toBe('partial match');
    expect(s.confidence).toBe(0.9);
  });

  it('is composable with built-in scorers via composeScorers', async () => {
    const builtIn = createScorer({ kind: 'match', target: () => 'hello' });
    const trace = fromTraceScorer((tr) => tr.output === tr.expected ? 1 : 0);
    const composed = composeScorers([builtIn, trace], { reduce: 'min' });

    const s = await composed.score({ expected: 'hello' }, { output: 'hello' });
    expect(s.value).toBe(1);
    expect(s.components).toHaveLength(2);
  });
});

// ── Experiment Immutability ──

describe('experiment immutability', () => {
  const dataset = [
    { input: 'a', expected: 'a' },
    { input: 'b', expected: 'b' },
    { input: 'c', expected: 'x' },
  ];

  const solver = createSolver({ name: 'echo', run: (s) => ({ output: s.input }) });
  const scorer = createScorer({ kind: 'match', target: (s) => s.expected });

  it('returns a frozen top-level result object', async () => {
    const result = await runExperiment('immut-test', { dataset, solver, scorers: scorer });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('returns frozen rows array', async () => {
    const result = await runExperiment('immut-rows', { dataset, solver, scorers: scorer });
    expect(Object.isFrozen(result.rows)).toBe(true);
  });

  it('returns frozen individual row objects', async () => {
    const result = await runExperiment('immut-each-row', { dataset, solver, scorers: scorer });
    for (const row of result.rows) {
      expect(Object.isFrozen(row)).toBe(true);
    }
  });

  it('returns frozen aggregate', async () => {
    const result = await runExperiment('immut-agg', { dataset, solver, scorers: scorer });
    expect(Object.isFrozen(result.aggregate)).toBe(true);
  });

  it('returns frozen metadata', async () => {
    const result = await runExperiment('immut-meta', {
      dataset,
      solver,
      scorers: scorer,
      metadata: { source: 'test' },
    });
    expect(Object.isFrozen(result.metadata)).toBe(true);
  });

  it('mutation attempts do not modify the result', async () => {
    const result = await runExperiment('immut-no-write', { dataset, solver, scorers: scorer });

    expect(() => { result.name = 'hacked'; }).toThrow();
    expect(() => { result.rows.push({ fake: true }); }).toThrow();
    expect(() => { result.aggregate.mean_value = 999; }).toThrow();
    expect(result.name).toBe('immut-no-write');
  });

  it('assigns stable row IDs based on experiment ID and index', async () => {
    const result = await runExperiment('id-test', { dataset, solver, scorers: scorer });
    for (let i = 0; i < result.rows.length; i++) {
      expect(result.rows[i].id).toBe(`${result.id}:row:${i}`);
      expect(result.rows[i].index).toBe(i);
    }
  });
});

// ── Diff Behavior ──

describe('experiment diff behavior', () => {
  const dataset = [
    { input: 'a', expected: 'a' },
    { input: 'b', expected: 'b' },
  ];

  const echoSolver = createSolver({ name: 'echo', run: (s) => ({ output: s.input }) });
  const wrongSolver = createSolver({ name: 'wrong', run: () => ({ output: 'wrong' }) });
  const scorer = createScorer({ kind: 'match', target: (s) => s.expected });

  it('reports zero changes for identical experiments', async () => {
    const exp1 = await runExperiment('diff-same-1', { dataset, solver: echoSolver, scorers: scorer });
    const exp2 = await runExperiment('diff-same-2', { dataset, solver: echoSolver, scorers: scorer });

    const diff = diffExperiments(exp1, exp2);
    expect(diff.summary.changed).toBe(0);
    expect(diff.summary.unchanged).toBe(2);
    expect(diff.summary.added).toBe(0);
    expect(diff.summary.removed).toBe(0);
  });

  it('detects score changes when solver differs', async () => {
    const exp1 = await runExperiment('diff-change-1', { dataset, solver: echoSolver, scorers: scorer });
    const exp2 = await runExperiment('diff-change-2', { dataset, solver: wrongSolver, scorers: scorer });

    const diff = diffExperiments(exp1, exp2);
    expect(diff.summary.changed).toBe(2);
    expect(diff.summary.unchanged).toBe(0);
    for (const ch of diff.changed) {
      expect(ch.score_delta).toBe(-1); // from 1 to 0
    }
  });

  it('rejects diff across different datasets', () => {
    const exp1 = {
      id: 'a',
      dataset_identity: 'hash-a',
      rows: [],
      aggregate: {},
    };
    const exp2 = {
      id: 'b',
      dataset_identity: 'hash-b',
      rows: [],
      aggregate: {},
    };

    expect(() => diffExperiments(exp1, exp2)).toThrow(/cannot compare experiments on different datasets/);
  });

  it('reports added rows when new experiment has more rows', () => {
    const exp1 = {
      id: 'base',
      dataset_identity: 'same',
      rows: [{ index: 0, status: 'completed', score: { value: 1 } }],
      aggregate: { mean_value: 1 },
    };
    const exp2 = {
      id: 'new',
      dataset_identity: 'same',
      rows: [
        { index: 0, status: 'completed', score: { value: 1 } },
        { index: 1, status: 'completed', score: { value: 0.5 } },
      ],
      aggregate: { mean_value: 0.75 },
    };

    const diff = diffExperiments(exp1, exp2);
    expect(diff.summary.added).toBe(1);
    expect(diff.added[0].index).toBe(1);
  });

  it('reports removed rows when new experiment has fewer rows', () => {
    const exp1 = {
      id: 'base',
      dataset_identity: 'same',
      rows: [
        { index: 0, status: 'completed', score: { value: 1 } },
        { index: 1, status: 'completed', score: { value: 0.8 } },
      ],
      aggregate: { mean_value: 0.9 },
    };
    const exp2 = {
      id: 'new',
      dataset_identity: 'same',
      rows: [{ index: 0, status: 'completed', score: { value: 1 } }],
      aggregate: { mean_value: 1 },
    };

    const diff = diffExperiments(exp1, exp2);
    expect(diff.summary.removed).toBe(1);
    expect(diff.removed[0].index).toBe(1);
  });

  it('returns frozen diff result', async () => {
    const exp1 = await runExperiment('frozen-diff-1', { dataset, solver: echoSolver, scorers: scorer });
    const exp2 = await runExperiment('frozen-diff-2', { dataset, solver: echoSolver, scorers: scorer });
    const diff = diffExperiments(exp1, exp2);

    expect(Object.isFrozen(diff)).toBe(true);
    expect(Object.isFrozen(diff.summary)).toBe(true);
    expect(Object.isFrozen(diff.added)).toBe(true);
    expect(Object.isFrozen(diff.removed)).toBe(true);
    expect(Object.isFrozen(diff.changed)).toBe(true);
    expect(Object.isFrozen(diff.unchanged)).toBe(true);
  });

  it('computes mean_score_delta correctly', async () => {
    const exp1 = await runExperiment('mean-delta-1', { dataset, solver: echoSolver, scorers: scorer });
    const exp2 = await runExperiment('mean-delta-2', { dataset, solver: wrongSolver, scorers: scorer });
    const diff = diffExperiments(exp1, exp2);

    // exp1 mean = 1.0 (all match), exp2 mean = 0 (none match)
    expect(diff.summary.mean_score_delta).toBeCloseTo(-1.0);
  });

  it('reports status changes', () => {
    const exp1 = {
      id: 'base',
      dataset_identity: 'same',
      rows: [{ index: 0, status: 'completed', score: { value: 1 } }],
      aggregate: { mean_value: 1 },
    };
    const exp2 = {
      id: 'new',
      dataset_identity: 'same',
      rows: [{ index: 0, status: 'error', score: { value: 0 } }],
      aggregate: { mean_value: 0 },
    };
    const diff = diffExperiments(exp1, exp2);
    expect(diff.summary.changed).toBe(1);
    expect(diff.changed[0].status_changed).toBe(true);
  });

  it('throws when baseExperiment is missing', () => {
    expect(() => diffExperiments(null, { id: 'x' })).toThrow(/baseExperiment is required/);
  });

  it('throws when newExperiment is missing', () => {
    expect(() => diffExperiments({ id: 'x' }, null)).toThrow(/newExperiment is required/);
  });
});

// ── Score-Store Persistence (DB round-trip) ──

describe('experiment-results DB persistence', () => {
  let Database;
  let db;
  let experimentResultsDb;

  beforeEach(() => {
    Database = require('better-sqlite3');
    db = new Database(':memory:');
    delete require.cache[require.resolve('../db/experiment-results')];
    experimentResultsDb = require('../db/experiment-results');
    experimentResultsDb.init(db);
  });

  afterEach(() => {
    if (db && db.open) db.close();
    delete require.cache[require.resolve('../db/experiment-results')];
  });

  function makeSampleResult(overrides = {}) {
    return {
      id: overrides.id || `exp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: overrides.name || 'test-experiment',
      dataset_identity: overrides.dataset_identity || 'abc123',
      started_at: overrides.started_at || '2026-05-10T10:00:00Z',
      completed_at: overrides.completed_at || '2026-05-10T10:00:05Z',
      scorer_count: overrides.scorer_count !== undefined ? overrides.scorer_count : 1,
      aggregate: overrides.aggregate || {
        requested: 3,
        executed: 3,
        completed: 2,
        errored: 1,
        blocked: 0,
        mean_value: 0.667,
      },
      rows: overrides.rows || [
        { id: 'r:0', index: 0, input: { q: 'a' }, output: { a: 'a' }, status: 'completed', score: { value: 1 }, duration_ms: 10 },
        { id: 'r:1', index: 1, input: { q: 'b' }, output: { a: 'b' }, status: 'completed', score: { value: 1 }, duration_ms: 12 },
        { id: 'r:2', index: 2, input: { q: 'c' }, output: { a: 'x' }, status: 'error', score: { value: 0 }, duration_ms: 5 },
      ],
      metadata: overrides.metadata || { source: 'unit-test' },
    };
  }

  it('round-trips experiment result through DB with all fields intact', () => {
    const original = makeSampleResult({ id: 'roundtrip-1', name: 'full-roundtrip' });
    experimentResultsDb.storeExperimentResult(original);

    const retrieved = experimentResultsDb.getExperimentResult('roundtrip-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved.id).toBe('roundtrip-1');
    expect(retrieved.name).toBe('full-roundtrip');
    expect(retrieved.dataset_identity).toBe('abc123');
    expect(retrieved.scorer_count).toBe(1);
    expect(retrieved.started_at).toBe('2026-05-10T10:00:00Z');
    expect(retrieved.completed_at).toBe('2026-05-10T10:00:05Z');
    expect(retrieved.aggregate.requested).toBe(3);
    expect(retrieved.aggregate.mean_value).toBe(0.667);
    expect(retrieved.rows).toHaveLength(3);
    expect(retrieved.rows[0].score.value).toBe(1);
    expect(retrieved.rows[2].status).toBe('error');
    expect(retrieved.metadata.source).toBe('unit-test');
  });

  it('persists runExperiment output directly', async () => {
    const dataset = [{ input: 'x', expected: 'x' }, { input: 'y', expected: 'z' }];
    const solver = createSolver({ name: 'echo', run: (s) => ({ output: s.input }) });
    const scorer = createScorer({ kind: 'match', target: (s) => s.expected });

    const result = await runExperiment('persist-test', { dataset, solver, scorers: scorer });

    // Store the frozen result — should not throw
    experimentResultsDb.storeExperimentResult(result);

    const retrieved = experimentResultsDb.getExperimentResult(result.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved.name).toBe('persist-test');
    expect(retrieved.rows).toHaveLength(2);
    expect(retrieved.aggregate.executed).toBe(2);
  });

  it('handles null/missing aggregate and rows gracefully', () => {
    const minimal = { id: 'minimal-1', name: 'minimal' };
    experimentResultsDb.storeExperimentResult(minimal);

    const retrieved = experimentResultsDb.getExperimentResult('minimal-1');
    expect(retrieved.aggregate).toEqual({});
    expect(retrieved.rows).toEqual([]);
    expect(retrieved.metadata).toEqual({});
  });

  it('preserves scorer_count through DB', () => {
    const result = makeSampleResult({ id: 'sc-count', scorer_count: 3 });
    experimentResultsDb.storeExperimentResult(result);

    const retrieved = experimentResultsDb.getExperimentResult('sc-count');
    expect(retrieved.scorer_count).toBe(3);
  });

  it('defaults scorer_count to 1 when not provided', () => {
    const result = { id: 'sc-default', name: 'default-count' };
    experimentResultsDb.storeExperimentResult(result);

    const retrieved = experimentResultsDb.getExperimentResult('sc-default');
    expect(retrieved.scorer_count).toBe(1);
  });

  it('handles deeply nested row data through JSON serialization', () => {
    const complexRows = [{
      id: 'r:0',
      index: 0,
      input: { nested: { deep: { value: [1, 2, 3] } } },
      output: { response: { items: [{ id: 1, text: 'hello' }] } },
      status: 'completed',
      score: { value: 0.95, components: [{ value: 1, kind: 'match' }, { value: 0.9, kind: 'custom' }] },
      duration_ms: 42,
    }];

    const result = makeSampleResult({ id: 'nested-1', rows: complexRows });
    experimentResultsDb.storeExperimentResult(result);

    const retrieved = experimentResultsDb.getExperimentResult('nested-1');
    expect(retrieved.rows[0].input.nested.deep.value).toEqual([1, 2, 3]);
    expect(retrieved.rows[0].output.response.items[0].text).toBe('hello');
    expect(retrieved.rows[0].score.components).toHaveLength(2);
  });

  it('rejects storing result without id', () => {
    expect(() => experimentResultsDb.storeExperimentResult({ name: 'no-id' }))
      .toThrow(/result with id is required/);
    expect(() => experimentResultsDb.storeExperimentResult(null))
      .toThrow(/result with id is required/);
  });

  it('upserts on duplicate id without doubling count', () => {
    const result = makeSampleResult({ id: 'upsert-1', name: 'original' });
    experimentResultsDb.storeExperimentResult(result);
    expect(experimentResultsDb.countExperimentResults()).toBe(1);

    experimentResultsDb.storeExperimentResult({ ...result, name: 'updated' });
    expect(experimentResultsDb.countExperimentResults()).toBe(1);

    const retrieved = experimentResultsDb.getExperimentResult('upsert-1');
    expect(retrieved.name).toBe('updated');
  });

  it('lists in created_at DESC order', () => {
    experimentResultsDb.storeExperimentResult(makeSampleResult({ id: 'list-a', name: 'first' }));
    // Small delay to ensure different created_at
    experimentResultsDb.storeExperimentResult(makeSampleResult({ id: 'list-b', name: 'second' }));

    const list = experimentResultsDb.listExperimentResults();
    expect(list.length).toBeGreaterThanOrEqual(2);
    // Most recent first
    const names = list.map((r) => r.name);
    expect(names.indexOf('second')).toBeLessThan(names.indexOf('first'));
  });

  it('filters by name and dataset_identity simultaneously', () => {
    experimentResultsDb.storeExperimentResult(makeSampleResult({ id: 'f1', name: 'target', dataset_identity: 'ds-1' }));
    experimentResultsDb.storeExperimentResult(makeSampleResult({ id: 'f2', name: 'target', dataset_identity: 'ds-2' }));
    experimentResultsDb.storeExperimentResult(makeSampleResult({ id: 'f3', name: 'other', dataset_identity: 'ds-1' }));

    const filtered = experimentResultsDb.listExperimentResults({ name: 'target', dataset_identity: 'ds-1' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe('f1');
  });

  it('count returns 0 on empty table', () => {
    expect(experimentResultsDb.countExperimentResults()).toBe(0);
  });

  it('delete removes the correct entry', () => {
    experimentResultsDb.storeExperimentResult(makeSampleResult({ id: 'del-a' }));
    experimentResultsDb.storeExperimentResult(makeSampleResult({ id: 'del-b' }));
    expect(experimentResultsDb.countExperimentResults()).toBe(2);

    const deleted = experimentResultsDb.deleteExperimentResult('del-a');
    expect(deleted).toBe(true);
    expect(experimentResultsDb.countExperimentResults()).toBe(1);
    expect(experimentResultsDb.getExperimentResult('del-a')).toBeNull();
    expect(experimentResultsDb.getExperimentResult('del-b')).not.toBeNull();
  });

  it('delete returns false for nonexistent id', () => {
    expect(experimentResultsDb.deleteExperimentResult('ghost')).toBe(false);
  });

  it('get returns null for nonexistent id', () => {
    expect(experimentResultsDb.getExperimentResult('no-such-id')).toBeNull();
  });
});

// ── Invalid Input Errors (runExperiment) ──

describe('runExperiment input validation', () => {
  const solver = createSolver({ name: 'echo', run: (s) => ({ output: s.input }) });
  const scorer = createScorer({ kind: 'match', target: (s) => s.expected });

  it('rejects missing name', async () => {
    await expect(runExperiment('', { dataset: [{ input: 'a' }], solver, scorers: scorer }))
      .rejects.toThrow(/name is required/);
  });

  it('rejects null name', async () => {
    await expect(runExperiment(null, { dataset: [{ input: 'a' }], solver, scorers: scorer }))
      .rejects.toThrow(/name is required/);
  });

  it('rejects non-string name', async () => {
    await expect(runExperiment(42, { dataset: [{ input: 'a' }], solver, scorers: scorer }))
      .rejects.toThrow(/name is required/);
  });

  it('rejects missing dataset', async () => {
    await expect(runExperiment('test', { solver, scorers: scorer }))
      .rejects.toThrow(/dataset is required/);
  });

  it('rejects empty dataset', async () => {
    await expect(runExperiment('test', { dataset: [], solver, scorers: scorer }))
      .rejects.toThrow(/dataset is required/);
  });

  it('rejects non-array dataset', async () => {
    await expect(runExperiment('test', { dataset: 'not-array', solver, scorers: scorer }))
      .rejects.toThrow(/dataset is required/);
  });

  it('rejects missing solver', async () => {
    await expect(runExperiment('test', { dataset: [{ input: 'a' }], scorers: scorer }))
      .rejects.toThrow(/solver with run\(\) method is required/);
  });

  it('rejects solver without run method', async () => {
    await expect(runExperiment('test', { dataset: [{ input: 'a' }], solver: {}, scorers: scorer }))
      .rejects.toThrow(/solver with run\(\) method is required/);
  });

  it('rejects missing scorers', async () => {
    await expect(runExperiment('test', { dataset: [{ input: 'a' }], solver }))
      .rejects.toThrow(/at least one scorer is required/);
  });

  it('rejects empty scorers array', async () => {
    await expect(runExperiment('test', { dataset: [{ input: 'a' }], solver, scorers: [] }))
      .rejects.toThrow(/at least one scorer is required/);
  });
});

// ── Dataset Identity ──

describe('computeDatasetIdentity', () => {
  it('produces deterministic hash for same dataset', () => {
    const ds = [{ input: 'a' }, { input: 'b' }];
    const h1 = computeDatasetIdentity(ds);
    const h2 = computeDatasetIdentity(ds);
    expect(h1).toBe(h2);
    expect(typeof h1).toBe('string');
    expect(h1.length).toBe(16);
  });

  it('produces different hashes for different datasets', () => {
    const ds1 = [{ input: 'a' }];
    const ds2 = [{ input: 'b' }];
    expect(computeDatasetIdentity(ds1)).not.toBe(computeDatasetIdentity(ds2));
  });

  it('produces different hashes for different orderings', () => {
    const ds1 = [{ input: 'a' }, { input: 'b' }];
    const ds2 = [{ input: 'b' }, { input: 'a' }];
    expect(computeDatasetIdentity(ds1)).not.toBe(computeDatasetIdentity(ds2));
  });

  it('handles empty dataset', () => {
    const h = computeDatasetIdentity([]);
    expect(typeof h).toBe('string');
    expect(h.length).toBe(16);
  });
});

// ── Scorer reuse with runSample (integration) ──

describe('scorer reuse with runSample integration', () => {
  it('fromFunction scorer works through runSample', async () => {
    const scorer = fromFunction((sample, result) => result.output === sample.expected ? 1 : 0);
    const solver = createSolver({ name: 'echo', run: (s) => ({ output: s.input }) });
    const task = createTaskSpec({
      name: 'integration-test',
      dataset: [{ input: 'hello', expected: 'hello' }],
      solver,
      scorer,
    });

    const result = await runSample(task, { input: 'hello', expected: 'hello' });
    expect(result.status).toBe('completed');
    expect(result.score.value).toBe(1);
    expect(result.score.kind).toBe('custom');
  });

  it('fromTraceScorer works through runSample', async () => {
    const scorer = fromTraceScorer((tr) => tr.output === tr.expected ? 1 : 0);
    const solver = createSolver({ name: 'echo', run: (s) => ({ output: s.input }) });
    const task = createTaskSpec({
      name: 'trace-integration',
      dataset: [{ input: 'world', expected: 'world' }],
      solver,
      scorer,
    });

    const result = await runSample(task, { input: 'world', expected: 'world' });
    expect(result.status).toBe('completed');
    expect(result.score.value).toBe(1);
    expect(result.score.kind).toBe('trace');
  });

  it('fromFunction scorer works through full runExperiment', async () => {
    const scorer = fromFunction(
      (sample, result) => result.output === sample.expected ? 1 : 0,
      'custom_match'
    );
    const solver = createSolver({ name: 'echo', run: (s) => ({ output: s.input }) });
    const dataset = [
      { input: 'a', expected: 'a' },
      { input: 'b', expected: 'c' },
    ];

    const result = await runExperiment('custom-scorer-exp', { dataset, solver, scorers: scorer });
    expect(result.aggregate.completed).toBe(2);
    expect(result.aggregate.mean_value).toBeCloseTo(0.5);
    expect(result.rows[0].score.value).toBe(1);
    expect(result.rows[1].score.value).toBe(0);
  });

  it('multiple fromFunction scorers compose correctly in an experiment', async () => {
    const exactMatch = fromFunction((s, r) => r.output === s.expected ? 1 : 0, 'exact');
    const lengthMatch = fromFunction((s, r) => {
      const expected = s.expected || '';
      const output = r.output || '';
      return expected.length === output.length ? 1 : 0;
    }, 'length');

    const composed = composeScorers([exactMatch, lengthMatch]);
    const solver = createSolver({ name: 'echo', run: (s) => ({ output: s.input }) });
    const dataset = [
      { input: 'abc', expected: 'abc' },  // exact=1, length=1 => mean=1
      { input: 'ab', expected: 'xy' },    // exact=0, length=1 => mean=0.5
    ];

    const result = await runExperiment('multi-scorer', { dataset, solver, scorers: composed });
    expect(result.rows[0].score.value).toBe(1);
    expect(result.rows[1].score.value).toBeCloseTo(0.5);
  });
});

// ── runExperiment limit and metadata ──

describe('runExperiment options', () => {
  const solver = createSolver({ name: 'echo', run: (s) => ({ output: s.input }) });
  const scorer = createScorer({ kind: 'match', target: (s) => s.expected });

  it('respects limit option', async () => {
    const dataset = Array.from({ length: 10 }, (_, i) => ({ input: `v${i}`, expected: `v${i}` }));
    const result = await runExperiment('limit-test', { dataset, solver, scorers: scorer, limit: 3 });
    expect(result.rows).toHaveLength(3);
    expect(result.aggregate.requested).toBe(3);
    expect(result.aggregate.executed).toBe(3);
  });

  it('attaches metadata to result', async () => {
    const dataset = [{ input: 'a', expected: 'a' }];
    const result = await runExperiment('meta-test', {
      dataset,
      solver,
      scorers: scorer,
      metadata: { version: '1.0', author: 'test' },
    });
    expect(result.metadata.version).toBe('1.0');
    expect(result.metadata.author).toBe('test');
  });

  it('accepts single scorer (not array)', async () => {
    const dataset = [{ input: 'a', expected: 'a' }];
    const result = await runExperiment('single-scorer', { dataset, solver, scorers: scorer });
    expect(result.scorer_count).toBe(1);
    expect(result.aggregate.completed).toBe(1);
  });

  it('accepts array of scorers and counts correctly', async () => {
    const dataset = [{ input: 'a', expected: 'a' }];
    const s1 = createScorer({ kind: 'match', target: (s) => s.expected });
    const s2 = fromFunction((s, r) => r.output === s.expected ? 1 : 0);
    const result = await runExperiment('multi-scorer-count', { dataset, solver, scorers: [s1, s2] });
    expect(result.scorer_count).toBe(2);
  });
});

// ── createScorer edge cases ──

describe('createScorer edge cases', () => {
  it('match scorer with static target value', async () => {
    const scorer = createScorer({ kind: 'match', target: 'fixed' });
    const s = await scorer.score({}, { output: 'fixed' });
    expect(s.value).toBe(1);
    expect(s.target).toBe('fixed');
  });

  it('match scorer with async target function', async () => {
    const scorer = createScorer({
      kind: 'match',
      target: async (sample) => {
        await new Promise((r) => setTimeout(r, 1));
        return sample.expected;
      },
    });
    const s = await scorer.score({ expected: 'async-val' }, { output: 'async-val' });
    expect(s.value).toBe(1);
  });

  it('model_graded scorer delegates to grade function', async () => {
    const scorer = createScorer({
      kind: 'model_graded',
      grade: async (sample, result) => ({
        value: result.output.includes('good') ? 1 : 0,
        reason: 'checked for good',
      }),
    });
    const s = await scorer.score({}, { output: 'this is good' });
    expect(s.value).toBe(1);
    expect(s.reason).toBe('checked for good');
    expect(s.kind).toBe('model_graded');
  });

  it('model_graded throws without grade function', async () => {
    const scorer = createScorer({ kind: 'model_graded' });
    await expect(scorer.score({}, { output: '' })).rejects.toThrow(/grade\(sample,result\)/);
  });

  it('unknown kind throws', async () => {
    const scorer = createScorer({ kind: 'invalid_kind', target: 'x' });
    await expect(scorer.score({}, { output: '' })).rejects.toThrow(/unknown scorer kind/);
  });
});

// ── composeScorers edge cases ──

describe('composeScorers edge cases', () => {
  it('reduce=max returns best score', async () => {
    const high = fromFunction(() => 0.9);
    const low = fromFunction(() => 0.1);
    const composed = composeScorers([high, low], { reduce: 'max' });
    const s = await composed.score({}, { output: '' });
    expect(s.value).toBe(0.9);
  });

  it('reduce=min returns worst score', async () => {
    const high = fromFunction(() => 0.9);
    const low = fromFunction(() => 0.1);
    const composed = composeScorers([high, low], { reduce: 'min' });
    const s = await composed.score({}, { output: '' });
    expect(s.value).toBe(0.1);
  });

  it('unknown reduce throws', async () => {
    const s = fromFunction(() => 1);
    const composed = composeScorers([s], { reduce: 'median' });
    await expect(composed.score({}, { output: '' })).rejects.toThrow(/unknown reduce/);
  });

  it('single scorer compose returns its value directly', async () => {
    const s = fromFunction(() => 0.42);
    const composed = composeScorers([s]);
    const result = await composed.score({}, { output: '' });
    expect(result.value).toBeCloseTo(0.42);
    expect(result.components).toHaveLength(1);
  });
});
