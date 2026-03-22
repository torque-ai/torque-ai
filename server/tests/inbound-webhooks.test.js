/**
 * Tests for Inbound Webhooks feature
 *
 * Covers:
 * - DB CRUD: create, get, list, delete, recordTrigger
 * - Handler validation: missing name, missing task_description, duplicate name, success paths
 * - HMAC signature verification: correct signature passes, wrong signature fails
 * - Payload substitution: {{payload.*}} variable replacement
 * - Tool integration via safeTool
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

let testDir, origDataDir, db, mod, handleToolCall;
const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
let templateBuffer;

function setup() {
  testDir = path.join(os.tmpdir(), `torque-vtest-inbound-wh-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;

  // Clear cached modules so they pick up new data dir
  db = require('../database');
  if (!templateBuffer) templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
  db.resetForTest(templateBuffer);
  mod = require('../db/inbound-webhooks');
  mod.setDb(db.getDb ? db.getDb() : db.getDbInstance());

  const tools = require('../tools');
  handleToolCall = tools.handleToolCall;
}

function teardown() {
  if (db) try { db.close(); } catch {}
  db = null;
  if (testDir) {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
    if (origDataDir !== undefined) process.env.TORQUE_DATA_DIR = origDataDir;
    else delete process.env.TORQUE_DATA_DIR;
  }
}

function rawDb() {
  return db.getDb ? db.getDb() : db.getDbInstance();
}

function resetInboundWebhooks() {
  rawDb().prepare('DELETE FROM inbound_webhooks').run();
}

async function safeTool(name, args) {
  try {
    return await handleToolCall(name, args);
  } catch (err) {
    return { content: [{ type: 'text', text: err.message }], isError: true };
  }
}

function getText(result) {
  if (result && result.content && result.content[0]) {
    return result.content[0].text || '';
  }
  return '';
}

// Single lifecycle for all tests
beforeAll(() => { setup(); });
afterAll(() => { teardown(); });

// ============================================
// DB Module Tests
// ============================================

describe('Inbound Webhooks DB Module', () => {
  beforeEach(() => { resetInboundWebhooks(); });

  describe('createInboundWebhook', () => {
    it('creates a webhook with required fields', () => {
      const result = mod.createInboundWebhook({
        name: 'test-hook',
        source_type: 'github',
        secret: 'my-secret-123',
        action_config: { task_description: 'Run tests' },
      });

      expect(result).toBeTruthy();
      expect(result.id).toBeTruthy();
      expect(result.name).toBe('test-hook');
      expect(result.source_type).toBe('github');
      expect(result.secret).toBe('my-secret-123');
      expect(result.action_config).toEqual({ task_description: 'Run tests' });
      expect(result.enabled).toBe(true);
      expect(result.trigger_count).toBe(0);
      expect(result.created_at).toBeTruthy();
    });

    it('creates a webhook with default source_type', () => {
      const result = mod.createInboundWebhook({
        name: 'generic-hook',
        secret: 'secret',
        action_config: { task_description: 'Do something' },
      });

      expect(result.source_type).toBe('generic');
    });

    it('stores action_config as string and parses on read', () => {
      const config = { task_description: 'Test {{payload.repo}}', provider: 'codex' };
      const result = mod.createInboundWebhook({
        name: 'json-hook',
        secret: 'secret',
        action_config: JSON.stringify(config),
      });

      expect(result.action_config).toEqual(config);
    });

    it('throws on duplicate name', () => {
      mod.createInboundWebhook({
        name: 'dup-hook',
        secret: 'secret-1',
        action_config: { task_description: 'First' },
      });

      expect(() => {
        mod.createInboundWebhook({
          name: 'dup-hook',
          secret: 'secret-2',
          action_config: { task_description: 'Second' },
        });
      }).toThrow();
    });

    it('generates unique IDs for each webhook', () => {
      const w1 = mod.createInboundWebhook({
        name: 'hook-1',
        secret: 's1',
        action_config: { task_description: 'First' },
      });
      const w2 = mod.createInboundWebhook({
        name: 'hook-2',
        secret: 's2',
        action_config: { task_description: 'Second' },
      });

      expect(w1.id).toBeTruthy();
      expect(w2.id).toBeTruthy();
      expect(w1.id).not.toBe(w2.id);
    });
  });

  describe('getInboundWebhook', () => {
    it('returns webhook by name', () => {
      mod.createInboundWebhook({
        name: 'find-me',
        secret: 'secret',
        action_config: { task_description: 'Found' },
      });

      const result = mod.getInboundWebhook('find-me');
      expect(result).toBeTruthy();
      expect(result.name).toBe('find-me');
    });

    it('returns null for non-existent name', () => {
      const result = mod.getInboundWebhook('does-not-exist');
      expect(result).toBeNull();
    });

    it('parses action_config as JSON', () => {
      mod.createInboundWebhook({
        name: 'json-test',
        secret: 'secret',
        action_config: { task_description: 'Test', provider: 'ollama' },
      });

      const result = mod.getInboundWebhook('json-test');
      expect(result.action_config).toEqual({ task_description: 'Test', provider: 'ollama' });
    });

    it('returns enabled as boolean', () => {
      mod.createInboundWebhook({
        name: 'bool-test',
        secret: 'secret',
        action_config: { task_description: 'Test' },
      });

      const result = mod.getInboundWebhook('bool-test');
      expect(result.enabled).toBe(true);
    });
  });

  describe('listInboundWebhooks', () => {
    it('returns empty array when no webhooks', () => {
      const result = mod.listInboundWebhooks();
      expect(result).toEqual([]);
    });

    it('returns all webhooks', () => {
      mod.createInboundWebhook({ name: 'hook-1', secret: 's1', action_config: { task_description: '1' } });
      mod.createInboundWebhook({ name: 'hook-2', secret: 's2', action_config: { task_description: '2' } });
      mod.createInboundWebhook({ name: 'hook-3', secret: 's3', action_config: { task_description: '3' } });

      const result = mod.listInboundWebhooks();
      expect(result).toHaveLength(3);
    });

    it('parses action_config for each webhook', () => {
      mod.createInboundWebhook({
        name: 'config-test',
        secret: 'secret',
        action_config: { task_description: 'Test', tags: 'ci' },
      });

      const result = mod.listInboundWebhooks();
      expect(result[0].action_config).toEqual({ task_description: 'Test', tags: 'ci' });
    });

    it('returns enabled as boolean for each entry', () => {
      mod.createInboundWebhook({
        name: 'list-bool',
        secret: 'secret',
        action_config: { task_description: 'Test' },
      });

      const result = mod.listInboundWebhooks();
      expect(result[0].enabled).toBe(true);
    });

    it('masks webhook secrets in list responses', () => {
      mod.createInboundWebhook({
        name: 'masked-secret',
        secret: 'super-secret',
        action_config: { task_description: 'Test' },
      });

      const result = mod.listInboundWebhooks();
      expect(result[0].secret).toBe('••••••••');
    });
  });

  describe('deleteInboundWebhook', () => {
    it('deletes an existing webhook', () => {
      mod.createInboundWebhook({ name: 'to-delete', secret: 'secret', action_config: { task_description: 'Del' } });

      const deleted = mod.deleteInboundWebhook('to-delete');
      expect(deleted).toBe(true);

      const result = mod.getInboundWebhook('to-delete');
      expect(result).toBeNull();
    });

    it('returns false for non-existent webhook', () => {
      const deleted = mod.deleteInboundWebhook('ghost');
      expect(deleted).toBe(false);
    });
  });

  describe('recordWebhookTrigger', () => {
    it('increments trigger_count', () => {
      mod.createInboundWebhook({
        name: 'trigger-test',
        secret: 'secret',
        action_config: { task_description: 'Trigger' },
      });

      mod.recordWebhookTrigger('trigger-test');
      let result = mod.getInboundWebhook('trigger-test');
      expect(result.trigger_count).toBe(1);

      mod.recordWebhookTrigger('trigger-test');
      result = mod.getInboundWebhook('trigger-test');
      expect(result.trigger_count).toBe(2);
    });

    it('sets last_triggered_at', () => {
      mod.createInboundWebhook({
        name: 'ts-test',
        secret: 'secret',
        action_config: { task_description: 'Timestamp' },
      });

      const before = mod.getInboundWebhook('ts-test');
      expect(before.last_triggered_at).toBeNull();

      mod.recordWebhookTrigger('ts-test');
      const after = mod.getInboundWebhook('ts-test');
      expect(after.last_triggered_at).toBeTruthy();
    });

    it('returns false for non-existent webhook', () => {
      const result = mod.recordWebhookTrigger('no-such-hook');
      expect(result).toBe(false);
    });

    it('increments trigger_count multiple times', () => {
      mod.createInboundWebhook({
        name: 'multi-trigger',
        secret: 'secret',
        action_config: { task_description: 'Multi' },
      });

      for (let i = 0; i < 5; i++) {
        mod.recordWebhookTrigger('multi-trigger');
      }

      const result = mod.getInboundWebhook('multi-trigger');
      expect(result.trigger_count).toBe(5);
    });
  });
});

// ============================================
// Handler Tests (via MCP tool dispatch)
// ============================================

describe('Inbound Webhook Handlers', () => {
  beforeEach(() => { resetInboundWebhooks(); });

  describe('create_inbound_webhook', () => {
    it('creates webhook with valid params', async () => {
      const result = await safeTool('create_inbound_webhook', {
        name: 'ci-deploy',
        task_description: 'Deploy {{payload.branch}} to staging',
        source_type: 'github',
      });

      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Inbound Webhook Created');
      expect(text).toContain('ci-deploy');
      expect(text).toContain('github');
      expect(text).toContain('Secret:');
      expect(text).toContain('/api/webhooks/inbound/ci-deploy');
    });

    it('rejects missing name', async () => {
      const result = await safeTool('create_inbound_webhook', {
        task_description: 'Do something',
      });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('name');
    });

    it('rejects empty name', async () => {
      const result = await safeTool('create_inbound_webhook', {
        name: '',
        task_description: 'Do something',
      });

      expect(result.isError).toBe(true);
    });

    it('rejects missing task_description', async () => {
      const result = await safeTool('create_inbound_webhook', {
        name: 'test-hook',
      });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('task_description');
    });

    it('rejects invalid source_type', async () => {
      const result = await safeTool('create_inbound_webhook', {
        name: 'test-hook',
        task_description: 'Do something',
        source_type: 'bitbucket',
      });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('source_type');
    });

    it('rejects duplicate name', async () => {
      await safeTool('create_inbound_webhook', {
        name: 'unique-hook',
        task_description: 'First',
      });

      const result = await safeTool('create_inbound_webhook', {
        name: 'unique-hook',
        task_description: 'Second',
      });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('already exists');
    });

    it('stores provider and model in action_config', async () => {
      const result = await safeTool('create_inbound_webhook', {
        name: 'configured-hook',
        task_description: 'Run build',
        provider: 'codex',
        model: 'gpt-5.3-codex-spark',
      });

      expect(result.isError).toBeFalsy();

      const webhook = mod.getInboundWebhook('configured-hook');
      expect(webhook.action_config.provider).toBe('codex');
      expect(webhook.action_config.model).toBe('gpt-5.3-codex-spark');
    });

    it('stores tags and working_directory in action_config', async () => {
      const result = await safeTool('create_inbound_webhook', {
        name: 'full-hook',
        task_description: 'Run something',
        tags: 'ci,deploy',
        working_directory: '/home/user/project',
      });

      expect(result.isError).toBeFalsy();

      const webhook = mod.getInboundWebhook('full-hook');
      expect(webhook.action_config.tags).toBe('ci,deploy');
      expect(webhook.action_config.working_directory).toBe('/home/user/project');
    });

    it('generates a 64-character hex secret', async () => {
      const result = await safeTool('create_inbound_webhook', {
        name: 'secret-test',
        task_description: 'Check secret',
      });

      expect(result.isError).toBeFalsy();
      const webhook = mod.getInboundWebhook('secret-test');
      expect(webhook.secret).toMatch(/^[a-f0-9]{64}$/);
    });

    it('shows X-Hub-Signature-256 for github source_type', async () => {
      const result = await safeTool('create_inbound_webhook', {
        name: 'gh-hook',
        task_description: 'GitHub push',
        source_type: 'github',
      });

      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('X-Hub-Signature-256');
    });

    it('shows X-Webhook-Signature for generic source_type', async () => {
      const result = await safeTool('create_inbound_webhook', {
        name: 'gen-hook',
        task_description: 'Generic trigger',
        source_type: 'generic',
      });

      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('X-Webhook-Signature');
    });
  });

  describe('list_inbound_webhooks', () => {
    it('returns empty message when no webhooks', async () => {
      const result = await safeTool('list_inbound_webhooks', {});

      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('No inbound webhooks configured');
    });

    it('lists created webhooks', async () => {
      await safeTool('create_inbound_webhook', { name: 'hook-a', task_description: 'A' });
      await safeTool('create_inbound_webhook', { name: 'hook-b', task_description: 'B' });

      const result = await safeTool('list_inbound_webhooks', {});

      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('hook-a');
      expect(text).toContain('hook-b');
      expect(text).toContain('2 webhook(s) configured');
    });

    it('shows trigger count and last triggered', async () => {
      await safeTool('create_inbound_webhook', { name: 'triggered-hook', task_description: 'Trigger' });
      mod.recordWebhookTrigger('triggered-hook');

      const result = await safeTool('list_inbound_webhooks', {});
      const text = getText(result);
      expect(text).toContain('Triggers:');
    });
  });

  describe('delete_inbound_webhook', () => {
    it('deletes existing webhook', async () => {
      await safeTool('create_inbound_webhook', { name: 'doomed', task_description: 'Delete me' });

      const result = await safeTool('delete_inbound_webhook', { name: 'doomed' });

      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Deleted');
      expect(getText(result)).toContain('doomed');
    });

    it('rejects missing name', async () => {
      const result = await safeTool('delete_inbound_webhook', {});

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('name');
    });

    it('returns error for non-existent webhook', async () => {
      const result = await safeTool('delete_inbound_webhook', { name: 'nonexistent' });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('not found');
    });
  });
});

// ============================================
// HMAC Verification Tests
// ============================================

describe('Inbound Webhook HMAC Verification', () => {
  let verifyWebhookSignature;

  beforeAll(() => {
    // Clear cache to get fresh module
    const apiServer = require('../api-server');
    verifyWebhookSignature = apiServer.verifyWebhookSignature;
  });

  it('accepts valid HMAC signature with sha256= prefix', () => {
    const secret = 'test-secret-key';
    const body = '{"action":"push","branch":"main"}';
    const hmac = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
    const signature = `sha256=${hmac}`;

    expect(verifyWebhookSignature(secret, body, signature)).toBe(true);
  });

  it('accepts valid HMAC signature without prefix', () => {
    const secret = 'test-secret-key';
    const body = '{"action":"push"}';
    const hmac = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');

    expect(verifyWebhookSignature(secret, body, hmac)).toBe(true);
  });

  it('rejects invalid signature', () => {
    const secret = 'test-secret-key';
    const body = '{"action":"push"}';
    const wrongSignature = 'sha256=' + 'a'.repeat(64);

    expect(verifyWebhookSignature(secret, body, wrongSignature)).toBe(false);
  });

  it('rejects signature with wrong secret', () => {
    const body = '{"action":"push"}';
    const hmac = crypto.createHmac('sha256', 'correct-secret').update(body, 'utf8').digest('hex');
    const signature = `sha256=${hmac}`;

    expect(verifyWebhookSignature('wrong-secret', body, signature)).toBe(false);
  });

  it('rejects empty signature header', () => {
    expect(verifyWebhookSignature('secret', 'body', '')).toBe(false);
  });

  it('rejects null signature header', () => {
    expect(verifyWebhookSignature('secret', 'body', null)).toBe(false);
  });

  it('rejects undefined signature header', () => {
    expect(verifyWebhookSignature('secret', 'body', undefined)).toBe(false);
  });

  it('rejects signature with different length', () => {
    const secret = 'test-secret';
    const body = '{"test":true}';
    const signature = 'sha256=tooshort';

    expect(verifyWebhookSignature(secret, body, signature)).toBe(false);
  });

  it('handles empty body with valid signature', () => {
    const secret = 'test-secret';
    const body = '';
    const hmac = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
    const signature = `sha256=${hmac}`;

    expect(verifyWebhookSignature(secret, body, signature)).toBe(true);
  });

  it('uses constant-time comparison (does not crash on non-hex)', () => {
    const secret = 'test-secret';
    const body = 'test';
    const signature = 'sha256=zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';

    // Should not throw, just return false
    expect(verifyWebhookSignature(secret, body, signature)).toBe(false);
  });
});

// ============================================
// Payload Substitution Tests
// ============================================

describe('Inbound Webhook Payload Substitution', () => {
  let substitutePayload;

  beforeAll(() => {
    const apiServer = require('../api-server');
    substitutePayload = apiServer.substitutePayload;
  });

  it('substitutes simple top-level field', () => {
    const result = substitutePayload(
      'Deploy branch {{payload.branch}}',
      { branch: 'main' }
    );
    expect(result).toBe('Deploy branch main');
  });

  it('substitutes nested fields with dot notation', () => {
    const result = substitutePayload(
      'Repo: {{payload.repository.name}} by {{payload.repository.owner.login}}',
      { repository: { name: 'torque', owner: { login: 'user' } } }
    );
    expect(result).toBe('Repo: torque by user');
  });

  it('leaves unresolvable placeholders unchanged', () => {
    const result = substitutePayload(
      'Value: {{payload.nonexistent}}',
      { other: 'data' }
    );
    expect(result).toBe('Value: {{payload.nonexistent}}');
  });

  it('handles multiple substitutions', () => {
    const result = substitutePayload(
      '{{payload.action}} on {{payload.branch}} in {{payload.repo}}',
      { action: 'push', branch: 'main', repo: 'torque' }
    );
    expect(result).toBe('push on main in torque');
  });

  it('converts numeric values to strings', () => {
    const result = substitutePayload(
      'PR #{{payload.number}}',
      { number: 42 }
    );
    expect(result).toBe('PR #42');
  });

  it('handles boolean values', () => {
    const result = substitutePayload(
      'Draft: {{payload.draft}}',
      { draft: false }
    );
    expect(result).toBe('Draft: false');
  });

  it('leaves placeholder for null nested path', () => {
    const result = substitutePayload(
      'Value: {{payload.a.b.c}}',
      { a: null }
    );
    expect(result).toBe('Value: {{payload.a.b.c}}');
  });

  it('handles empty payload', () => {
    const result = substitutePayload('No vars here', {});
    expect(result).toBe('No vars here');
  });

  it('handles template with no placeholders', () => {
    const result = substitutePayload('Plain text', { key: 'value' });
    expect(result).toBe('Plain text');
  });

  it('handles empty template', () => {
    const result = substitutePayload('', { key: 'value' });
    expect(result).toBe('');
  });
});

// ============================================
// Inbound webhooks sub-module direct access
// ============================================

describe('Inbound Webhooks via inbound-webhooks sub-module', () => {
  beforeEach(() => { resetInboundWebhooks(); });

  it('exposes createInboundWebhook', () => {
    expect(typeof mod.createInboundWebhook).toBe('function');
  });

  it('exposes getInboundWebhook', () => {
    expect(typeof mod.getInboundWebhook).toBe('function');
  });

  it('exposes listInboundWebhooks', () => {
    expect(typeof mod.listInboundWebhooks).toBe('function');
  });

  it('exposes deleteInboundWebhook', () => {
    expect(typeof mod.deleteInboundWebhook).toBe('function');
  });

  it('exposes recordWebhookTrigger', () => {
    expect(typeof mod.recordWebhookTrigger).toBe('function');
  });

  it('can create and retrieve via sub-module', () => {
    mod.createInboundWebhook({
      name: 'db-test',
      secret: 'secret',
      action_config: { task_description: 'DB test' },
    });

    const result = mod.getInboundWebhook('db-test');
    expect(result).toBeTruthy();
    expect(result.name).toBe('db-test');
  });
});
