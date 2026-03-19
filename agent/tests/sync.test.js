import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEST_PORT = 13463;
const TEST_SECRET = 'test-secret-for-sync-tests';

let agentInstance;
let tempProjectRoot;

/**
 * POST JSON to the agent with auth header.
 * Returns { status, headers, body } with parsed JSON body.
 */
function postJSON(urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: urlPath,
        method: 'POST',
        headers: {
          'x-torque-secret': TEST_SECRET,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = data;
          }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * GET request to the agent with auth header.
 * Returns { status, headers, body } with parsed JSON body.
 */
function getJSON(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: urlPath,
        method: 'GET',
        headers: { 'x-torque-secret': TEST_SECRET },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = data;
          }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  // Create a temp directory to serve as project_root with a disposable git repo.
  // This avoids running git reset --hard on the real torque repo.
  tempProjectRoot = path.join(os.tmpdir(), `torque-sync-test-${Date.now()}`);
  fs.mkdirSync(tempProjectRoot, { recursive: true });

  // Create a bare "remote" repo to serve as origin (with main as default branch)
  const bareRepoPath = path.join(tempProjectRoot, 'test-repo.git');
  execFileSync('git', ['init', '--bare', '-b', 'main', bareRepoPath]);

  // Clone from the bare repo to create the working repo
  const workingRepoPath = path.join(tempProjectRoot, 'test-repo');
  execFileSync('git', ['clone', bareRepoPath, workingRepoPath]);

  // Add initial commit (checkout main explicitly since clone of empty repo may not set branch)
  execFileSync('git', ['checkout', '-b', 'main'], { cwd: workingRepoPath });
  fs.writeFileSync(path.join(workingRepoPath, 'README.md'), '# Test Repo\n');
  execFileSync('git', ['add', 'README.md'], { cwd: workingRepoPath });
  execFileSync('git', ['-c', 'user.email=test@test.com', '-c', 'user.name=Test',
    'commit', '-m', 'initial commit'], { cwd: workingRepoPath });
  execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: workingRepoPath });

  // Add a second commit so HEAD~1 diff works
  fs.writeFileSync(path.join(workingRepoPath, 'file2.txt'), 'hello\n');
  execFileSync('git', ['add', 'file2.txt'], { cwd: workingRepoPath });
  execFileSync('git', ['-c', 'user.email=test@test.com', '-c', 'user.name=Test',
    'commit', '-m', 'add file2'], { cwd: workingRepoPath });
  execFileSync('git', ['push', 'origin', 'main'], { cwd: workingRepoPath });

  // Start the agent server with project_root set to the temp directory
  const indexUrl = new URL('../index.js', import.meta.url).href;
  const { createServer } = await import(indexUrl);
  agentInstance = createServer({
    port: TEST_PORT,
    host: '127.0.0.1',
    secret: TEST_SECRET,
    project_root: tempProjectRoot,
    allowed_commands: ['node', 'npm', 'npx', 'git'],
    max_concurrent: 3,
  });
  await new Promise((resolve) => {
    agentInstance.server.on('listening', resolve);
  });
});

afterAll(async () => {
  if (agentInstance) {
    await agentInstance.close();
  }
  // Clean up temp directory — retry up to 3 times with a short delay to work
  // around Windows file locks that may still be held briefly after the server
  // has closed (e.g. git index files opened by child processes).
  if (tempProjectRoot) {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        fs.rmSync(tempProjectRoot, { recursive: true, force: true });
        break;
      } catch {
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        }
        // ignore on final attempt — temp dirs are cleaned up by the OS eventually
      }
    }
  }
});

describe('POST /sync endpoint', () => {
  it('syncs an existing git repo and returns 200 with status, commit, and duration_ms', async () => {
    const res = await postJSON('/sync', {
      project: 'test-repo',
      branch: 'main',
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('synced');
    expect(res.body.project).toBe('test-repo');
    expect(res.body.branch).toBe('main');
    // commit should be a short hex hash (7-12 chars)
    expect(res.body.commit).toMatch(/^[a-f0-9]{7,12}$/);
    expect(typeof res.body.duration_ms).toBe('number');
    expect(res.body.duration_ms).toBeGreaterThanOrEqual(0);
  }, 30000);

  it('defaults branch to main when not provided', async () => {
    const res = await postJSON('/sync', {
      project: 'test-repo',
    });

    expect(res.status).toBe(200);
    expect(res.body.branch).toBe('main');
  }, 30000);

  it('returns 404 for non-existent project without repo_url', async () => {
    const res = await postJSON('/sync', {
      project: 'nonexistent-project-xyz-12345',
    });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Project not found: nonexistent-project-xyz-12345');
    expect(res.body.error).toContain('Provide repo_url to clone');
  });

  it('returns 400 when project field is missing', async () => {
    const res = await postJSON('/sync', {
      branch: 'main',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Missing required field: project');
  });

  it('after sync, /health includes the project in projects', async () => {
    // Ensure a sync has happened
    const syncRes = await postJSON('/sync', {
      project: 'test-repo',
      branch: 'main',
    });
    expect(syncRes.status).toBe(200);

    // Check /health
    const healthRes = await getJSON('/health');
    expect(healthRes.status).toBe(200);
    expect(healthRes.body.projects).toBeDefined();
    expect(healthRes.body.projects['test-repo']).toBeDefined();
    expect(healthRes.body.projects['test-repo'].branch).toBe('main');
    expect(typeof healthRes.body.projects['test-repo'].last_sync).toBe('string');
    expect(healthRes.body.projects['test-repo'].path).toBeDefined();
  }, 30000);

  it('after sync, /projects returns the project with path, last_sync, and branch', async () => {
    // Ensure a sync has happened
    const syncRes = await postJSON('/sync', {
      project: 'test-repo',
      branch: 'main',
    });
    expect(syncRes.status).toBe(200);

    // Check /projects
    const projRes = await getJSON('/projects');
    expect(projRes.status).toBe(200);
    expect(projRes.body.projects).toBeDefined();

    const project = projRes.body.projects['test-repo'];
    expect(project).toBeDefined();
    expect(project.path).toBeDefined();
    expect(project.path).toContain('test-repo');
    expect(project.branch).toBe('main');
    expect(typeof project.last_sync).toBe('string');
    // last_sync should be a valid ISO date string
    expect(new Date(project.last_sync).toISOString()).toBe(project.last_sync);
  }, 30000);
});
