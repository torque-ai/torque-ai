'use strict';

/**
 * Tests for remote-test-routing.js
 *
 * Uses vitest-setup.js helpers for DB lifecycle and lightweight mock objects
 * for the agent registry and its clients.
 */

const { setupTestDbModule, teardownTestDb, rawDb, resetTables } = require('../vitest-setup');
const { createRemoteTestRouter } = require('../../remote/remote-test-routing');

// ── Helpers ──────────────────────────────────────────────────

/** Insert a minimal project_config row */
function insertProjectConfig(project, overrides = {}) {
  const vals = {
    remote_agent_id: null,
    remote_project_path: null,
    prefer_remote_tests: 0,
    ...overrides,
  };
  const now = new Date().toISOString();
  rawDb().prepare(`INSERT OR REPLACE INTO project_config
    (project, remote_agent_id, remote_project_path, prefer_remote_tests, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(project, vals.remote_agent_id, vals.remote_project_path, vals.prefer_remote_tests, now, now);
}

/** Build a mock db object that mirrors the database module's API */
function createMockDb() {
  return {
    getProjectFromPath(workingDir) {
      if (!workingDir) return null;
      // Simple: basename of path
      const parts = workingDir.replace(/\\/g, '/').split('/').filter(Boolean);
      return parts[parts.length - 1] || null;
    },
    getProjectConfig(project) {
      return rawDb().prepare('SELECT * FROM project_config WHERE project = ?').get(project) || null;
    },
  };
}

/** Build a mock logger */
function createMockLogger() {
  const logs = [];
  return {
    info(msg) { logs.push({ level: 'info', msg }); },
    warn(msg) { logs.push({ level: 'warn', msg }); },
    _logs: logs,
  };
}

/** Build a mock client */
function createMockClient({ available = false, syncResult = {}, runResult = null, syncError = null, runError = null } = {}) {
  return {
    _syncCalls: [],
    _runCalls: [],
    isAvailable() { return available; },
    async sync(project, branch) {
      this._syncCalls.push({ project, branch });
      if (syncError) throw syncError;
      return syncResult;
    },
    async run(command, args, opts) {
      this._runCalls.push({ command, args, opts });
      if (runError) throw runError;
      return runResult || {
        success: true,
        output: 'remote output',
        error: '',
        exitCode: 0,
        durationMs: 50,
      };
    },
  };
}

/** Build a mock registry */
function createMockRegistry(clientMap = {}) {
  return {
    getClient(id) {
      return clientMap[id] || null;
    },
  };
}

// ── Tests ────────────────────────────────────────────────────

beforeAll(() => {
  setupTestDbModule('../remote/remote-test-routing', 'remote-routing');
});

afterAll(() => {
  teardownTestDb();
});

describe('createRemoteTestRouter', () => {
  beforeEach(() => {
    resetTables(['project_config']);
  });

  // ── getRemoteConfig ──────────────────────────────────────
  describe('getRemoteConfig()', () => {
    it('should return null when no project config exists in DB', () => {
      const mockDb = createMockDb();
      const logger = createMockLogger();
      const router = createRemoteTestRouter({ agentRegistry: null, db: mockDb, logger });

      const result = router.getRemoteConfig('/some/path/my-project');
      expect(result).toBeNull();
    });

    it('should return null when prefer_remote_tests is not set', () => {
      const mockDb = createMockDb();
      const logger = createMockLogger();
      insertProjectConfig('my-project', {
        remote_agent_id: 'agent-1',
        remote_project_path: '/remote/my-project',
        prefer_remote_tests: 0,
      });

      const router = createRemoteTestRouter({ agentRegistry: null, db: mockDb, logger });
      const result = router.getRemoteConfig('/some/path/my-project');
      expect(result).toBeNull();
    });

    it('should return null when remote_agent_id is missing', () => {
      const mockDb = createMockDb();
      const logger = createMockLogger();
      insertProjectConfig('my-project', {
        remote_agent_id: null,
        remote_project_path: '/remote/my-project',
        prefer_remote_tests: 1,
      });

      const router = createRemoteTestRouter({ agentRegistry: null, db: mockDb, logger });
      const result = router.getRemoteConfig('/some/path/my-project');
      expect(result).toBeNull();
    });

    it('should return config when prefer_remote_tests is set and agent_id exists', () => {
      const mockDb = createMockDb();
      const logger = createMockLogger();
      insertProjectConfig('my-project', {
        remote_agent_id: 'agent-1',
        remote_project_path: '/remote/my-project',
        prefer_remote_tests: 1,
      });

      const router = createRemoteTestRouter({ agentRegistry: null, db: mockDb, logger });
      const result = router.getRemoteConfig('/some/path/my-project');
      expect(result).toEqual({
        agentId: 'agent-1',
        remotePath: '/remote/my-project',
      });
    });

    it('should return null when db is null', () => {
      const logger = createMockLogger();
      const router = createRemoteTestRouter({ agentRegistry: null, db: null, logger });
      const result = router.getRemoteConfig('/some/path');
      expect(result).toBeNull();
    });

    it('should return null when workingDir is empty', () => {
      const mockDb = createMockDb();
      const logger = createMockLogger();
      const router = createRemoteTestRouter({ agentRegistry: null, db: mockDb, logger });
      const result = router.getRemoteConfig('');
      expect(result).toBeNull();
    });

    it('should use workingDir as remotePath when remote_project_path is null', () => {
      const mockDb = createMockDb();
      const logger = createMockLogger();
      insertProjectConfig('my-project', {
        remote_agent_id: 'agent-1',
        remote_project_path: null,
        prefer_remote_tests: 1,
      });

      const router = createRemoteTestRouter({ agentRegistry: null, db: mockDb, logger });
      const result = router.getRemoteConfig('/some/path/my-project');
      expect(result).toEqual({
        agentId: 'agent-1',
        remotePath: '/some/path/my-project',
      });
    });
  });

  // ── getCurrentBranch ─────────────────────────────────────
  describe('getCurrentBranch()', () => {
    it('should return a string', () => {
      const mockDb = createMockDb();
      const logger = createMockLogger();
      const router = createRemoteTestRouter({ agentRegistry: null, db: mockDb, logger });

      // Will either return real branch or 'main' fallback
      const branch = router.getCurrentBranch(process.cwd());
      expect(typeof branch).toBe('string');
      expect(branch.length).toBeGreaterThan(0);
    });

    it('should return main for an invalid directory', () => {
      const mockDb = createMockDb();
      const logger = createMockLogger();
      const router = createRemoteTestRouter({ agentRegistry: null, db: mockDb, logger });

      const branch = router.getCurrentBranch('/nonexistent/dir/12345');
      expect(branch).toBe('main');
    });
  });

  // ── runRemoteOrLocal ─────────────────────────────────────
  describe('runRemoteOrLocal()', () => {
    it('should fall back to local when no remote config exists', async () => {
      const mockDb = createMockDb();
      const logger = createMockLogger();
      const router = createRemoteTestRouter({ agentRegistry: null, db: mockDb, logger });

      const result = await router.runRemoteOrLocal('node', ['--version'], process.cwd());
      expect(result.remote).toBe(false);
      expect(result.success).toBe(true);
      expect(result.output).toContain('v');
      expect(result.exitCode).toBe(0);
      expect(typeof result.durationMs).toBe('number');
    });

    it('should fall back to local when agentRegistry is null', async () => {
      const mockDb = createMockDb();
      const logger = createMockLogger();
      insertProjectConfig('my-project', {
        remote_agent_id: 'agent-1',
        remote_project_path: '/remote/path',
        prefer_remote_tests: 1,
      });

      // Override getProjectFromPath to match
      mockDb.getProjectFromPath = () => 'my-project';

      const router = createRemoteTestRouter({ agentRegistry: null, db: mockDb, logger });
      const result = await router.runRemoteOrLocal('node', ['-e', 'process.exit(0)'], '/some/my-project');
      expect(result.remote).toBe(false);
    });

    it('should fall back to local when agent client is not available', async () => {
      const mockDb = createMockDb();
      const logger = createMockLogger();
      insertProjectConfig('my-project', {
        remote_agent_id: 'agent-1',
        remote_project_path: '/remote/path',
        prefer_remote_tests: 1,
      });
      mockDb.getProjectFromPath = () => 'my-project';

      const client = createMockClient({ available: false });
      const registry = createMockRegistry({ 'agent-1': client });

      const router = createRemoteTestRouter({ agentRegistry: registry, db: mockDb, logger });
      const result = await router.runRemoteOrLocal('node', ['-e', 'process.exit(0)'], '/some/my-project');
      expect(result.remote).toBe(false);
      expect(client._runCalls).toHaveLength(0);
    });

    it('should call agent when available and return remote result', async () => {
      const mockDb = createMockDb();
      const logger = createMockLogger();
      insertProjectConfig('my-project', {
        remote_agent_id: 'agent-1',
        remote_project_path: '/remote/my-project',
        prefer_remote_tests: 1,
      });
      mockDb.getProjectFromPath = () => 'my-project';

      const client = createMockClient({
        available: true,
        runResult: {
          success: true,
          output: 'remote test passed',
          error: '',
          exitCode: 0,
          durationMs: 123,
        },
      });
      const registry = createMockRegistry({ 'agent-1': client });

      const router = createRemoteTestRouter({ agentRegistry: registry, db: mockDb, logger });
      const result = await router.runRemoteOrLocal('npx', ['vitest', 'run'], '/some/my-project', { branch: 'dev' });

      expect(result.remote).toBe(true);
      expect(result.success).toBe(true);
      expect(result.output).toBe('remote test passed');
      expect(result.exitCode).toBe(0);
      expect(result.durationMs).toBe(123);

      // Verify sync was called
      expect(client._syncCalls).toHaveLength(1);
      expect(client._syncCalls[0].project).toBe('my-project');
      expect(client._syncCalls[0].branch).toBe('dev');

      // Verify run was called
      expect(client._runCalls).toHaveLength(1);
      expect(client._runCalls[0].command).toBe('npx');
      expect(client._runCalls[0].args).toEqual(['vitest', 'run']);
      expect(client._runCalls[0].opts.cwd).toBe('/remote/my-project');
    });

    it('should filter sensitive env variables before calling client.run()', async () => {
      const mockDb = createMockDb();
      const logger = createMockLogger();
      insertProjectConfig('my-project', {
        remote_agent_id: 'agent-1',
        remote_project_path: '/remote/my-project',
        prefer_remote_tests: 1,
      });
      mockDb.getProjectFromPath = () => 'my-project';

      const client = createMockClient({
        available: true,
        runResult: {
          success: true,
          output: 'remote test passed',
          error: '',
          exitCode: 0,
          durationMs: 30,
        },
      });
      const registry = createMockRegistry({ 'agent-1': client });

      const router = createRemoteTestRouter({ agentRegistry: registry, db: mockDb, logger });
      const result = await router.runRemoteOrLocal('node', ['-e', 'process.exit(0)'], '/some/my-project', {
        branch: 'dev',
        env: {
          API_KEY: 'should-filter',
          TOKEN: 'should-filter',
          PASSWORD: 'should-filter',
          DATABASE_URL: 'should-filter',
          SAFE_VAR: 'keep-me',
          OTHER_VAR: 'keep-me-too',
        },
      });

      expect(result.remote).toBe(true);
      expect(client._runCalls).toHaveLength(1);
      expect(client._runCalls[0].opts.env).toMatchObject({
        SAFE_VAR: 'keep-me',
        OTHER_VAR: 'keep-me-too',
      });
      expect(client._runCalls[0].opts.env.API_KEY).toBeUndefined();
      expect(client._runCalls[0].opts.env.TOKEN).toBeUndefined();
      expect(client._runCalls[0].opts.env.PASSWORD).toBeUndefined();
      expect(client._runCalls[0].opts.env.DATABASE_URL).toBeUndefined();
    });

    it('should pass through non-sensitive env variables', async () => {
      const mockDb = createMockDb();
      const logger = createMockLogger();
      insertProjectConfig('my-project', {
        remote_agent_id: 'agent-1',
        remote_project_path: '/remote/my-project',
        prefer_remote_tests: 1,
      });
      mockDb.getProjectFromPath = () => 'my-project';

      const client = createMockClient({
        available: true,
      });
      const registry = createMockRegistry({ 'agent-1': client });

      const router = createRemoteTestRouter({ agentRegistry: registry, db: mockDb, logger });
      const result = await router.runRemoteOrLocal('node', ['-e', 'process.exit(0)'], '/some/my-project', {
        branch: 'dev',
        env: {
          NODE_ENV: 'test',
          CUSTOM_VALUE: 'allowed',
        },
      });

      expect(result.remote).toBe(true);
      expect(client._runCalls[0].opts.env).toEqual({
        NODE_ENV: 'test',
        CUSTOM_VALUE: 'allowed',
      });
    });

    it('should pass undefined env as undefined to client.run()', async () => {
      const mockDb = createMockDb();
      const logger = createMockLogger();
      insertProjectConfig('my-project', {
        remote_agent_id: 'agent-1',
        remote_project_path: '/remote/my-project',
        prefer_remote_tests: 1,
      });
      mockDb.getProjectFromPath = () => 'my-project';

      const client = createMockClient({
        available: true,
      });
      const registry = createMockRegistry({ 'agent-1': client });

      const router = createRemoteTestRouter({ agentRegistry: registry, db: mockDb, logger });
      const result = await router.runRemoteOrLocal('node', ['-e', 'process.exit(0)'], '/some/my-project', {
        branch: 'dev',
      });

      expect(result.remote).toBe(true);
      expect(client._runCalls[0].opts.env).toBeUndefined();
    });

    it('should fall back to local when agent sync throws', async () => {
      const mockDb = createMockDb();
      const logger = createMockLogger();
      insertProjectConfig('my-project', {
        remote_agent_id: 'agent-1',
        remote_project_path: '/remote/my-project',
        prefer_remote_tests: 1,
      });
      mockDb.getProjectFromPath = () => 'my-project';

      const client = createMockClient({
        available: true,
        syncError: new Error('sync failed: connection refused'),
      });
      const registry = createMockRegistry({ 'agent-1': client });

      const router = createRemoteTestRouter({ agentRegistry: registry, db: mockDb, logger });
      const result = await router.runRemoteOrLocal('node', ['--version'], process.cwd());

      expect(result.remote).toBe(false);
      expect(result.success).toBe(true);
      expect(result.output).toContain('v');

      // Verify warning was logged
      const warnings = logger._logs.filter(l => l.level === 'warn');
      expect(warnings.length).toBeGreaterThanOrEqual(1);
      expect(warnings[0].msg).toContain('falling back to local');
    });

    it('should fall back to local when agent run throws', async () => {
      const mockDb = createMockDb();
      const logger = createMockLogger();
      insertProjectConfig('my-project', {
        remote_agent_id: 'agent-1',
        remote_project_path: '/remote/my-project',
        prefer_remote_tests: 1,
      });
      mockDb.getProjectFromPath = () => 'my-project';

      const client = createMockClient({
        available: true,
        runError: new Error('run failed: timeout'),
      });
      const registry = createMockRegistry({ 'agent-1': client });

      const router = createRemoteTestRouter({ agentRegistry: registry, db: mockDb, logger });
      const result = await router.runRemoteOrLocal('node', ['-e', 'process.exit(0)'], process.cwd());

      expect(result.remote).toBe(false);
    });

    it('should report failure for local commands that exit non-zero', async () => {
      const mockDb = createMockDb();
      const logger = createMockLogger();
      const router = createRemoteTestRouter({ agentRegistry: null, db: mockDb, logger });

      const result = await router.runRemoteOrLocal('node', ['-e', 'process.exit(42)'], process.cwd());
      expect(result.remote).toBe(false);
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(42);
    });

    it('should fall back to local when getClient returns null', async () => {
      const mockDb = createMockDb();
      const logger = createMockLogger();
      insertProjectConfig('my-project', {
        remote_agent_id: 'agent-1',
        remote_project_path: '/remote/my-project',
        prefer_remote_tests: 1,
      });
      mockDb.getProjectFromPath = () => 'my-project';

      // Registry returns null for the agent
      const registry = createMockRegistry({});

      const router = createRemoteTestRouter({ agentRegistry: registry, db: mockDb, logger });
      const result = await router.runRemoteOrLocal('node', ['-e', 'process.exit(0)'], '/some/my-project');
      expect(result.remote).toBe(false);
    });
  });

  // ── runVerifyCommand ─────────────────────────────────────
  describe('runVerifyCommand()', () => {
    it('should run compound commands as a single shell invocation', async () => {
      const mockDb = createMockDb();
      const logger = createMockLogger();
      const router = createRemoteTestRouter({ agentRegistry: null, db: mockDb, logger });

      const result = await router.runVerifyCommand(
        'node --version && node --version',
        process.cwd()
      );

      expect(result.success).toBe(true);
      // node --version outputs something like 'v22.x.x\n'
      expect(result.output).toContain('v');
      expect(result.exitCode).toBe(0);
      // Whole string runs as one shell invocation
      const infoLogs = logger._logs.filter(l => l.level === 'info' && l.msg.includes('Running locally'));
      expect(infoLogs).toHaveLength(1);
    });

    it('should stop on first failure', async () => {
      const mockDb = createMockDb();
      const logger = createMockLogger();
      const router = createRemoteTestRouter({ agentRegistry: null, db: mockDb, logger });

      const result = await router.runVerifyCommand(
        'node -e process.exit(1) && node --version',
        process.cwd()
      );

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      // Only one local run should have been logged (second command skipped)
      const infoLogs = logger._logs.filter(l => l.level === 'info' && l.msg.includes('Running locally'));
      expect(infoLogs).toHaveLength(1);
    });

    it('should handle single commands without &&', async () => {
      const mockDb = createMockDb();
      const logger = createMockLogger();
      const router = createRemoteTestRouter({ agentRegistry: null, db: mockDb, logger });

      const result = await router.runVerifyCommand(
        'node --version',
        process.cwd()
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain('v');
    });

    it('should accumulate duration across commands', async () => {
      const mockDb = createMockDb();
      const logger = createMockLogger();
      const router = createRemoteTestRouter({ agentRegistry: null, db: mockDb, logger });

      const result = await router.runVerifyCommand(
        'node -e "1" && node -e "2"',
        process.cwd()
      );

      expect(result.success).toBe(true);
      expect(typeof result.durationMs).toBe('number');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should route compound commands to remote as a single invocation', async () => {
      const mockDb = createMockDb();
      const logger = createMockLogger();
      insertProjectConfig('my-project', {
        remote_agent_id: 'agent-1',
        remote_project_path: '/remote/my-project',
        prefer_remote_tests: 1,
      });
      mockDb.getProjectFromPath = () => 'my-project';

      const client = createMockClient({ available: true });
      // Override run to track calls
      client.run = async function(command, args, opts) {
        this._runCalls.push({ command, args, opts });
        return {
          success: true,
          output: `remote-${this._runCalls.length}`,
          error: '',
          exitCode: 0,
          durationMs: 10,
        };
      };

      const registry = createMockRegistry({ 'agent-1': client });

      const router = createRemoteTestRouter({ agentRegistry: registry, db: mockDb, logger });
      const result = await router.runVerifyCommand(
        'npx tsc --noEmit && npx vitest run',
        '/some/my-project',
        { branch: 'main' }
      );

      expect(result.success).toBe(true);
      expect(result.remote).toBe(true);
      // Whole command string sent as single remote invocation
      expect(client._runCalls).toHaveLength(1);
    });

    it('should handle empty verify command gracefully', async () => {
      const mockDb = createMockDb();
      const logger = createMockLogger();
      const router = createRemoteTestRouter({ agentRegistry: null, db: mockDb, logger });

      const result = await router.runVerifyCommand('', process.cwd());
      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
    });
  });
});
