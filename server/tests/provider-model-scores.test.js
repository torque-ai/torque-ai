'use strict';

const Database = require('better-sqlite3');
const providerModelScores = require('../db/provider-model-scores');

describe('provider-model-scores live outcomes', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    providerModelScores.init(db);
  });

  afterEach(() => {
    db.close();
    db = null;
  });

  it('rewards successful OpenRouter task outcomes with tool evidence', () => {
    providerModelScores.upsertModelScore({
      provider: 'openrouter',
      model_name: 'example/free:free',
      score: 70,
      smoke_status: 'metadata_pass',
      tool_call_ok: 1,
      metadata: { source: 'scout' },
    });

    const row = providerModelScores.recordModelTaskOutcome({
      provider: 'openrouter',
      modelName: 'example/free:free',
      success: true,
      stopReason: 'model_finished',
      readOnly: true,
      toolLog: [{ name: 'read_file', error: false }],
      durationMs: 1234,
    });

    expect(row.score).toBeGreaterThan(70);
    expect(row.smoke_status).toBe('pass');
    expect(row.tool_call_ok).toBe(1);
    expect(row.read_only_ok).toBe(1);
    expect(row.rate_limited).toBe(0);

    const stored = providerModelScores.getModelScore('openrouter', 'example/free:free');
    expect(stored.score).toBe(row.score);
    expect(JSON.parse(stored.metadata_json)).toMatchObject({
      source: 'scout',
      last_task_outcome: {
        success: true,
        stop_reason: 'model_finished',
        tool_count: 1,
        read_only: true,
      },
    });
  });

  it('penalizes missing tool evidence on read-only OpenRouter tasks', () => {
    providerModelScores.upsertModelScore({
      provider: 'openrouter',
      model_name: 'no-tools/free:free',
      score: 82,
      smoke_status: 'pass',
      tool_call_ok: 1,
      read_only_ok: 1,
    });

    const row = providerModelScores.recordModelTaskOutcome({
      provider: 'openrouter',
      modelName: 'no-tools/free:free',
      success: false,
      stopReason: 'missing_tool_evidence',
      readOnly: true,
      toolLog: [],
    });

    expect(row.score).toBe(62);
    expect(row.smoke_status).toBe('fail');
    expect(row.tool_call_ok).toBe(0);
    expect(row.read_only_ok).toBe(0);
  });

  it('marks OpenRouter 429 outcomes as rate limited and heavily lowers score', () => {
    providerModelScores.upsertModelScore({
      provider: 'openrouter',
      model_name: 'busy/free:free',
      score: 76,
      smoke_status: 'metadata_pass',
    });

    const row = providerModelScores.recordModelTaskOutcome({
      provider: 'openrouter',
      modelName: 'busy/free:free',
      success: false,
      error: 'API error (429): rate limit exceeded',
    });

    expect(row.score).toBe(41);
    expect(row.smoke_status).toBe('rate_limited');
    expect(row.rate_limited).toBe(1);
  });

  it('infers no-tool read-only completions as missing tool evidence failures', () => {
    providerModelScores.upsertModelScore({
      provider: 'openrouter',
      model_name: 'silent/free:free',
      score: 94,
      smoke_status: 'metadata_pass',
      read_only_ok: 1,
    });

    const row = providerModelScores.recordModelTaskOutcome({
      provider: 'openrouter',
      modelName: 'silent/free:free',
      success: true,
      readOnly: true,
      toolLog: [],
      output: 'Task stopped: model answered without using required repository tools.',
    });

    expect(row.score).toBe(74);
    expect(row.smoke_status).toBe('fail');
    expect(row.read_only_ok).toBe(0);
    expect(JSON.parse(row.metadata_json).last_task_outcome).toMatchObject({
      success: false,
      stop_reason: 'missing_tool_evidence',
      tool_count: 0,
      delta: -20,
    });
  });

  it('preserves live task penalties when metadata scout rows refresh', () => {
    providerModelScores.upsertModelScore({
      provider: 'openrouter',
      model_name: 'busy/free:free',
      score: 76,
      smoke_status: 'metadata_pass',
      metadata: { id: 'busy/free:free' },
    });
    providerModelScores.recordModelTaskOutcome({
      provider: 'openrouter',
      modelName: 'busy/free:free',
      success: false,
      error: 'OpenAI API error (429): rate limit exceeded',
    });

    const row = providerModelScores.upsertModelScore({
      provider: 'openrouter',
      model_name: 'busy/free:free',
      score: 100,
      smoke_status: 'metadata_pass',
      score_reason: 'free,tools_metadata,context_65536',
      metadata: { id: 'busy/free:free', context_window: 65536 },
    }, { preserveLiveOutcome: true });

    expect(row.score).toBe(41);
    expect(row.smoke_status).toBe('rate_limited');
    expect(row.rate_limited).toBe(1);
    expect(JSON.parse(row.metadata_json)).toMatchObject({
      id: 'busy/free:free',
      context_window: 65536,
      last_task_outcome: {
        success: false,
        stop_reason: null,
      },
    });
  });
});
