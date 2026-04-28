'use strict';

const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const { createFineTuneRuntime } = require('../fine-tune/fine-tune-runtime');

describe('fineTuneRuntime', () => {
  let db;
  let runtime;
  let backend;

  beforeEach(() => {
    const setup = setupTestDbOnly('fine-tune-runtime');
    db = setup.db.getDbInstance();
    backend = {
      train: vi.fn(async () => ({ adapterPath: '/tmp/adapter.safetensors' })),
    };
    runtime = createFineTuneRuntime({
      db,
      backends: { test: backend },
      buildDataset: async () => ({ outputPath: '/tmp/ds.jsonl', record_count: 42 }),
    });
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('submit creates a job row in pending state', async () => {
    const jobId = await runtime.submit({
      name: 'my-ft',
      baseModel: 'qwen3:30b',
      backend: 'test',
      sourceGlobs: ['src/**/*.js'],
      workingDir: '/proj',
    });

    const row = db.prepare('SELECT * FROM fine_tune_jobs WHERE job_id = ?').get(jobId);
    expect(row.status).toBe('pending');
    expect(JSON.parse(row.source_globs_json)).toEqual(['src/**/*.js']);
  });

  it('execute runs dataset build + backend train + registers alias', async () => {
    const registerAlias = vi.fn((alias, _spec) => ({ ok: true, alias }));
    const jobId = await runtime.submit({
      name: 'x',
      baseModel: 'b',
      backend: 'test',
      sourceGlobs: ['*.js'],
      workingDir: '/',
    });

    const result = await runtime.execute(jobId, { registerAlias });

    expect(result.model_alias).toMatch(/^b-project-x/);
    expect(backend.train).toHaveBeenCalled();
    expect(registerAlias).toHaveBeenCalledWith('b-project-x', {
      baseModel: 'b',
      adapterPath: '/tmp/adapter.safetensors',
    });
    const row = db.prepare('SELECT status, adapter_path, model_alias FROM fine_tune_jobs WHERE job_id = ?').get(jobId);
    expect(row.status).toBe('completed');
    expect(row.adapter_path).toBe('/tmp/adapter.safetensors');
  });

  it('marks job failed if backend throws', async () => {
    const bad = { train: vi.fn(async () => { throw new Error('boom'); }) };
    const rt = createFineTuneRuntime({
      db,
      backends: { bad },
      buildDataset: async () => ({ outputPath: '/x', record_count: 1 }),
    });
    const jobId = await rt.submit({
      name: 'x',
      baseModel: 'b',
      backend: 'bad',
      sourceGlobs: ['*'],
      workingDir: '/',
    });

    await expect(rt.execute(jobId, { registerAlias: () => ({}) })).rejects.toThrow(/boom/);
    const row = db.prepare('SELECT status, error FROM fine_tune_jobs WHERE job_id = ?').get(jobId);
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/boom/);
  });
});
