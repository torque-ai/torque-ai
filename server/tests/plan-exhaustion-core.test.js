const Database = require('better-sqlite3');

describe('plan exhaustion primitives', () => {
  it('classifies common failure families deterministically', () => {
    const { classifyFailure } = require('../validation/failure-classifier');
    expect(classifyFailure({ error_output: '429 insufficient quota' }).class).toBe('budget_exhausted');
    expect(classifyFailure({ error_output: 'SyntaxError: bad token' }).class).toBe('structural');
    expect(classifyFailure({ error_output: 'AssertionError: expected true' }).class).toBe('deterministic');
  });

  it('evaluates merge policies', () => {
    const { evaluateMergeJoin } = require('../execution/parallel-merge');
    expect(evaluateMergeJoin('wait_all', [
      { task_id: 'a', status: 'completed' },
      { task_id: 'b', status: 'running' },
    ])).toMatchObject({ unblock: false, reason: 'waiting_for_all' });
    expect(evaluateMergeJoin('first_success', [
      { task_id: 'a', status: 'failed' },
      { task_id: 'b', status: 'completed' },
    ])).toMatchObject({ unblock: true, reason: 'first_success' });
  });

  it('loads and selects scoped project rules', () => {
    const { globToRegex, selectRules } = require('../rules/rule-selector');
    expect(globToRegex('server/**/*.js').test('server/a/b.js')).toBe(true);
    expect(selectRules([
      { id: 'server', applies_to: ['server/**/*.js'], enabled: true },
      { id: 'docs', applies_to: ['docs/**/*.md'], enabled: true },
    ], { files: ['server/a/index.js'] }).map((rule) => rule.id)).toEqual(['server']);
  });

  it('records and finds related task experiences', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE task_experiences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT,
        task_description TEXT NOT NULL,
        task_description_embedding TEXT NOT NULL,
        output_summary TEXT,
        files_modified TEXT,
        provider TEXT,
        success_score REAL DEFAULT 1.0,
        recorded_at TEXT NOT NULL
      )
    `);
    const store = require('../experience/store');
    store.recordExperience({
      project: 'torque',
      task_description: 'fix provider routing fallback',
      output_summary: 'Updated routing fallback logic.',
      provider: 'codex',
    }, db);
    const related = store.findRelatedExperiences({
      project: 'torque',
      task_description: 'provider fallback routing bug',
      limit: 1,
      min_similarity: 0.1,
    }, db);
    expect(related).toHaveLength(1);
    expect(related[0].provider).toBe('codex');
    db.close();
  });

  it('scores native evaluator checks and diffs experiments', () => {
    const { scoreOutput, diffExperimentRuns } = require('../eval/native-evaluator');
    expect(scoreOutput('hello codex world', [
      { type: 'contains_all', expected: ['codex', 'world'] },
      { type: 'length_gte', min: 5 },
    ])).toMatchObject({ passed: true, score: 1 });
    expect(diffExperimentRuns([{ score: 0.5 }], [{ score: 0.75 }])).toMatchObject({
      winner: 'candidate',
      delta: 0.25,
    });
  });

  it('projects unified workstations into legacy row shapes', () => {
    const projection = require('../db/legacy-workstation-projection');
    const ws = {
      id: 'ws-1',
      name: 'runner',
      host: '127.0.0.1',
      agent_port: 3460,
      ollama_port: 11434,
      enabled: 1,
      status: 'healthy',
      models_cache: '["llama"]',
    };
    expect(projection.workstationToOllamaHost(ws)).toMatchObject({ url: 'http://127.0.0.1:11434', models: ['llama'] });
    expect(projection.workstationToRemoteAgent(ws)).toMatchObject({ port: 3460, status: 'healthy' });
  });
});
