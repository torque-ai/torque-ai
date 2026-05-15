'use strict';

/**
 * Tests for Experiment handlers:
 * - A/B Provider Comparison Tool (Experiment 6)
 * - Experiment SDK handlers (run_experiment, get_experiment_result, diff_experiments, list_experiment_results)
 * - DB persistence integration (experiment-results store)
 */

const { TEST_MODELS } = require('./test-helpers');
const taskCore = require('../db/task-core');

// rawDb mock with transaction support (returns a function that calls the callback)
const mockRawDb = {
  open: true,
  transaction: vi.fn((fn) => fn),
};

const mockDb = {
  getDbInstance: vi.fn(() => mockRawDb),
};

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
  };
}

function loadHandlers() {
  delete require.cache[require.resolve('../handlers/experiment-handlers')];
  installMock('../container', {
    defaultContainer: {
      peek: (name) => (name === 'db' ? mockDb : null),
      has: (name) => name === 'db',
      get: (name) => (name === 'db' ? mockDb : null),
    },
  });
  installMock('../handlers/error-codes', require('../handlers/error-codes'));
  return require('../handlers/experiment-handlers');
}

describe('experiment-handlers (Experiment 6)', () => {
  let handlers;

  beforeEach(() => {
    mockDb.getDbInstance.mockReset();
    mockDb.getDbInstance.mockReturnValue(mockRawDb);
    mockRawDb.transaction.mockReset();
    // transaction() receives a callback and returns a function; calling that function runs the callback
    mockRawDb.transaction.mockImplementation((fn) => fn);
    vi.restoreAllMocks();
    vi.spyOn(taskCore, 'createTask').mockImplementation(() => undefined);
    vi.spyOn(taskCore, 'getTask').mockReturnValue(null);
    handlers = loadHandlers();
  });

  afterEach(() => {
    delete require.cache[require.resolve('../handlers/experiment-handlers')];
    delete require.cache[require.resolve('../container')];
  });

  describe('handleSubmitAbTest', () => {
    it('returns error when task_description is missing', () => {
      const result = handlers.handleSubmitAbTest({});
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('returns error when provider_a is missing', () => {
      const result = handlers.handleSubmitAbTest({
        task_description: 'Fix the bug',
        provider_b: 'ollama',
        working_directory: '/tmp',
      });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('returns error when provider_b is missing', () => {
      const result = handlers.handleSubmitAbTest({
        task_description: 'Fix the bug',
        provider_a: 'codex',
        working_directory: '/tmp',
      });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('returns error when providers are the same', () => {
      const result = handlers.handleSubmitAbTest({
        task_description: 'Fix the bug',
        provider_a: 'codex',
        provider_b: 'codex',
        working_directory: '/tmp',
      });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
    });

    it('returns error when working_directory is missing', () => {
      const result = handlers.handleSubmitAbTest({
        task_description: 'Fix the bug',
        provider_a: 'codex',
        provider_b: 'ollama',
      });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('creates two tasks with different providers', () => {
      const result = handlers.handleSubmitAbTest({
        task_description: 'Write unit tests for auth module',
        provider_a: 'codex',
        provider_b: 'ollama',
        working_directory: '/tmp/project',
      });

      expect(result.isError).toBeFalsy();
      expect(taskCore.createTask).toHaveBeenCalledTimes(2);

      const callA = taskCore.createTask.mock.calls[0][0];
      const callB = taskCore.createTask.mock.calls[1][0];

      expect(callA.provider).toBe('codex');
      expect(callB.provider).toBe('ollama');
      expect(callA.task_description).toBe(callB.task_description);
      expect(callA.working_directory).toBe('/tmp/project');
      expect(callB.working_directory).toBe('/tmp/project');
      expect(callA.status).toBe('queued');
      expect(callB.status).toBe('queued');

      const metaA = JSON.parse(callA.metadata);
      const metaB = JSON.parse(callB.metadata);
      expect(metaA.ab_test_id).toBe(metaB.ab_test_id);
      expect(metaA.ab_variant).toBe('A');
      expect(metaB.ab_variant).toBe('B');
      expect(metaA.ab_peer_task_id).toBe(callB.id);
      expect(metaB.ab_peer_task_id).toBe(callA.id);
    });

    it('includes model overrides when provided', () => {
      handlers.handleSubmitAbTest({
        task_description: 'Test task',
        provider_a: 'codex',
        provider_b: 'ollama',
        working_directory: '/tmp',
        model_a: 'gpt-5.3-codex-spark',
        model_b: TEST_MODELS.DEFAULT,
      });

      const callA = taskCore.createTask.mock.calls[0][0];
      const callB = taskCore.createTask.mock.calls[1][0];
      expect(callA.model).toBe('gpt-5.3-codex-spark');
      expect(callB.model).toBe(TEST_MODELS.DEFAULT);
    });

    it('returns formatted response with task IDs', () => {
      const result = handlers.handleSubmitAbTest({
        task_description: 'Test task',
        provider_a: 'codex',
        provider_b: 'ollama',
        working_directory: '/tmp',
      });

      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('A/B Provider Test Created');
      expect(result.content[0].text).toContain('codex');
      expect(result.content[0].text).toContain('ollama');
    });

    it('handles db.createTask failure gracefully', () => {
      taskCore.createTask.mockImplementation(() => { throw new Error('DB write failed'); });

      const result = handlers.handleSubmitAbTest({
        task_description: 'Test task',
        provider_a: 'codex',
        provider_b: 'ollama',
        working_directory: '/tmp',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INTERNAL_ERROR');
    });
  });

  describe('handleCompareAbTest', () => {
    it('returns error when task_id_a is missing', () => {
      const result = handlers.handleCompareAbTest({});
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('returns error when task A not found', () => {
      taskCore.getTask.mockReturnValue(null);
      const result = handlers.handleCompareAbTest({
        task_id_a: 'a-123',
        task_id_b: 'b-456',
      });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
    });

    it('compares two completed tasks', () => {
      const abTestId = 'test-ab-123';
      taskCore.getTask
        .mockReturnValueOnce({
          id: 'a-123',
          provider: 'codex',
          status: 'completed',
          exit_code: 0,
          output: 'Codex output here',
          started_at: '2026-03-08T10:00:00Z',
          completed_at: '2026-03-08T10:00:30Z',
          metadata: JSON.stringify({ ab_test_id: abTestId, ab_variant: 'A' }),
        })
        .mockReturnValueOnce({
          id: 'b-456',
          provider: 'ollama',
          status: 'completed',
          exit_code: 0,
          output: 'Ollama output that is longer than codex',
          started_at: '2026-03-08T10:00:00Z',
          completed_at: '2026-03-08T10:01:00Z',
          metadata: JSON.stringify({ ab_test_id: abTestId, ab_variant: 'B' }),
        });

      const result = handlers.handleCompareAbTest({
        task_id_a: 'a-123',
        task_id_b: 'b-456',
      });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('A/B Test Comparison');
      expect(result.content[0].text).toContain('codex');
      expect(result.content[0].text).toContain('ollama');
      expect(result.content[0].text).toContain('30s');
      expect(result.content[0].text).toContain('60s');
      // Codex was faster, so A should win duration
      expect(result.content[0].text).toContain('codex (A) wins');
    });

    it('handles one failed and one completed task', () => {
      taskCore.getTask
        .mockReturnValueOnce({
          id: 'a-123',
          provider: 'ollama',
          status: 'failed',
          exit_code: 1,
          output: '',
          metadata: '{}',
        })
        .mockReturnValueOnce({
          id: 'b-456',
          provider: 'codex',
          status: 'completed',
          exit_code: 0,
          output: 'Success',
          metadata: '{}',
        });

      const result = handlers.handleCompareAbTest({
        task_id_a: 'a-123',
        task_id_b: 'b-456',
      });

      expect(result.content[0].text).toContain('codex (B) wins');
    });
  });
});

// ── Experiment SDK handler tests ──

describe('experiment-handlers SDK', () => {
  let handlers;

  beforeEach(() => {
    mockDb.getDbInstance.mockReset();
    mockDb.getDbInstance.mockReturnValue(mockRawDb);
    mockRawDb.transaction.mockReset();
    mockRawDb.transaction.mockImplementation((fn) => fn);
    vi.restoreAllMocks();
    vi.spyOn(taskCore, 'createTask').mockImplementation(() => undefined);
    vi.spyOn(taskCore, 'getTask').mockReturnValue(null);
    handlers = loadHandlers();
    // Clear stored experiments between tests
    handlers.clearExperimentResults();
  });

  afterEach(() => {
    delete require.cache[require.resolve('../handlers/experiment-handlers')];
    delete require.cache[require.resolve('../container')];
  });

  describe('handleRunExperiment', () => {
    it('returns error when name is missing', async () => {
      const result = await handlers.handleRunExperiment({});
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('returns error when name is empty string', async () => {
      const result = await handlers.handleRunExperiment({ name: '  ', dataset: [{ input: 'a' }] });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('returns error when dataset is missing', async () => {
      const result = await handlers.handleRunExperiment({ name: 'test-exp' });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('returns error when dataset is empty', async () => {
      const result = await handlers.handleRunExperiment({ name: 'test-exp', dataset: [] });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('returns error when dataset exceeds 1000 samples', async () => {
      const bigDataset = Array.from({ length: 1001 }, (_, i) => ({ input: `item-${i}` }));
      const result = await handlers.handleRunExperiment({ name: 'too-big', dataset: bigDataset });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
    });

    it('returns error for invalid scorer_kind', async () => {
      const result = await handlers.handleRunExperiment({
        name: 'bad-scorer',
        dataset: [{ input: 'a', expected: 'a' }],
        scorer_kind: 'invalid',
      });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
    });

    it('runs a match experiment with passthrough solver', async () => {
      const result = await handlers.handleRunExperiment({
        name: 'match-test',
        dataset: [
          { input: 'hello', expected: 'hello' },
          { input: 'world', expected: 'world' },
          { input: 'foo', expected: 'bar' },
        ],
      });

      expect(result.isError).toBeFalsy();
      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe('text');
      const text = result.content[0].text;
      expect(text).toContain('Experiment Completed');
      expect(text).toContain('match-test');
      // 2 out of 3 match (hello=hello, world=world, foo!=bar)
      expect(text).toContain('3 / 3 samples');
    });

    it('stores result and returns experiment ID', async () => {
      const result = await handlers.handleRunExperiment({
        name: 'stored-exp',
        dataset: [{ input: 'a', expected: 'a' }],
      });

      expect(result.isError).toBeFalsy();
      const text = result.content[0].text;
      // Extract ID from the response
      const idMatch = text.match(/\*\*ID:\*\*\s*`([^`]+)`/);
      expect(idMatch).toBeTruthy();

      // Verify it's retrievable
      const getResult = handlers.handleGetExperimentResult({ experiment_id: idMatch[1] });
      expect(getResult.isError).toBeFalsy();
      expect(getResult.content[0].text).toContain('stored-exp');
    });

    it('respects limit parameter', async () => {
      const result = await handlers.handleRunExperiment({
        name: 'limited-exp',
        dataset: [
          { input: 'a', expected: 'a' },
          { input: 'b', expected: 'b' },
          { input: 'c', expected: 'c' },
          { input: 'd', expected: 'd' },
        ],
        limit: 2,
      });

      expect(result.isError).toBeFalsy();
      const text = result.content[0].text;
      expect(text).toContain('2 / 2 samples');
    });

    it('uses choice scorer when scorer_kind is choice', async () => {
      const result = await handlers.handleRunExperiment({
        name: 'choice-exp',
        dataset: [{ input: 'yes', expected: 'yes' }],
        scorer_kind: 'choice',
      });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Experiment Completed');
    });

    it('uses custom input_field and target_field', async () => {
      const result = await handlers.handleRunExperiment({
        name: 'custom-fields',
        dataset: [
          { question: 'what', answer: 'what' },
          { question: 'why', answer: 'why' },
        ],
        input_field: 'question',
        target_field: 'answer',
      });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('2 / 2 samples');
    });
  });

  describe('handleGetExperimentResult', () => {
    it('returns error when experiment_id is missing', () => {
      const result = handlers.handleGetExperimentResult({});
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('returns error when experiment not found', () => {
      const result = handlers.handleGetExperimentResult({ experiment_id: 'nonexistent' });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('EXPERIMENT_NOT_FOUND');
    });

    it('returns detailed result for stored experiment', async () => {
      // First run an experiment to populate the store
      const runResult = await handlers.handleRunExperiment({
        name: 'detail-test',
        dataset: [
          { input: 'a', expected: 'a' },
          { input: 'b', expected: 'x' },
        ],
      });

      const idMatch = runResult.content[0].text.match(/\*\*ID:\*\*\s*`([^`]+)`/);
      const result = handlers.handleGetExperimentResult({ experiment_id: idMatch[1] });

      expect(result.isError).toBeFalsy();
      const text = result.content[0].text;
      expect(text).toContain('detail-test');
      expect(text).toContain('Aggregate');
      expect(text).toContain('Row Results');
      expect(text).toContain('Executed: 2 / 2');
    });
  });

  describe('handleDiffExperiments', () => {
    it('returns error when base_experiment_id is missing', () => {
      const result = handlers.handleDiffExperiments({});
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('returns error when new_experiment_id is missing', () => {
      const result = handlers.handleDiffExperiments({ base_experiment_id: 'abc' });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('returns error when base experiment not found', () => {
      const result = handlers.handleDiffExperiments({
        base_experiment_id: 'missing-base',
        new_experiment_id: 'missing-new',
      });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('EXPERIMENT_NOT_FOUND');
    });

    it('diffs two experiments on the same dataset', async () => {
      const dataset = [
        { input: 'a', expected: 'a' },
        { input: 'b', expected: 'b' },
      ];

      const run1 = await handlers.handleRunExperiment({ name: 'base-exp', dataset });
      const run2 = await handlers.handleRunExperiment({ name: 'new-exp', dataset });

      const baseId = run1.content[0].text.match(/\*\*ID:\*\*\s*`([^`]+)`/)[1];
      const newId = run2.content[0].text.match(/\*\*ID:\*\*\s*`([^`]+)`/)[1];

      const result = handlers.handleDiffExperiments({
        base_experiment_id: baseId,
        new_experiment_id: newId,
      });

      expect(result.isError).toBeFalsy();
      const text = result.content[0].text;
      expect(text).toContain('Experiment Diff');
      expect(text).toContain('Total rows: 2');
      // Same dataset and same solver, so unchanged should be 2
      expect(text).toContain('Unchanged: 2');
      expect(text).toContain('Changed: 0');
    });

    it('rejects diff across different datasets', async () => {
      const run1 = await handlers.handleRunExperiment({
        name: 'dataset-a',
        dataset: [{ input: 'a', expected: 'a' }],
      });
      const run2 = await handlers.handleRunExperiment({
        name: 'dataset-b',
        dataset: [{ input: 'different', expected: 'different' }],
      });

      const baseId = run1.content[0].text.match(/\*\*ID:\*\*\s*`([^`]+)`/)[1];
      const newId = run2.content[0].text.match(/\*\*ID:\*\*\s*`([^`]+)`/)[1];

      const result = handlers.handleDiffExperiments({
        base_experiment_id: baseId,
        new_experiment_id: newId,
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
    });
  });

  describe('handleListExperimentResults', () => {
    it('returns empty message when no experiments stored', () => {
      const result = handlers.handleListExperimentResults({});
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('No experiment results stored');
    });

    it('lists stored experiments with summary info', async () => {
      await handlers.handleRunExperiment({
        name: 'exp-one',
        dataset: [{ input: 'a', expected: 'a' }],
      });
      await handlers.handleRunExperiment({
        name: 'exp-two',
        dataset: [{ input: 'b', expected: 'b' }],
      });

      const result = handlers.handleListExperimentResults({});
      expect(result.isError).toBeFalsy();
      const text = result.content[0].text;
      expect(text).toContain('Experiment Results (2)');
      expect(text).toContain('exp-one');
      expect(text).toContain('exp-two');
    });
  });

  describe('clearExperimentResults', () => {
    it('clears all stored experiment results', async () => {
      await handlers.handleRunExperiment({
        name: 'to-clear',
        dataset: [{ input: 'a', expected: 'a' }],
      });

      let list = handlers.handleListExperimentResults({});
      expect(list.content[0].text).toContain('Experiment Results (1)');

      handlers.clearExperimentResults();

      list = handlers.handleListExperimentResults({});
      expect(list.content[0].text).toContain('No experiment results stored');
    });
  });
});

// ── experiment-results DB store unit tests ──

describe('experiment-results DB store', () => {
  let Database;
  let db;
  let experimentResultsDb;

  beforeEach(() => {
    // Use better-sqlite3 in-memory DB for real SQL testing
    Database = require('better-sqlite3');
    db = new Database(':memory:');

    // Fresh-require the module to reset internal state
    delete require.cache[require.resolve('../db/experiment-results')];
    experimentResultsDb = require('../db/experiment-results');
    experimentResultsDb.init(db);
  });

  afterEach(() => {
    if (db && db.open) db.close();
    delete require.cache[require.resolve('../db/experiment-results')];
  });

  const sampleResult = () => ({
    id: `exp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: 'test-experiment',
    dataset_identity: 'abc123',
    started_at: '2026-05-10T10:00:00Z',
    completed_at: '2026-05-10T10:00:05Z',
    scorer_count: 1,
    aggregate: { executed: 3, requested: 3, completed: 2, errored: 1, blocked: 0, mean_value: 0.667 },
    rows: [
      { id: 'r:0', index: 0, input: { q: 'a' }, output: { a: 'a' }, status: 'completed', score: { value: 1 }, duration_ms: 10 },
      { id: 'r:1', index: 1, input: { q: 'b' }, output: { a: 'b' }, status: 'completed', score: { value: 1 }, duration_ms: 12 },
      { id: 'r:2', index: 2, input: { q: 'c' }, output: { a: 'x' }, status: 'error', score: { value: 0 }, duration_ms: 5 },
    ],
    metadata: { source: 'unit-test' },
  });

  it('stores and retrieves an experiment result', () => {
    const result = sampleResult();
    experimentResultsDb.storeExperimentResult(result);

    const retrieved = experimentResultsDb.getExperimentResult(result.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved.id).toBe(result.id);
    expect(retrieved.name).toBe('test-experiment');
    expect(retrieved.dataset_identity).toBe('abc123');
    expect(retrieved.scorer_count).toBe(1);
    expect(retrieved.aggregate.executed).toBe(3);
    expect(retrieved.aggregate.mean_value).toBe(0.667);
    expect(retrieved.rows).toHaveLength(3);
    expect(retrieved.rows[0].id).toBe('r:0');
    expect(retrieved.metadata.source).toBe('unit-test');
  });

  it('returns null for missing experiment', () => {
    const result = experimentResultsDb.getExperimentResult('nonexistent');
    expect(result).toBeNull();
  });

  it('lists stored experiments', () => {
    const r1 = sampleResult();
    const r2 = { ...sampleResult(), id: 'exp-second', name: 'second-experiment' };
    experimentResultsDb.storeExperimentResult(r1);
    experimentResultsDb.storeExperimentResult(r2);

    const list = experimentResultsDb.listExperimentResults();
    expect(list).toHaveLength(2);
    const names = list.map((r) => r.name);
    expect(names).toContain('test-experiment');
    expect(names).toContain('second-experiment');
  });

  it('filters by name', () => {
    const r1 = sampleResult();
    const r2 = { ...sampleResult(), id: 'exp-other', name: 'other-experiment' };
    experimentResultsDb.storeExperimentResult(r1);
    experimentResultsDb.storeExperimentResult(r2);

    const filtered = experimentResultsDb.listExperimentResults({ name: 'other-experiment' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe('other-experiment');
  });

  it('filters by dataset_identity', () => {
    const r1 = sampleResult();
    const r2 = { ...sampleResult(), id: 'exp-diff-ds', dataset_identity: 'xyz789' };
    experimentResultsDb.storeExperimentResult(r1);
    experimentResultsDb.storeExperimentResult(r2);

    const filtered = experimentResultsDb.listExperimentResults({ dataset_identity: 'xyz789' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].dataset_identity).toBe('xyz789');
  });

  it('deletes an experiment result', () => {
    const result = sampleResult();
    experimentResultsDb.storeExperimentResult(result);
    expect(experimentResultsDb.getExperimentResult(result.id)).not.toBeNull();

    const deleted = experimentResultsDb.deleteExperimentResult(result.id);
    expect(deleted).toBe(true);
    expect(experimentResultsDb.getExperimentResult(result.id)).toBeNull();
  });

  it('delete returns false for missing experiment', () => {
    const deleted = experimentResultsDb.deleteExperimentResult('nonexistent');
    expect(deleted).toBe(false);
  });

  it('counts stored experiments', () => {
    expect(experimentResultsDb.countExperimentResults()).toBe(0);
    experimentResultsDb.storeExperimentResult(sampleResult());
    expect(experimentResultsDb.countExperimentResults()).toBe(1);
    experimentResultsDb.storeExperimentResult({ ...sampleResult(), id: 'exp-2' });
    expect(experimentResultsDb.countExperimentResults()).toBe(2);
  });

  it('upserts on duplicate id', () => {
    const result = sampleResult();
    experimentResultsDb.storeExperimentResult(result);

    const updated = { ...result, name: 'updated-name' };
    experimentResultsDb.storeExperimentResult(updated);

    const retrieved = experimentResultsDb.getExperimentResult(result.id);
    expect(retrieved.name).toBe('updated-name');
    expect(experimentResultsDb.countExperimentResults()).toBe(1);
  });

  it('rejects result without id', () => {
    expect(() => experimentResultsDb.storeExperimentResult({ name: 'no-id' }))
      .toThrow(/result with id is required/);
  });

  it('respects limit in listing', () => {
    for (let i = 0; i < 5; i++) {
      experimentResultsDb.storeExperimentResult({ ...sampleResult(), id: `exp-${i}` });
    }
    const limited = experimentResultsDb.listExperimentResults({ limit: 2 });
    expect(limited).toHaveLength(2);
  });
});
