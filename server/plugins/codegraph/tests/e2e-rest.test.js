'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { setupTinyRepo, destroyTinyRepo } = require('../test-helpers');

const PORT = 3463;
const BASE = `http://127.0.0.1:${PORT}`;

let serverProc;
let repo;
let dataDir;

function fetchJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: opts.method || 'GET',
      headers: { 'content-type': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

async function waitForReady(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetchJson(`${BASE}/api/health`);
      if (r.status === 200) return;
    } catch { /* retry */ }
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error('server did not become ready');
}

describe.skipIf(process.env.CG_E2E !== '1')('codegraph end-to-end REST', () => {
  beforeAll(async () => {
    repo = setupTinyRepo('cg-e2e-');
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-data-'));
    serverProc = spawn(
      process.execPath,
      [path.join(__dirname, '..', '..', '..', 'index.js')],
      {
        env: {
          ...process.env,
          PORT: String(PORT),
          TORQUE_CODEGRAPH_ENABLED: '1',
          TORQUE_DATA_DIR: dataDir,
        },
        stdio: 'ignore',
      }
    );
    await waitForReady();
  }, 30000);

  afterAll(() => {
    if (serverProc) serverProc.kill('SIGTERM');
    destroyTinyRepo(repo);
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('reindex → find-references end-to-end via REST', async () => {
    const r1 = await fetchJson(`${BASE}/api/v2/codegraph/reindex`, {
      method: 'POST',
      body: { repo_path: repo, async: false },
    });
    expect(r1.status).toBe(200);

    const r2 = await fetchJson(`${BASE}/api/v2/codegraph/find-references`, {
      method: 'POST',
      body: { repo_path: repo, symbol: 'beta' },
    });
    expect(r2.status).toBe(200);
    expect(r2.body.some((x) => x.callerSymbol === 'alpha')).toBe(true);
  });
});
