/**
 * Tests for Phase 3.2 tool consolidation:
 * - manage_host — unified host management
 * - manage_tuning — unified LLM tuning management
 * - task_info — unified task status/result/progress
 * - submit_task auto_route — smart routing by default
 */

const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');

let db;

beforeAll(() => {
  ({ db } = setupTestDb('tool-consolidation'));
});
afterAll(() => teardownTestDb());

// ── manage_host ──

describe('manage_host', () => {
  it('requires action parameter', async () => {
    const result = await safeTool('manage_host', {});
    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/Missing required parameter: "action"/i);
  });

  it('rejects invalid action', async () => {
    const result = await safeTool('manage_host', { action: 'explode' });
    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/Parameter "action" must be one of/i);
  });

  it('action=list returns host listing', async () => {
    const result = await safeTool('manage_host', { action: 'list' });
    expect(result.isError).toBeFalsy();
    const text = getText(result);
    // Should produce some output (even if no hosts configured)
    expect(text.length).toBeGreaterThan(0);
  });

  it('action=get_capacity returns capacity info', async () => {
    const result = await safeTool('manage_host', { action: 'get_capacity' });
    expect(result.isError).toBeFalsy();
    const text = getText(result);
    expect(text.length).toBeGreaterThan(0);
  });

  it('action=add with valid params adds host', async () => {
    const result = await safeTool('manage_host', {
      action: 'add',
      name: 'TestHost',
      url: 'http://192.0.2.99:11434',
      id: 'test-consolidation-host',
    });
    expect(result.isError).toBeFalsy();
    const text = getText(result);
    expect(text).toMatch(/TestHost|registered|added/i);
  });

  it('action=disable disables a host', async () => {
    const result = await safeTool('manage_host', {
      action: 'disable',
      host_id: 'test-consolidation-host',
    });
    expect(result.isError).toBeFalsy();
    const text = getText(result);
    expect(text).toMatch(/disabled/i);
  });

  it('action=enable re-enables a host', async () => {
    const result = await safeTool('manage_host', {
      action: 'enable',
      host_id: 'test-consolidation-host',
    });
    expect(result.isError).toBeFalsy();
    const text = getText(result);
    expect(text).toMatch(/enabled/i);
  });

  it('action=remove removes a host', async () => {
    const result = await safeTool('manage_host', {
      action: 'remove',
      host_id: 'test-consolidation-host',
    });
    expect(result.isError).toBeFalsy();
    const text = getText(result);
    expect(text).toMatch(/removed/i);
  });

  it('action=cleanup_null_ids runs cleanup', async () => {
    const result = await safeTool('manage_host', { action: 'cleanup_null_ids' });
    expect(result.isError).toBeFalsy();
  });

  it('all 12 actions are wired', async () => {
    // Call with invalid action — schema validation returns the enum of valid actions
    const result = await safeTool('manage_host', { action: '__invalid__' });
    expect(result.isError).toBe(true);
    const text = getText(result);
    // Schema validation format: Parameter "action" must be one of [list, add, ...], got "..."
    const validMatch = text.match(/must be one of \[([^\]]+)\]/);
    expect(validMatch).toBeTruthy();
    const actions = validMatch[1].split(',').map(s => s.trim()).filter(Boolean);
    expect(actions).toHaveLength(12);
  });
});

// ── manage_tuning ──

describe('manage_tuning', () => {
  it('requires action parameter', async () => {
    const result = await safeTool('manage_tuning', {});
    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/Missing required parameter: "action"/i);
  });

  it('rejects invalid action', async () => {
    const result = await safeTool('manage_tuning', { action: 'explode' });
    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/Parameter "action" must be one of/i);
  });

  it('action=get_llm returns tuning parameters', async () => {
    const result = await safeTool('manage_tuning', { action: 'get_llm' });
    expect(result.isError).toBeFalsy();
    const text = getText(result);
    expect(text).toMatch(/tuning|temperature|parameter/i);
  });

  it('action=set_llm updates tuning parameters', async () => {
    const result = await safeTool('manage_tuning', { action: 'set_llm', temperature: 0.5 });
    expect(result.isError).toBeFalsy();
    const text = getText(result);
    expect(text).toMatch(/updated|temperature/i);
  });

  it('action=list_presets returns preset listing', async () => {
    const result = await safeTool('manage_tuning', { action: 'list_presets' });
    expect(result.isError).toBeFalsy();
    const text = getText(result);
    expect(text.length).toBeGreaterThan(0);
  });

  it('action=get_model returns model settings', async () => {
    const result = await safeTool('manage_tuning', { action: 'get_model' });
    expect(result.isError).toBeFalsy();
    const text = getText(result);
    expect(text.length).toBeGreaterThan(0);
  });

  it('action=set_model requires model param', async () => {
    const result = await safeTool('manage_tuning', { action: 'set_model' });
    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/model.*required/i);
  });

  it('action=get_hardware returns hardware settings', async () => {
    const result = await safeTool('manage_tuning', { action: 'get_hardware' });
    expect(result.isError).toBeFalsy();
    const text = getText(result);
    expect(text).toMatch(/hardware|gpu|thread/i);
  });

  it('action=set_hardware updates hardware tuning', async () => {
    const result = await safeTool('manage_tuning', { action: 'set_hardware', num_gpu: 50 });
    expect(result.isError).toBeFalsy();
    const text = getText(result);
    expect(text).toMatch(/updated|num_gpu|hardware/i);
  });

  it('action=get_auto returns auto-tuning config', async () => {
    const result = await safeTool('manage_tuning', { action: 'get_auto' });
    expect(result.isError).toBeFalsy();
    const text = getText(result);
    expect(text).toMatch(/auto.tuning/i);
  });

  it('action=set_auto updates auto-tuning', async () => {
    const result = await safeTool('manage_tuning', { action: 'set_auto', enabled: true });
    expect(result.isError).toBeFalsy();
    const text = getText(result);
    expect(text).toMatch(/updated|auto.tuning|enabled/i);
  });

  it('action=toggle_wrapping toggles instruction wrapping', async () => {
    const result = await safeTool('manage_tuning', { action: 'toggle_wrapping', enabled: false });
    expect(result.isError).toBeFalsy();
    const text = getText(result);
    expect(text).toMatch(/wrapping|disabled/i);
  });

  it('action=get_prompts returns model prompts', async () => {
    const result = await safeTool('manage_tuning', { action: 'get_prompts' });
    expect(result.isError).toBeFalsy();
    const text = getText(result);
    expect(text.length).toBeGreaterThan(0);
  });

  it('action=get_templates returns instruction templates', async () => {
    const result = await safeTool('manage_tuning', { action: 'get_templates' });
    expect(result.isError).toBeFalsy();
    const text = getText(result);
    expect(text).toMatch(/template|instruction/i);
  });

  it('action=benchmark accepts benchmark params', async () => {
    // benchmark will fail without a live Ollama host, but should not throw
    const result = await safeTool('manage_tuning', {
      action: 'benchmark',
      test_type: 'basic',
      model: 'test-model',
    });
    // Either benchmark error (no host) or success — not a dispatch error
    const text = getText(result);
    expect(text).toMatch(/benchmark|error|host|model/i);
  });

  it('all 16 actions are wired', async () => {
    // Call with invalid action — schema validation returns the enum of valid actions
    const result = await safeTool('manage_tuning', { action: '__invalid__' });
    expect(result.isError).toBe(true);
    const text = getText(result);
    const validMatch = text.match(/must be one of \[([^\]]+)\]/);
    expect(validMatch).toBeTruthy();
    const actions = validMatch[1].split(',').map(s => s.trim()).filter(Boolean);
    expect(actions).toHaveLength(16);
  });
});

// ── task_info ──

describe('task_info', () => {
  it('mode=status without task_id returns queue summary', async () => {
    const result = await safeTool('task_info', {});
    expect(result.isError).toBeFalsy();
    expect(['none', 'moderate', 'high', 'critical', 'unknown']).toContain(result.pressureLevel);
    const text = getText(result);
    expect(text).toMatch(/queue|status|task/i);
  });

  it('mode=status with task_id returns task status', async () => {
    // Create a task first
    const taskId = require('crypto').randomUUID();
    db.createTask({
      id: taskId,
      status: 'completed',
      task_description: 'Test task for task_info',
      provider: 'codex',
    });

    const result = await safeTool('task_info', { task_id: taskId, mode: 'status' });
    expect(result.isError).toBeFalsy();
    const text = getText(result);
    expect(text).toMatch(/completed|status/i);
  });

  it('mode=result requires task_id', async () => {
    const result = await safeTool('task_info', { mode: 'result' });
    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/task_id.*required/i);
  });

  it('mode=result returns full task output', async () => {
    const taskId = require('crypto').randomUUID();
    db.createTask({
      id: taskId,
      status: 'pending',
      task_description: 'Test task with output',
      provider: 'codex',
    });
    db.updateTaskStatus(taskId, 'running');
    db.updateTaskStatus(taskId, 'completed', { output: 'Task output content here' });

    const result = await safeTool('task_info', { task_id: taskId, mode: 'result' });
    expect(result.isError).toBeFalsy();
    const text = getText(result);
    expect(text).toMatch(/output|result|completed/i);
  });

  it('mode=progress requires task_id', async () => {
    const result = await safeTool('task_info', { mode: 'progress' });
    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/task_id.*required/i);
  });

  it('default mode is status', async () => {
    const result = await safeTool('task_info', {});
    // No mode specified → should behave like check_status
    expect(result.isError).toBeFalsy();
  });

  it('rejects invalid mode', async () => {
    const result = await safeTool('task_info', { mode: 'explode' });
    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/Parameter "mode" must be one of/i);
  });
});

// ── manage_webhook ──

describe('manage_webhook', () => {
  it('requires action parameter', async () => {
    const result = await safeTool('manage_webhook', {});
    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/Missing required parameter: "action"/i);
  });

  it('rejects invalid action', async () => {
    const result = await safeTool('manage_webhook', { action: 'explode' });
    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/Parameter "action" must be one of/i);
  });

  it('action=add creates a webhook', async () => {
    const result = await safeTool('manage_webhook', {
      action: 'add',
      name: 'test-consolidation-webhook',
      url: 'https://example.com/hook',
      events: ['completed', 'failed'],
    });
    expect(result.isError).toBeFalsy();
    const text = getText(result);
    expect(text).toMatch(/webhook created/i);
    expect(text).toMatch(/test-consolidation-webhook/);
  });

  it('action=list lists webhooks', async () => {
    const result = await safeTool('manage_webhook', { action: 'list' });
    expect(result.isError).toBeFalsy();
    const text = getText(result);
    expect(text).toMatch(/webhook/i);
  });

  it('action=stats returns stats', async () => {
    const result = await safeTool('manage_webhook', { action: 'stats' });
    expect(result.isError).toBeFalsy();
    const text = getText(result);
    expect(text).toMatch(/webhook statistics/i);
  });

  it('action=remove removes a webhook', async () => {
    // First create a webhook to get its ID
    const addResult = await safeTool('manage_webhook', {
      action: 'add',
      name: 'to-remove-webhook',
      url: 'https://example.com/remove-hook',
    });
    expect(addResult.isError).toBeFalsy();
    const addText = getText(addResult);
    // Extract webhook ID from the result text
    const idMatch = addText.match(/`([0-9a-f-]{36})`/);
    expect(idMatch).toBeTruthy();
    const webhookId = idMatch[1];

    const result = await safeTool('manage_webhook', {
      action: 'remove',
      webhook_id: webhookId,
    });
    expect(result.isError).toBeFalsy();
    const text = getText(result);
    expect(text).toMatch(/webhook removed/i);
  });

  it('action=create_inbound creates inbound webhook', async () => {
    const result = await safeTool('manage_webhook', {
      action: 'create_inbound',
      name: 'test-inbound-consolidated',
      task_description: 'Handle {{payload.event}} from external service',
    });
    expect(result.isError).toBeFalsy();
    const text = getText(result);
    expect(text).toMatch(/inbound webhook created/i);
  });

  it('action=list_inbound lists inbound webhooks', async () => {
    const result = await safeTool('manage_webhook', { action: 'list_inbound' });
    expect(result.isError).toBeFalsy();
    const text = getText(result);
    expect(text).toMatch(/inbound webhook/i);
  });

  it('action=delete_inbound deletes inbound webhook', async () => {
    // Create one first to delete
    await safeTool('manage_webhook', {
      action: 'create_inbound',
      name: 'to-delete-inbound',
      task_description: 'Temp inbound webhook for deletion test',
    });

    const result = await safeTool('manage_webhook', {
      action: 'delete_inbound',
      name: 'to-delete-inbound',
    });
    expect(result.isError).toBeFalsy();
    const text = getText(result);
    expect(text).toMatch(/inbound webhook deleted/i);
  });

  it('all 13 actions are wired', async () => {
    // Call with invalid action — schema validation returns the enum of valid actions
    const result = await safeTool('manage_webhook', { action: '__invalid__' });
    expect(result.isError).toBe(true);
    const text = getText(result);
    const validMatch = text.match(/must be one of \[([^\]]+)\]/);
    expect(validMatch).toBeTruthy();
    const actions = validMatch[1].split(',').map(s => s.trim()).filter(Boolean);
    expect(actions).toHaveLength(13);
  });
});

// ── submit_task auto_route ──

describe('submit_task auto_route', () => {
  const cwd = process.cwd();

  it('auto_route=true (default, no provider) delegates to smart routing', async () => {
    const result = await safeTool('submit_task', {
      task: 'Write a unit test for the widget module in tests/widget.test.js',
      working_directory: cwd,
    });
    const text = getText(result);
    // Smart routing may succeed or report provider unavailability — either is correct dispatch
    expect(text).toMatch(/task|started|queued|provider|routing|no.*available/i);
  });

  it('explicit provider bypasses smart routing', async () => {
    const result = await safeTool('submit_task', {
      task: 'Write documentation for the API',
      provider: 'codex',
      working_directory: cwd,
    });
    const text = getText(result);
    // With explicit provider, goes through direct submit path
    expect(text).toMatch(/task|started|queued|codex|provider/i);
  });

  it('auto_route=false uses direct submission path', async () => {
    const result = await safeTool('submit_task', {
      task: 'Simple doc update',
      auto_route: false,
      working_directory: cwd,
    });
    const text = getText(result);
    // Direct path — uses default provider
    expect(text).toMatch(/task|started|queued|provider|no.*available/i);
  });

  it('auto_route=false with missing task rejects', async () => {
    const result = await safeTool('submit_task', {
      task: '',
      auto_route: false,
    });
    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/task.*non-empty/i);
  });

  it('auto_route=true with missing task rejects', async () => {
    const result = await safeTool('submit_task', { task: '' });
    expect(result.isError).toBe(true);
  });
});
