'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createServer } = require('../agent-server');
const { RemoteAgentClient } = require('../agent-client');
const { createHandlers } = require('../handlers');

const TEST_SECRET = 'remote-test-integration-secret';

function canSpawnCommands() {
  try {
    const { spawnSync } = require('node:child_process');
    const result = spawnSync(process.execPath, ['-e', 'process.exit(0)'], {
      windowsHide: true,
    });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

function waitForListening(server) {
  return new Promise((resolve, reject) => {
    if (server.listening) {
      resolve();
      return;
    }
    server.once('listening', resolve);
    server.once('error', reject);
  });
}

function createAvailableRegistry(agent, client) {
  return {
    getAvailable: vi.fn(() => (client.isAvailable() ? [{ ...agent }] : [])),
    getAll: vi.fn(() => (client.isAvailable() ? [{ ...agent }] : [])),
    getClient: vi.fn((id) => (id === agent.id ? client : null)),
  };
}

function createUnavailableRegistry() {
  return {
    getAvailable: vi.fn(() => []),
    getAll: vi.fn(() => []),
    getClient: vi.fn(() => null),
  };
}

describe.skipIf(process.env.CI === 'true' || !canSpawnCommands())('remote test execution integration', { timeout: 20000 }, () => {
  let server;
  let port;
  let projectsDir;
  let workingDir;

  beforeAll(async () => {
    projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-remote-agent-projects-'));
    server = createServer({
      secret: TEST_SECRET,
      projectsDir,
    });
    // Allow shell wrappers used by _buildShellInvocation on each platform
    // (cmd.exe on Windows, /bin/sh on Unix) since handleRunRemoteCommand
    // wraps the command string in a platform shell before calling client.run().
    server.torqueAgent.state.config = {
      allowed_commands: ['node', 'npm', 'npx', 'git', 'dotnet', 'cargo', 'python', 'python3', 'cmd', 'sh'],
    };
    server.listen(0, '127.0.0.1');
    await waitForListening(server);
    port = server.address().port;
  });

  beforeEach(() => {
    // Must be inside projectsDir so agent-server's allowed_roots check passes.
    workingDir = fs.mkdtempSync(path.join(projectsDir, 'run-'));
  });

  afterEach(() => {
    if (workingDir && fs.existsSync(workingDir)) {
      fs.rmSync(workingDir, { recursive: true, force: true });
    }
    workingDir = null;
  });

  afterAll(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (projectsDir && fs.existsSync(projectsDir)) {
      fs.rmSync(projectsDir, { recursive: true, force: true });
    }
  });

  it('routes handleRunRemoteCommand through the agent client and parses NDJSON output', async () => {
    fs.writeFileSync(
      path.join(workingDir, 'remote-flow.js'),
      [
        "process.stdout.write('remote-stdout\\n');",
        "process.stderr.write('remote-stderr\\n');",
      ].join('\n'),
      'utf8'
    );

    const client = new RemoteAgentClient({
      host: '127.0.0.1',
      port,
      secret: TEST_SECRET,
    });
    const registry = createAvailableRegistry({
      id: 'agent-1',
      name: 'Integration Agent',
      status: 'healthy',
      enabled: true,
    }, client);
    const handlers = createHandlers({ agentRegistry: registry });

    const health = await client.checkHealth();
    expect(health).toMatchObject({
      status: 'healthy',
      running_tasks: expect.any(Number),
      max_concurrent: expect.any(Number),
    });

    const result = await handlers.run_remote_command({
      command: 'node remote-flow.js',
      working_directory: workingDir,
      timeout: 5000,
    });

    expect(registry.getAvailable).toHaveBeenCalledTimes(1);
    expect(registry.getClient).toHaveBeenCalledWith('agent-1');
    expect(result.isError).not.toBe(true);
    expect(result.remote).toBe(true);
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('remote-stdout\n');
    expect(result.error).toBe('remote-stderr\n');
    expect(result.content[0].text).toContain('[remote: Integration Agent] Exit code: 0');
    expect(result.content[0].text).toContain('remote-stdout');
    expect(result.content[0].text).toContain('remote-stderr');
  });

  it('falls back to local execution when no agent is available', async () => {
    fs.writeFileSync(
      path.join(workingDir, 'local-fallback.js'),
      "console.log('local-fallback-ok');\n",
      'utf8'
    );

    const registry = createUnavailableRegistry();
    const handlers = createHandlers({ agentRegistry: registry });

    const result = await handlers.run_remote_command({
      command: 'node local-fallback.js',
      working_directory: workingDir,
      timeout: 5000,
    });

    expect(registry.getAvailable).toHaveBeenCalledTimes(1);
    expect(registry.getClient).not.toHaveBeenCalled();
    expect(result.isError).not.toBe(true);
    expect(result.remote).toBe(false);
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('local-fallback-ok');
    expect(result.warning).toBe('Remote agent unavailable; command ran locally.');
    expect(result.content[0].text).toContain('[local fallback] Exit code: 0');
    expect(result.content[0].text).toContain('local-fallback-ok');
  });
});
