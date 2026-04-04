'use strict';

const { randomUUID } = require('crypto');

const { setupTestDbOnly, teardownTestDb, rawDb, resetTables } = require('./vitest-setup');
const registry = require('../models/registry');
const eventBus = require('../event-bus');

function getModel(provider, modelName, hostId) {
  const values = [provider, modelName];
  let sql = `
    SELECT *
    FROM model_registry
    WHERE provider = ?
      AND model_name = ?
  `;

  if (hostId === null || hostId === undefined) {
    sql += ' AND host_id IS NULL';
  } else {
    sql += ' AND host_id = ?';
    values.push(hostId);
  }

  return rawDb().prepare(sql).get(...values) || null;
}

function insertCapability(modelName, overrides = {}) {
  const defaults = {
    score_code_gen: 0.5,
    score_refactoring: 0.5,
    score_testing: 0.5,
    score_reasoning: 0.5,
    score_docs: 0.5,
    lang_typescript: 0.5,
    lang_javascript: 0.5,
    lang_python: 0.5,
    lang_csharp: 0.5,
    lang_go: 0.5,
    lang_rust: 0.5,
    lang_general: 0.5,
    context_window: 8192,
    param_size_b: 0,
    is_thinking_model: 0,
    source: 'test',
  };

  const row = { ...defaults, ...overrides };
  rawDb().prepare(`
    INSERT OR REPLACE INTO model_capabilities (
      model_name,
      score_code_gen,
      score_refactoring,
      score_testing,
      score_reasoning,
      score_docs,
      lang_typescript,
      lang_javascript,
      lang_python,
      lang_csharp,
      lang_go,
      lang_rust,
      lang_general,
      context_window,
      param_size_b,
      is_thinking_model,
      source,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    modelName,
    row.score_code_gen,
    row.score_refactoring,
    row.score_testing,
    row.score_reasoning,
    row.score_docs,
    row.lang_typescript,
    row.lang_javascript,
    row.lang_python,
    row.lang_csharp,
    row.lang_go,
    row.lang_rust,
    row.lang_general,
    row.context_window,
    row.param_size_b,
    row.is_thinking_model,
    row.source,
  );
}

function insertQueuedTask(overrides = {}) {
  const id = overrides.id || randomUUID();
  rawDb().prepare(`
    INSERT INTO tasks (
      id,
      status,
      task_description,
      created_at,
      provider,
      original_provider,
      model,
      complexity
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    overrides.status || 'queued',
    overrides.task_description || 'Queued task',
    overrides.created_at || new Date().toISOString(),
    overrides.provider || 'ollama',
    overrides.original_provider || overrides.provider || 'ollama',
    overrides.model || null,
    overrides.complexity || 'normal',
  );
  return id;
}

describe('models/registry', () => {
  beforeAll(() => {
    setupTestDbOnly('model-registry');
    registry.setDb(rawDb());
  });

  afterAll(() => {
    registry.setDb(null);
    teardownTestDb();
  });

  beforeEach(() => {
    registry.setDb(rawDb());
    resetTables(['model_registry', 'tasks']);
    rawDb().prepare("DELETE FROM model_capabilities WHERE model_name LIKE 'test-model-registry-%'").run();
    vi.restoreAllMocks();
  });

  it('registerModel inserts a new pending record and emits discovery', () => {
    const emitSpy = vi.spyOn(eventBus, 'emitModelDiscovered');

    const result = registry.registerModel({
      provider: 'ollama',
      hostId: 'host-a',
      modelName: 'test-model-registry-alpha',
      sizeBytes: 12345,
    });

    const row = getModel('ollama', 'test-model-registry-alpha', 'host-a');

    expect(result.inserted).toBe(true);
    expect(row).toMatchObject({
      provider: 'ollama',
      host_id: 'host-a',
      model_name: 'test-model-registry-alpha',
      size_bytes: 12345,
      status: 'pending',
    });
    expect(row.id).toEqual(expect.any(String));
    expect(row.first_seen_at).toBeTruthy();
    expect(row.last_seen_at).toBeTruthy();

    expect(emitSpy).toHaveBeenCalled();
    expect(emitSpy.mock.calls[0][0]).toMatchObject({
      provider: 'ollama',
      host_id: 'host-a',
      model_name: 'test-model-registry-alpha',
    });
  });

  it('registerModel updates last_seen_at for an existing record without duplicating null-host entries', () => {
    registry.registerModel({
      provider: 'ollama',
      modelName: 'test-model-registry-repeat',
      sizeBytes: 100,
    });

    const initial = getModel('ollama', 'test-model-registry-repeat', null);
    rawDb().prepare('UPDATE model_registry SET last_seen_at = ? WHERE id = ?').run('2001-01-01T00:00:00.000Z', initial.id);

    const emitSpy = vi.spyOn(eventBus, 'emitModelDiscovered');
    const result = registry.registerModel({
      provider: 'ollama',
      modelName: 'test-model-registry-repeat',
      sizeBytes: 222,
    });

    const updated = getModel('ollama', 'test-model-registry-repeat', null);

    expect(result.inserted).toBe(false);
    expect(updated.id).toBe(initial.id);
    expect(updated.first_seen_at).toBe(initial.first_seen_at);
    expect(updated.last_seen_at).not.toBe('2001-01-01T00:00:00.000Z');
    expect(updated.size_bytes).toBe(222);
    expect(rawDb().prepare('SELECT COUNT(*) AS count FROM model_registry').get().count).toBe(1);
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('approveModel marks matching models approved with approval metadata', () => {
    registry.registerModel({
      provider: 'ollama',
      hostId: 'host-a',
      modelName: 'test-model-registry-approve',
    });

    const changes = registry.approveModel('ollama', 'test-model-registry-approve', 'host-a');
    const row = getModel('ollama', 'test-model-registry-approve', 'host-a');

    expect(changes).toBe(1);
    expect(row.status).toBe('approved');
    expect(row.approved_at).toBeTruthy();
    expect(row.approved_by).toBe('user');
  });

  it('denyModel marks matching models denied and clears approval metadata', () => {
    registry.registerModel({
      provider: 'ollama',
      hostId: 'host-a',
      modelName: 'test-model-registry-deny',
    });
    registry.approveModel('ollama', 'test-model-registry-deny', 'host-a');

    const changes = registry.denyModel('ollama', 'test-model-registry-deny', 'host-a');
    const row = getModel('ollama', 'test-model-registry-deny', 'host-a');

    expect(changes).toBe(1);
    expect(row.status).toBe('denied');
    expect(row.approved_at).toBeNull();
    expect(row.approved_by).toBeNull();
  });

  it('markModelRemoved updates status to removed', () => {
    registry.registerModel({
      provider: 'ollama',
      hostId: 'host-a',
      modelName: 'test-model-registry-remove',
    });
    registry.approveModel('ollama', 'test-model-registry-remove', 'host-a');

    const changes = registry.markModelRemoved('ollama', 'test-model-registry-remove', 'host-a');
    const row = getModel('ollama', 'test-model-registry-remove', 'host-a');

    expect(changes).toBe(1);
    expect(row.status).toBe('removed');
  });

  it('listPendingModels returns only pending records', () => {
    registry.registerModel({
      provider: 'ollama',
      hostId: 'host-a',
      modelName: 'test-model-registry-pending-a',
    });
    registry.registerModel({
      provider: 'ollama',
      hostId: 'host-b',
      modelName: 'test-model-registry-pending-b',
    });
    registry.registerModel({
      provider: 'ollama',
      hostId: 'host-c',
      modelName: 'test-model-registry-approved',
    });
    registry.approveModel('ollama', 'test-model-registry-approved', 'host-c');

    const pending = registry.listPendingModels();

    expect(pending.map((row) => row.model_name)).toEqual([
      'test-model-registry-pending-a',
      'test-model-registry-pending-b',
    ]);
    expect(pending.every((row) => row.status === 'pending')).toBe(true);
  });

  it('listModels supports status, provider, and host_id filters', () => {
    registry.registerModel({
      provider: 'ollama',
      hostId: 'host-a',
      modelName: 'test-model-registry-filter-a',
    });
    registry.registerModel({
      provider: 'ollama',
      hostId: 'host-b',
      modelName: 'test-model-registry-filter-b',
    });
    registry.registerModel({
      provider: 'codex',
      hostId: 'host-a',
      modelName: 'test-model-registry-filter-c',
    });
    registry.approveModel('ollama', 'test-model-registry-filter-b', 'host-b');

    expect(
      registry.listModels({ provider: 'ollama', status: 'approved', host_id: 'host-b' }).map((row) => row.model_name),
    ).toEqual(['test-model-registry-filter-b']);
  });

  it('getApprovedModels returns approved rows and respects optional host filtering', () => {
    registry.registerModel({
      provider: 'ollama',
      hostId: 'host-a',
      modelName: 'test-model-registry-approved-a',
    });
    registry.registerModel({
      provider: 'ollama',
      hostId: 'host-b',
      modelName: 'test-model-registry-approved-b',
    });
    registry.registerModel({
      provider: 'ollama',
      hostId: 'host-c',
      modelName: 'test-model-registry-pending-host',
    });

    registry.approveModel('ollama', 'test-model-registry-approved-a', 'host-a');
    registry.approveModel('ollama', 'test-model-registry-approved-b', 'host-b');

    const allApproved = registry.getApprovedModels('ollama').map((row) => row.model_name);
    expect(allApproved).toContain('test-model-registry-approved-a');
    expect(allApproved).toContain('test-model-registry-approved-b');
    expect(allApproved).not.toContain('test-model-registry-pending-host');

    const hostFiltered = registry.getApprovedModels('ollama', 'host-b').map((row) => row.model_name);
    expect(hostFiltered).toContain('test-model-registry-approved-b');
    expect(hostFiltered).not.toContain('test-model-registry-approved-a');
  });

  it('bulkApproveByProvider approves only pending rows for the requested provider', () => {
    registry.registerModel({
      provider: 'ollama',
      hostId: 'host-a',
      modelName: 'test-model-registry-bulk-a',
    });
    registry.registerModel({
      provider: 'ollama',
      hostId: 'host-b',
      modelName: 'test-model-registry-bulk-b',
    });
    registry.registerModel({
      provider: 'ollama',
      hostId: 'host-c',
      modelName: 'test-model-registry-bulk-denied',
    });
    registry.registerModel({
      provider: 'codex',
      hostId: 'host-d',
      modelName: 'test-model-registry-bulk-other',
    });

    registry.denyModel('ollama', 'test-model-registry-bulk-denied', 'host-c');

    const changes = registry.bulkApproveByProvider('ollama');
    const approvedModels = registry.getApprovedModels('ollama').map((row) => row.model_name);

    expect(changes).toBe(2);
    expect(approvedModels).toHaveLength(2);
    expect(approvedModels.slice().sort()).toEqual([
      'test-model-registry-bulk-a',
      'test-model-registry-bulk-b',
    ]);
    expect(getModel('codex', 'test-model-registry-bulk-other', 'host-d').status).toBe('pending');
  });

  it('selectBestApprovedModel returns the highest-ranked approved model', () => {
    registry.registerModel({
      provider: 'ollama',
      hostId: 'host-a',
      modelName: 'test-model-registry-small',
    });
    registry.registerModel({
      provider: 'ollama',
      hostId: 'host-b',
      modelName: 'test-model-registry-large',
    });
    registry.approveModel('ollama', 'test-model-registry-small', 'host-a');
    registry.approveModel('ollama', 'test-model-registry-large', 'host-b');

    insertCapability('test-model-registry-small', {
      score_code_gen: 0.45,
      score_refactoring: 0.45,
      score_testing: 0.45,
      score_reasoning: 0.45,
      score_docs: 0.45,
      param_size_b: 7,
    });
    insertCapability('test-model-registry-large', {
      score_code_gen: 0.9,
      score_refactoring: 0.9,
      score_testing: 0.9,
      score_reasoning: 0.9,
      score_docs: 0.9,
      param_size_b: 32,
    });

    expect(registry.selectBestApprovedModel('ollama', 'complex')).toEqual({
      provider: 'ollama',
      host_id: 'host-b',
      model_name: 'test-model-registry-large',
    });
  });

  it('selectBestApprovedModel returns null when no approved model exists', () => {
    registry.registerModel({
      provider: 'ollama',
      hostId: 'host-a',
      modelName: 'test-model-registry-none',
    });

    expect(registry.selectBestApprovedModel('ollama', 'normal')).toBeNull();
  });

  it('syncModelsFromHealthCheck reports new and updated models from discovered inventory', () => {
    registry.registerModel({
      provider: 'ollama',
      hostId: 'host-a',
      modelName: 'test-model-registry-existing',
      sizeBytes: 100,
    });

    const emitSpy = vi.spyOn(eventBus, 'emitModelDiscovered');

    const result = registry.syncModelsFromHealthCheck('ollama', 'host-a', [
      { name: 'test-model-registry-existing', size: 250 },
      { name: 'test-model-registry-fresh', size: 500 },
      { name: 'test-model-registry-fresh', size: 999 },
    ]);

    const updated = getModel('ollama', 'test-model-registry-existing', 'host-a');
    const inserted = getModel('ollama', 'test-model-registry-fresh', 'host-a');

    expect(result.new.map((row) => row.model_name)).toEqual(['test-model-registry-fresh']);
    expect(result.updated.map((row) => row.model_name)).toEqual(['test-model-registry-existing']);
    expect(result.removed).toEqual([]);
    expect(updated.size_bytes).toBe(250);
    expect(inserted.size_bytes).toBe(500);
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy.mock.calls[0][0]).toMatchObject({ model_name: 'test-model-registry-fresh' });
  });

  it('syncModelsFromHealthCheck removes missing approved models, emits removal, and reroutes queued tasks', () => {
    registry.registerModel({
      provider: 'ollama',
      hostId: 'host-a',
      modelName: 'test-model-registry-gone',
    });
    registry.registerModel({
      provider: 'ollama',
      hostId: 'host-a',
      modelName: 'test-model-registry-fallback',
    });
    registry.approveModel('ollama', 'test-model-registry-gone', 'host-a');
    registry.approveModel('ollama', 'test-model-registry-fallback', 'host-a');

    insertCapability('test-model-registry-fallback', {
      score_code_gen: 0.8,
      score_refactoring: 0.8,
      score_testing: 0.8,
      score_reasoning: 0.8,
      score_docs: 0.8,
      param_size_b: 14,
    });

    const taskId = insertQueuedTask({
      id: 'model-registry-reroute-task',
      status: 'queued',
      provider: 'ollama',
      model: 'test-model-registry-gone',
      task_description: 'Queued task using a removed model',
    });
    rawDb().prepare('UPDATE tasks SET complexity = ? WHERE id = ?').run('complex', taskId);

    const removedSpy = vi.spyOn(eventBus, 'emitModelRemoved');

    const result = registry.syncModelsFromHealthCheck('ollama', 'host-a', [
      { name: 'test-model-registry-fallback', size: 444 },
    ]);

    const removedRow = getModel('ollama', 'test-model-registry-gone', 'host-a');
    const reroutedTask = rawDb().prepare('SELECT provider, model FROM tasks WHERE id = ?').get(taskId);

    expect(result.removed.map((row) => row.model_name)).toEqual(['test-model-registry-gone']);
    expect(removedRow.status).toBe('removed');
    expect(reroutedTask).toEqual({
      provider: 'ollama',
      model: 'test-model-registry-fallback',
    });
    expect(removedSpy).toHaveBeenCalledTimes(1);
    expect(removedSpy.mock.calls[0][0]).toMatchObject({ model_name: 'test-model-registry-gone' });
  });

  it('getModelCount returns grouped counts for a provider', () => {
    registry.registerModel({
      provider: 'ollama',
      hostId: 'host-a',
      modelName: 'test-model-registry-count-pending',
    });
    registry.registerModel({
      provider: 'ollama',
      hostId: 'host-b',
      modelName: 'test-model-registry-count-approved',
    });
    registry.registerModel({
      provider: 'ollama',
      hostId: 'host-c',
      modelName: 'test-model-registry-count-denied',
    });
    registry.registerModel({
      provider: 'ollama',
      hostId: 'host-d',
      modelName: 'test-model-registry-count-removed',
    });
    registry.registerModel({
      provider: 'codex',
      hostId: 'host-z',
      modelName: 'test-model-registry-count-other',
    });

    registry.approveModel('ollama', 'test-model-registry-count-approved', 'host-b');
    registry.denyModel('ollama', 'test-model-registry-count-denied', 'host-c');
    registry.markModelRemoved('ollama', 'test-model-registry-count-removed', 'host-d');

    expect(registry.getModelCount('ollama')).toEqual({
      total: 4,
      pending: 1,
      approved: 1,
      denied: 1,
      removed: 1,
    });
  });
});
