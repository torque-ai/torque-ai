const { setupTestDb, teardownTestDb, safeTool, getText, rawDb } = require('./vitest-setup');

describe('provider CRUD tools', () => {
  beforeAll(() => {
    setupTestDb('provider-crud');
  });

  afterAll(() => {
    teardownTestDb();
  });

  beforeEach(() => {
    rawDb().prepare(`DELETE FROM tasks WHERE id LIKE 'test-provider-%'`).run();
    rawDb().prepare(`DELETE FROM tasks WHERE provider LIKE 'test-provider-%'`).run();
    rawDb().prepare(`DELETE FROM model_registry WHERE provider LIKE 'test-provider-%'`).run();
    rawDb().prepare(`DELETE FROM provider_config WHERE provider LIKE 'test-provider-%'`).run();
    rawDb().prepare(`DELETE FROM config WHERE key = 'default_provider'`).run();
  });

  it('add custom provider creates record', async () => {
    const result = await safeTool('add_provider', {
      name: 'test-provider-custom',
      provider_type: 'custom',
      api_base_url: 'https://example.test/v1',
      api_key: 'test-key',
      default_model: 'model-a',
      models: ['model-a', 'model-b'],
    });

    expect(result.isError).toBeFalsy();
    expect(getText(result)).toContain('test-provider-custom');

    const providerRow = rawDb().prepare(`
      SELECT provider, provider_type, api_base_url, default_model, max_concurrent, transport
      FROM provider_config
      WHERE provider = ?
    `).get('test-provider-custom');

    expect(providerRow).toEqual({
      provider: 'test-provider-custom',
      provider_type: 'custom',
      api_base_url: 'https://example.test/v1',
      default_model: 'model-a',
      max_concurrent: 3,
      transport: 'api',
    });

    const models = rawDb().prepare(`
      SELECT model_name, status
      FROM model_registry
      WHERE provider = ?
      ORDER BY model_name
    `).all('test-provider-custom');

    expect(models).toEqual([
      { model_name: 'model-a', status: 'pending' },
      { model_name: 'model-b', status: 'pending' },
    ]);
  });

  it('add duplicate name fails', async () => {
    await safeTool('add_provider', {
      name: 'test-provider-duplicate',
      provider_type: 'custom',
    });

    const duplicateResult = await safeTool('add_provider', {
      name: 'test-provider-duplicate',
      provider_type: 'custom',
    });

    expect(duplicateResult.isError).toBe(true);
    expect(getText(duplicateResult)).toContain('Provider already exists');
  });

  it('remove provider with confirm deletes', async () => {
    await safeTool('add_provider', {
      name: 'test-provider-remove',
      provider_type: 'custom',
      models: ['remove-model'],
    });

    rawDb().prepare(`
      INSERT INTO tasks (id, task_description, status, provider, model, created_at, working_directory, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'test-provider-remove-task',
      'Remove provider reroute test',
      'queued',
      'test-provider-remove',
      'remove-model',
      new Date().toISOString(),
      'C:/repo',
      null,
    );

    const result = await safeTool('remove_provider', {
      provider: 'test-provider-remove',
      confirm: true,
    });

    expect(result.isError).toBeFalsy();
    expect(getText(result)).toContain('removed');

    const providerRow = rawDb().prepare(`
      SELECT provider
      FROM provider_config
      WHERE provider = ?
    `).get('test-provider-remove');
    expect(providerRow).toBeUndefined();

    const modelRow = rawDb().prepare(`
      SELECT status
      FROM model_registry
      WHERE provider = ? AND model_name = ?
    `).get('test-provider-remove', 'remove-model');
    expect(modelRow.status).toBe('removed');

    const taskRow = rawDb().prepare(`
      SELECT provider, original_provider, model
      FROM tasks
      WHERE id = ?
    `).get('test-provider-remove-task');
    expect(taskRow.provider).not.toBe('test-provider-remove');
    expect(taskRow.original_provider).toBe('test-provider-remove');
    expect(taskRow.model).toBeNull();
  });

  it('remove without confirm shows info', async () => {
    await safeTool('add_provider', {
      name: 'test-provider-preview',
      provider_type: 'custom',
      models: ['preview-model'],
    });

    const now = new Date().toISOString();
    rawDb().prepare(`
      INSERT INTO tasks (id, task_description, status, provider, model, created_at, started_at, working_directory, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'test-provider-preview-running',
      'Running task',
      'running',
      'test-provider-preview',
      'preview-model',
      now,
      now,
      'C:/repo',
      null,
    );
    rawDb().prepare(`
      INSERT INTO tasks (id, task_description, status, provider, model, created_at, working_directory, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'test-provider-preview-queued',
      'Queued task',
      'queued',
      'test-provider-preview',
      'preview-model',
      now,
      'C:/repo',
      null,
    );

    const result = await safeTool('remove_provider', {
      provider: 'test-provider-preview',
    });

    expect(result.isError).toBeFalsy();
    expect(result.confirm_required).toBe(true);
    expect(result.affected_tasks).toEqual({
      queued: 1,
      running: 1,
      total: 2,
    });
    expect(getText(result)).toContain('Re-run with confirm=true');

    const providerRow = rawDb().prepare(`
      SELECT provider
      FROM provider_config
      WHERE provider = ?
    `).get('test-provider-preview');
    expect(providerRow.provider).toBe('test-provider-preview');
  });
});
