'use strict';


const { createAuthConfigStore } = require('../auth/auth-config-store');
const { getText, rawDb, safeTool, setupTestDb, teardownTestDb } = require('./vitest-setup');

function parseStructured(result) {
  if (result && result.structuredData) {
    return result.structuredData;
  }

  return JSON.parse(getText(result));
}

describe('managed OAuth MCP surface', () => {
  let originalFetch;

  beforeEach(() => {
    setupTestDb(`managed-oauth-${Date.now()}`);
    originalFetch = global.fetch;

    const authConfigStore = createAuthConfigStore({ db: rawDb() });
    authConfigStore.upsert({
      toolkit: 'github',
      auth_type: 'oauth2',
      client_id: 'client-id',
      client_secret: 'client-secret',
      authorize_url: 'https://github.com/login/oauth/authorize',
      token_url: 'https://github.com/login/oauth/access_token',
      scopes: 'repo user',
      redirect_uri: 'https://torque.test/oauth/callback',
    });
  });

  afterEach(() => {
    require('../tools').setRuntimeRegisteredToolDefs([]);
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    teardownTestDb();
  });

  it('starts an OAuth flow and returns the authorize URL', async () => {
    const result = await safeTool('start_oauth_flow', {
      toolkit: 'github',
      user_id: 'alice',
    });
    const data = parseStructured(result);

    expect(result.isError).not.toBe(true);
    expect(data).toMatchObject({
      toolkit: 'github',
      user_id: 'alice',
      state: 'alice',
    });
    expect(data.authorize_url).toContain('https://github.com/login/oauth/authorize?');
    expect(data.authorize_url).toContain('client_id=client-id');
    expect(data.authorize_url).toContain('scope=repo+user');
  });

  it('completes the OAuth flow, lists, disables, and deletes connected accounts', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 3600,
      }),
    }));

    const completeResult = await safeTool('complete_oauth_flow', {
      toolkit: 'github',
      user_id: 'alice',
      code: 'oauth-code',
    });
    const completeData = parseStructured(completeResult);

    expect(global.fetch).toHaveBeenCalledWith(
      'https://github.com/login/oauth/access_token',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        }),
        body: 'code=oauth-code&client_id=client-id&redirect_uri=https%3A%2F%2Ftorque.test%2Foauth%2Fcallback&grant_type=authorization_code',
      }),
    );
    expect(completeData.connected_account_id).toMatch(/^ca_/);

    const storedRow = rawDb().prepare('SELECT * FROM connected_accounts WHERE id = ?').get(completeData.connected_account_id);
    expect(storedRow).toBeTruthy();
    expect(storedRow.access_token_enc).toBeTruthy();

    const listResult = await safeTool('list_connected_accounts', { user_id: 'alice' });
    const listData = parseStructured(listResult);
    expect(listData.count).toBe(1);
    expect(listData.accounts[0]).toMatchObject({
      id: completeData.connected_account_id,
      user_id: 'alice',
      toolkit: 'github',
      status: 'active',
      has_refresh_token: true,
    });
    expect(listData.accounts[0].access_token).toBeUndefined();

    const disableResult = await safeTool('disable_account', { account_id: completeData.connected_account_id });
    expect(parseStructured(disableResult)).toEqual({
      ok: true,
      account_id: completeData.connected_account_id,
      status: 'disabled',
    });

    const disabledRow = rawDb().prepare('SELECT status FROM connected_accounts WHERE id = ?').get(completeData.connected_account_id);
    expect(disabledRow.status).toBe('disabled');

    const deleteResult = await safeTool('delete_account', { account_id: completeData.connected_account_id });
    expect(parseStructured(deleteResult)).toEqual({
      ok: true,
      account_id: completeData.connected_account_id,
    });

    const deletedRow = rawDb().prepare('SELECT id FROM connected_accounts WHERE id = ?').get(completeData.connected_account_id);
    expect(deletedRow).toBeUndefined();
  });

  it('filters the registered tool catalog by behavioral hints', async () => {
    const result = await safeTool('list_tools_by_hints', {
      readOnlyHint: true,
      destructiveHint: false,
    });
    const data = parseStructured(result);

    expect(result.isError).not.toBe(true);
    expect(data.count).toBeGreaterThan(0);
    expect(data.tools.length).toBe(data.count);
    expect(data.tools.every((tool) => tool.readOnlyHint === true && tool.destructiveHint === false)).toBe(true);
    expect(data.tools.some((tool) => tool.name === 'list_connected_accounts')).toBe(true);
    expect(data.tools.some((tool) => tool.name === 'delete_account')).toBe(false);
  });

  it('includes runtime-registered plugin tools in behavioral hint filtering', async () => {
    require('../tools').setRuntimeRegisteredToolDefs([
      {
        name: 'plugin_runtime_read_tool',
        description: 'Plugin-provided read-only tool',
        inputSchema: { type: 'object', properties: {} },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
    ]);

    const result = await safeTool('list_tools_by_hints', {
      readOnlyHint: true,
      destructiveHint: false,
    });
    const data = parseStructured(result);

    expect(data.tools.some((tool) => tool.name === 'plugin_runtime_read_tool')).toBe(true);
  });
});
