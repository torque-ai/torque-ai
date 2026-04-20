const { setupTestDb, teardownTestDb, getText } = require('./vitest-setup');

const TOOLS_MODULE_PATH = require.resolve('../tools');

function unloadToolsModule() {
  delete require.cache[TOOLS_MODULE_PATH];
}

function isToolsModuleLoaded() {
  return Object.prototype.hasOwnProperty.call(require.cache, TOOLS_MODULE_PATH);
}

describe('test database setup tool loading', () => {
  beforeEach(() => {
    unloadToolsModule();
  });

  afterEach(() => {
    teardownTestDb();
    unloadToolsModule();
  });

  it('does not load server/tools.js during database setup', () => {
    const setup = setupTestDb('test-container-helper-db-only');

    expect(setup.db).toBeTruthy();
    expect(typeof setup.handleToolCall).toBe('function');
    expect(isToolsModuleLoaded()).toBe(false);
  });

  it('loads server/tools.js only when the lazy handleToolCall wrapper is invoked', async () => {
    const { handleToolCall } = setupTestDb('test-container-helper-tool-call');

    expect(isToolsModuleLoaded()).toBe(false);

    const result = await handleToolCall('ping', { message: 'lazy-dispatch' });

    expect(isToolsModuleLoaded()).toBe(true);
    expect(JSON.parse(getText(result))).toMatchObject({
      pong: true,
      message: 'lazy-dispatch',
    });
  });
});
