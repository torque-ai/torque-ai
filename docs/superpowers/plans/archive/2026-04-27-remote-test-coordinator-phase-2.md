# Remote Test Coordinator — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn on result sharing so that when session B asks for a `(project, sha, suite)` that session A just finished or is mid-execution, B replays A's exit code + output instead of running the same tests over again.

**Architecture:** Phase 1 already writes completed results to `~/.torque-coord/results/<project>/<sha>/<suite>.json` with stored `package_lock_hashes` and `completed_at`. Phase 2 turns the read path on: client computes lock-hashes locally, wrapper does a pre-acquire `GET /results` check, and re-checks again after a `wait` returns. Daemon stays simple — it just enforces TTL and returns records; the client compares its own hashes against the stored ones to decide whether the result is still valid.

**Tech Stack:** Node.js (CommonJS), native `http` module, vitest, bash for `bin/torque-remote`.

**Source spec:** `docs/superpowers/specs/2026-04-27-remote-test-coordinator-design.md` (sections 5.7, 6 paths 2/3/4, 7 hash-mismatch row).

**Phase 1 reference:** `docs/superpowers/plans/2026-04-27-remote-test-coordinator-phase-1.md` — already shipped to main.

---

## File structure

```
server/coord/
  lock-hashes.js     # NEW: computeLockHashes(projectRoot) → {relative_path: sha256}
  result-store.js    # MODIFY: getResult enforces TTL, returns full record (was stub)
  http.js            # MODIFY: /results validates project/sha/suite path components

server/tests/
  coord-lock-hashes.test.js          # NEW
  coord-result-store.test.js         # MODIFY: add TTL + invalidation tests
  coord-http.test.js                 # MODIFY: add /results 200 hit + path-validation tests
  coord-client-cli.test.js           # MODIFY: add lock-hashes subcommand test
  coord-torque-remote-integration.test.js  # MODIFY: warm-hit + post-wait paths

bin/
  torque-coord-client               # MODIFY: new lock-hashes subcommand; results returns body verbatim
  torque-remote                     # MODIFY: pre-acquire results check, hash on release, post-wait re-check
```

**Out of scope for Phase 2 (deferred to Phase 2.5 or Phase 3):**
- Server-side share-eligibility / `consumed` SSE event — client-side post-wait re-check is sufficient and simpler.
- `queue_position` SSE events — Phase 1's `sleep 5 + retry` for `global_semaphore_full` is acceptable; better visibility belongs in the Phase 3 dashboard mirror.
- Cross-machine ssh-tunneling — also Phase 3.

---

## Task 1: lock-hashes module

**Files:**
- Create: `server/coord/lock-hashes.js`
- Test: `server/tests/coord-lock-hashes.test.js`

The module discovers all `package-lock.json` files under a project root (depth ≤ 3, excluding `node_modules`) and returns a map of `{relative_path: sha256}`. Used by the client to capture lock state on release and to recheck on result hits.

- [ ] **Step 1: Write the failing test**

Create `server/tests/coord-lock-hashes.test.js`:

```javascript
'use strict';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { computeLockHashes } = require('../coord/lock-hashes');

describe('coord lock-hashes', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-locks-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty object when no package-lock.json files exist', () => {
    const hashes = computeLockHashes(tmpDir);
    expect(hashes).toEqual({});
  });

  it('hashes a single root package-lock.json', () => {
    fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), '{"lockfileVersion":3}');
    const hashes = computeLockHashes(tmpDir);
    expect(Object.keys(hashes)).toEqual(['package-lock.json']);
    expect(hashes['package-lock.json']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes multiple subdir package-lock.json files (depth ≤ 3)', () => {
    fs.mkdirSync(path.join(tmpDir, 'server'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'dashboard'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), 'a');
    fs.writeFileSync(path.join(tmpDir, 'server', 'package-lock.json'), 'b');
    fs.writeFileSync(path.join(tmpDir, 'dashboard', 'package-lock.json'), 'c');
    const hashes = computeLockHashes(tmpDir);
    expect(Object.keys(hashes).sort()).toEqual([
      'dashboard/package-lock.json',
      'package-lock.json',
      'server/package-lock.json',
    ]);
  });

  it('skips package-lock.json inside node_modules', () => {
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'foo'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'foo', 'package-lock.json'), 'inner');
    fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), 'root');
    const hashes = computeLockHashes(tmpDir);
    expect(Object.keys(hashes)).toEqual(['package-lock.json']);
  });

  it('skips files deeper than 3 levels from root', () => {
    const deep = path.join(tmpDir, 'a', 'b', 'c', 'd');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'package-lock.json'), 'too deep');
    const hashes = computeLockHashes(tmpDir);
    expect(hashes).toEqual({});
  });

  it('returns deterministic hashes (same content → same hash)', () => {
    fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), 'identical content');
    const a = computeLockHashes(tmpDir);
    const b = computeLockHashes(tmpDir);
    expect(a).toEqual(b);
  });

  it('uses POSIX-style relative paths even on Windows', () => {
    fs.mkdirSync(path.join(tmpDir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'sub', 'package-lock.json'), 'x');
    const hashes = computeLockHashes(tmpDir);
    const keys = Object.keys(hashes);
    expect(keys).toContain('sub/package-lock.json');
    for (const k of keys) {
      expect(k).not.toContain('\\');
    }
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `cd server && node node_modules/vitest/vitest.mjs run tests/coord-lock-hashes.test.js`

Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

Create `server/coord/lock-hashes.js`:

```javascript
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_DEPTH = 3;
const TARGET_FILENAME = 'package-lock.json';
const SKIP_DIRS = new Set(['node_modules', '.git', '.worktrees']);

function walk(dir, root, depth, out) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_err) {
    return; // unreadable subdir — skip
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), root, depth + 1, out);
    } else if (entry.isFile() && entry.name === TARGET_FILENAME) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      try {
        const buf = fs.readFileSync(abs);
        out[rel] = crypto.createHash('sha256').update(buf).digest('hex');
      } catch (_err) {
        // unreadable file — skip
      }
    }
  }
}

function computeLockHashes(projectRoot) {
  const out = {};
  walk(projectRoot, projectRoot, 0, out);
  return out;
}

module.exports = { computeLockHashes };
```

- [ ] **Step 4: Run test — verify it passes**

Run: `cd server && node node_modules/vitest/vitest.mjs run tests/coord-lock-hashes.test.js`

Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/coord/lock-hashes.js server/tests/coord-lock-hashes.test.js
git commit -m "feat(coord): lock-hashes module — sha256 per package-lock.json under projectRoot"
```

---

## Task 2: result-store TTL + read path

**Files:**
- Modify: `server/coord/result-store.js`
- Modify: `server/tests/coord-result-store.test.js`

Phase 1 stubbed `getResult` to always return null. Phase 2 enables it: read the on-disk record, return it if within `result_ttl_seconds`, else return null. The client (not the daemon) compares `package_lock_hashes` — keeping the daemon dumb.

- [ ] **Step 1: Update the existing test file to cover the read path**

Open `server/tests/coord-result-store.test.js`. The existing third test (`getResult always returns null in Phase 1 (stub)`) will be replaced. Find:

```javascript
  it('getResult always returns null in Phase 1 (stub)', () => {
    store.writeResult({
      project: 'torque-public', sha: 'abc', suite: 'gate',
      exit_code: 0, suite_status: 'pass', output_tail: 'ok',
    });
    expect(store.getResult({ project: 'torque-public', sha: 'abc', suite: 'gate' })).toBeNull();
  });
```

Replace with:

```javascript
  it('getResult returns the stored record when within TTL', () => {
    store.writeResult({
      project: 'torque-public', sha: 'abc', suite: 'gate',
      exit_code: 0, suite_status: 'pass', output_tail: 'ok',
      package_lock_hashes: { 'server/package-lock.json': 'deadbeef' },
    });
    const hit = store.getResult({ project: 'torque-public', sha: 'abc', suite: 'gate' });
    expect(hit).not.toBeNull();
    expect(hit).toMatchObject({
      project: 'torque-public',
      sha: 'abc',
      suite: 'gate',
      exit_code: 0,
      suite_status: 'pass',
      output_tail: 'ok',
      package_lock_hashes: { 'server/package-lock.json': 'deadbeef' },
    });
    expect(hit.completed_at).toBeDefined();
  });

  it('getResult returns null when the record is older than TTL', () => {
    const shortTtlStore = createResultStore({ results_dir: tmpDir, result_ttl_seconds: 1 });
    shortTtlStore.writeResult({
      project: 'torque-public', sha: 'abc', suite: 'gate',
      exit_code: 0, suite_status: 'pass', output_tail: 'ok',
    });
    // Backdate the on-disk record so it's clearly past TTL.
    const file = path.join(tmpDir, 'torque-public', 'abc', 'gate.json');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    record.completed_at = new Date(Date.now() - 10_000).toISOString();
    fs.writeFileSync(file, JSON.stringify(record));
    expect(shortTtlStore.getResult({ project: 'torque-public', sha: 'abc', suite: 'gate' })).toBeNull();
  });

  it('getResult returns null when the record file does not exist', () => {
    expect(store.getResult({ project: 'torque-public', sha: 'never', suite: 'gate' })).toBeNull();
  });

  it('getResult returns null on unparseable record (corrupt file)', () => {
    const dir = path.join(tmpDir, 'torque-public', 'sha');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'gate.json'), '{ corrupt');
    expect(store.getResult({ project: 'torque-public', sha: 'sha', suite: 'gate' })).toBeNull();
  });
```

(The two earlier tests `writeResult creates a JSON file ...` and `writeResult is a no-op for crashed runs` stay unchanged.)

- [ ] **Step 2: Run test — verify the new ones fail**

Run: `cd server && node node_modules/vitest/vitest.mjs run tests/coord-result-store.test.js`

Expected: 4 new tests (return-record, ttl-expiry, missing-file, corrupt-file) FAIL because `getResult` still returns null.

- [ ] **Step 3: Implement the read path**

Replace `server/coord/result-store.js` with:

```javascript
'use strict';
const fs = require('fs');
const path = require('path');

function createResultStore(config) {
  const root = config.results_dir;
  const ttlMs = (config.result_ttl_seconds || 3600) * 1000;

  function writeResult(record) {
    if (record.crashed) return; // never share crashed runs
    const dir = path.join(root, record.project, record.sha);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${record.suite}.json`);
    const payload = {
      project: record.project,
      sha: record.sha,
      suite: record.suite,
      exit_code: record.exit_code,
      suite_status: record.suite_status,
      output_tail: record.output_tail || '',
      package_lock_hashes: record.package_lock_hashes || {},
      completed_at: new Date().toISOString(),
    };
    fs.writeFileSync(file + '.tmp', JSON.stringify(payload));
    fs.renameSync(file + '.tmp', file);
  }

  function getResult({ project, sha, suite }) {
    const file = path.join(root, project, sha, `${suite}.json`);
    if (!fs.existsSync(file)) return null;
    let record;
    try {
      record = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_err) {
      return null; // corrupt — treat as miss
    }
    if (!record.completed_at) return null;
    const age = Date.now() - Date.parse(record.completed_at);
    if (Number.isNaN(age) || age > ttlMs) return null;
    return record;
  }

  return { writeResult, getResult };
}

module.exports = { createResultStore };
```

- [ ] **Step 4: Run test — verify all pass**

Run: `cd server && node node_modules/vitest/vitest.mjs run tests/coord-result-store.test.js`

Expected: 6 tests pass (2 original + 4 new).

- [ ] **Step 5: Commit**

```bash
git add server/coord/result-store.js server/tests/coord-result-store.test.js
git commit -m "feat(coord): result-store getResult enforces TTL + returns full record"
```

---

## Task 3: HTTP /results path-traversal hardening

**Files:**
- Modify: `server/coord/http.js`
- Modify: `server/tests/coord-http.test.js`

Phase 1's `/results/:project/:sha/:suite` handler trusts the path components verbatim. With the read path now turned on, a malicious `?suite=../../../etc/passwd`-style request could read files outside the results dir. Validate that each path component is a simple identifier (`^[a-zA-Z0-9._-]+$`).

- [ ] **Step 1: Update the existing http test for /results**

Open `server/tests/coord-http.test.js`. The current `/results 404` test stays; add three new tests after it (or wherever appropriate inside the `describe('coord http server', ...)` block):

```javascript
  it('GET /results returns 200 with the cached record when present', async () => {
    const tmpDir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'coord-http-results-'));
    const writingStore = require('../coord/result-store').createResultStore({
      results_dir: tmpDir, result_ttl_seconds: 3600,
    });
    writingStore.writeResult({
      project: 'torque-public', sha: 'abc', suite: 'gate',
      exit_code: 0, suite_status: 'pass', output_tail: 'ok',
      package_lock_hashes: { 'server/package-lock.json': 'deadbeef' },
    });
    const newResults = require('../coord/result-store').createResultStore({
      results_dir: tmpDir, result_ttl_seconds: 3600,
    });
    await new Promise((r) => server.close(r));
    server = createServer({ state, results: newResults, config: { protocol_version: 1 } });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;

    const res = await request(port, 'GET', '/results/torque-public/abc/gate');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      project: 'torque-public',
      sha: 'abc',
      suite: 'gate',
      exit_code: 0,
      package_lock_hashes: { 'server/package-lock.json': 'deadbeef' },
    });
    require('fs').rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /results rejects path-traversal attempts with 400', async () => {
    const traversal = await request(port, 'GET', '/results/..%2F..%2Fetc/abc/gate');
    expect(traversal.status).toBe(400);
    const slashSuite = await request(port, 'GET', '/results/torque-public/abc/gate%2F..');
    expect(slashSuite.status).toBe(400);
  });

  it('GET /results rejects empty path components with 400', async () => {
    const res = await request(port, 'GET', '/results//abc/gate');
    expect(res.status).toBe(400);
  });
```

- [ ] **Step 2: Run test — verify the new ones fail**

Run: `cd server && node node_modules/vitest/vitest.mjs run tests/coord-http.test.js`

Expected: existing tests pass; the 3 new tests FAIL (404 returned where 200 expected; path traversal not yet rejected).

- [ ] **Step 3: Update `handleResults` in `server/coord/http.js`**

In `server/coord/http.js`, find the existing `handleResults` function:

```javascript
  function handleResults(_req, res, parts) {
    if (parts.length < 5) return sendJson(res, 400, { error: 'bad_path' });
    const project = parts[2];
    const sha = parts[3];
    const suite = parts[4];
    const hit = results.getResult({ project, sha, suite });
    if (!hit) return sendJson(res, 404, { hit: false });
    return sendJson(res, 200, hit);
  }
```

Replace with:

```javascript
  // Path components are part of the on-disk file path under results_dir.
  // Refuse anything that isn't a simple identifier so a request can't
  // escape the results tree via `../`, slashes, NUL bytes, etc.
  const SAFE_COMPONENT = /^[a-zA-Z0-9._-]+$/;

  function handleResults(_req, res, parts) {
    if (parts.length < 5) return sendJson(res, 400, { error: 'bad_path' });
    const project = parts[2];
    const sha = parts[3];
    const suite = parts[4];
    if (!project || !sha || !suite
        || !SAFE_COMPONENT.test(project)
        || !SAFE_COMPONENT.test(sha)
        || !SAFE_COMPONENT.test(suite)) {
      return sendJson(res, 400, { error: 'bad_path_component' });
    }
    const hit = results.getResult({ project, sha, suite });
    if (!hit) return sendJson(res, 404, { hit: false });
    return sendJson(res, 200, hit);
  }
```

- [ ] **Step 4: Run test — verify all pass**

Run: `cd server && node node_modules/vitest/vitest.mjs run tests/coord-http.test.js`

Expected: all tests pass (8 original + 3 new = 11).

- [ ] **Step 5: Commit**

```bash
git add server/coord/http.js server/tests/coord-http.test.js
git commit -m "feat(coord): /results path-traversal hardening + 200-hit support"
```

---

## Task 4: Client `lock-hashes` subcommand

**Files:**
- Modify: `bin/torque-coord-client`
- Modify: `server/tests/coord-client-cli.test.js`

Add a `lock-hashes` subcommand that prints the local hashes JSON. It accepts `--root <dir>` (defaults to `process.cwd()`).

- [ ] **Step 1: Add the failing tests**

Append to `server/tests/coord-client-cli.test.js` inside the existing `describe('torque-coord-client CLI', () => { ... })`:

```javascript
  it('lock-hashes subcommand prints the {relative_path: sha256} map for a project root', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-cli-locks-'));
    fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), '{}');
    fs.mkdirSync(path.join(tmpDir, 'server'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'server', 'package-lock.json'), '{}');
    try {
      const result = runClient(['lock-hashes', '--root', tmpDir], 9395);
      expect(result.status).toBe(0);
      const body = JSON.parse(result.stdout);
      expect(Object.keys(body).sort()).toEqual([
        'package-lock.json',
        'server/package-lock.json',
      ]);
      for (const v of Object.values(body)) {
        expect(v).toMatch(/^[0-9a-f]{64}$/);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('lock-hashes defaults --root to process.cwd() when omitted', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-cli-locks-cwd-'));
    fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), '{}');
    try {
      const result = require('child_process').spawnSync('node', [CLIENT, 'lock-hashes'], {
        cwd: tmpDir,
        env: { ...process.env, TORQUE_COORD_PORT: '9395' },
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      const body = JSON.parse(result.stdout);
      expect(Object.keys(body)).toEqual(['package-lock.json']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run tests — verify the new ones fail**

Run: `cd server && node node_modules/vitest/vitest.mjs run tests/coord-client-cli.test.js`

Expected: 2 new tests fail (`unknown subcommand: lock-hashes`).

- [ ] **Step 3: Add the subcommand to `bin/torque-coord-client`**

In `bin/torque-coord-client`, add a new `case 'lock-hashes':` branch inside the `switch (subcommand)` block. Insert it BEFORE the `default:` arm:

```javascript
      case 'lock-hashes': {
        const root = args.root || process.cwd();
        const { computeLockHashes } = require('../server/coord/lock-hashes');
        emit(computeLockHashes(root));
        process.exit(0);
        break;
      }
```

- [ ] **Step 4: Run tests — verify all pass**

Run: `cd server && node node_modules/vitest/vitest.mjs run tests/coord-client-cli.test.js`

Expected: all CLI tests pass (5 original + 2 new = 7).

- [ ] **Step 5: Commit**

```bash
git add bin/torque-coord-client server/tests/coord-client-cli.test.js
git commit -m "feat(coord-client): lock-hashes subcommand for hash-aware result invalidation"
```

---

## Task 5: bin/torque-remote — pre-acquire results check + post-wait re-check + hashes on release

**Files:**
- Modify: `bin/torque-remote`
- Modify: `bin/torque-coord-client`
- Modify: `server/tests/coord-torque-remote-integration.test.js`

Three changes in the wrapper:
1. **Before acquire:** `coord-client results --project P --sha S --suite SUITE`. If hit + stored hashes match local computed hashes + suite is shareable, replay `output_tail` and exit `exit_code`.
2. **On release:** compute local lock hashes via `coord-client lock-hashes`, pass them as `--hashes <json>` to `coord-client release`.
3. **After wait stream returns:** re-check `/results` (the holder may have just written a record matching our intent). If hit + hashes match, replay + exit.

Local hashes are computed once per wrapper invocation and cached in a shell variable so the pre-acquire and post-wait checks compare against the same snapshot.

- [ ] **Step 1: Add the failing test (warm hit)**

Append to `server/tests/coord-torque-remote-integration.test.js` inside the existing `describe('torque-remote coord integration', () => { ... })`:

```javascript
  it('replays cached result on warm hit, skipping acquire and command execution', async () => {
    makeConfig(tmpDir);
    const fs = require('fs');
    const path = require('path');
    const resultsDir = path.join(tmpDir, '.torque-coord', 'results');
    const projectRoot = path.join(tmpDir, 'tr-coord');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'package-lock.json'), '{}');
    fs.writeFileSync(path.join(projectRoot, '.torque-remote.json'), JSON.stringify({
      transport: 'local', intercept_commands: [],
    }));
    const projectHashes = require('../coord/lock-hashes').computeLockHashes(projectRoot);

    const shaDir = path.join(resultsDir, 'tr-coord', 'HEAD');
    fs.mkdirSync(shaDir, { recursive: true });
    fs.writeFileSync(path.join(shaDir, 'gate.json'), JSON.stringify({
      project: 'tr-coord', sha: 'HEAD', suite: 'gate',
      exit_code: 0, suite_status: 'pass', output_tail: 'CACHED RESULT REPLAY\n',
      package_lock_hashes: projectHashes,
      completed_at: new Date().toISOString(),
    }));

    // Stub daemon serves real /results, refuses /acquire (would fail the test
    // if the wrapper attempts it).
    const handlerSource = `
      const fs = require('fs');
      const path = require('path');
      const RESULTS_DIR = ${JSON.stringify(resultsDir)};
      (req, res) => {
        if (req.url.startsWith('/results/')) {
          const parts = req.url.split('/');
          const file = path.join(RESULTS_DIR, parts[2], parts[3], parts[4] + '.json');
          if (fs.existsSync(file)) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(fs.readFileSync(file, 'utf8'));
          } else {
            res.writeHead(404).end();
          }
          return;
        }
        if (req.url === '/acquire') {
          res.writeHead(500).end();
          return;
        }
        res.writeHead(404).end();
      }
    `;
    stub = await spawnStubDaemon(tmpDir, handlerSource);

    const result = spawnTorqueRemote(['--suite', 'gate', '--branch', 'HEAD', 'echo', 'should-not-run'], {
      TORQUE_COORD_PORT: String(stub.port),
      HOME: tmpDir,
    }, projectRoot);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('CACHED RESULT REPLAY');
    expect(result.stdout).not.toContain('should-not-run');
    expect(result.stderr).toContain('[torque-coord] cache hit');
  });

  it('skips warm hit when stored hashes do not match local hashes', async () => {
    makeConfig(tmpDir);
    const fs = require('fs');
    const path = require('path');
    const resultsDir = path.join(tmpDir, '.torque-coord', 'results');
    const projectRoot = path.join(tmpDir, 'tr-coord');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'package-lock.json'), 'local content');
    fs.writeFileSync(path.join(projectRoot, '.torque-remote.json'), JSON.stringify({
      transport: 'local', intercept_commands: [],
    }));

    const shaDir = path.join(resultsDir, 'tr-coord', 'HEAD');
    fs.mkdirSync(shaDir, { recursive: true });
    fs.writeFileSync(path.join(shaDir, 'gate.json'), JSON.stringify({
      project: 'tr-coord', sha: 'HEAD', suite: 'gate',
      exit_code: 0, suite_status: 'pass', output_tail: 'STALE\n',
      package_lock_hashes: { 'package-lock.json': 'deadbeef-mismatch' },
      completed_at: new Date().toISOString(),
    }));

    const handlerSource = `
      const fs = require('fs');
      const path = require('path');
      const RESULTS_DIR = ${JSON.stringify(resultsDir)};
      (req, res) => {
        if (req.url.startsWith('/results/')) {
          const parts = req.url.split('/');
          const file = path.join(RESULTS_DIR, parts[2], parts[3], parts[4] + '.json');
          if (fs.existsSync(file)) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(fs.readFileSync(file, 'utf8'));
          } else {
            res.writeHead(404).end();
          }
          return;
        }
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          if (req.url === '/acquire') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ acquired: true, lock_id: 'fresh' }));
          } else if (req.url === '/release' || req.url === '/heartbeat') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ released: true, ok: true }));
          } else {
            res.writeHead(404).end();
          }
        });
      }
    `;
    stub = await spawnStubDaemon(tmpDir, handlerSource);

    const result = spawnTorqueRemote(['--suite', 'gate', '--branch', 'HEAD', 'echo', 'fresh-run'], {
      TORQUE_COORD_PORT: String(stub.port),
      HOME: tmpDir,
    }, projectRoot);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('fresh-run');
    expect(result.stdout).not.toContain('STALE');
    expect(result.stderr).toContain('[torque-coord] hash mismatch');
  });
```

- [ ] **Step 2: Run tests — verify the new ones fail**

Run: `cd server && node node_modules/vitest/vitest.mjs run tests/coord-torque-remote-integration.test.js`

Expected: 2 new tests fail (warm-hit not implemented; mismatch logic not present).

- [ ] **Step 3: Update the client `release` subcommand to accept `--hashes`**

In `bin/torque-coord-client`, find the `case 'release':` body and replace it:

```javascript
      case 'release': {
        let parsedHashes = {};
        if (args.hashes) {
          try { parsedHashes = JSON.parse(args.hashes); }
          catch (_e) { parsedHashes = {}; }
        }
        const body = {
          lock_id: args['lock-id'],
          exit_code: parseInt(args.exit || '0', 10),
          suite_status: args.status || 'unknown',
          output_tail: args.tail || '',
          package_lock_hashes: parsedHashes,
        };
        const r = await request({ method: 'POST', path: '/release', body });
        emit(r.body);
        process.exit(r.status === 200 ? 0 : 1);
        break;
      }
```

- [ ] **Step 4: Modify `bin/torque-remote`**

Find the existing coord acquire block (begins with the comment `# ─── Coord acquire (best-effort, opt-in via --suite) ───`). Locate the `coord_attempt_acquire` function. Add the helpers and wire them in:

**4a. Insert helper functions ABOVE `coord_attempt_acquire`:**

```bash
COORD_LOCAL_HASHES=""
coord_compute_local_hashes() {
  if [[ -n "$COORD_LOCAL_HASHES" ]]; then return; fi
  local out
  out=$(node "$SCRIPT_DIR/torque-coord-client" lock-hashes --root "$PROJECT_ROOT" 2>/dev/null) || out="{}"
  COORD_LOCAL_HASHES="$out"
}

coord_hashes_match() {
  # $1: stored hashes JSON (from a result record)
  # Returns 0 (match) iff every key in stored matches the same key in local.
  # An empty stored map matches anything (back-compat with Phase-1 records).
  coord_compute_local_hashes
  node -e '
    const stored = JSON.parse(process.argv[1] || "{}");
    const local = JSON.parse(process.argv[2] || "{}");
    const storedKeys = Object.keys(stored);
    if (storedKeys.length === 0) process.exit(0);
    for (const k of storedKeys) {
      if (local[k] !== stored[k]) process.exit(1);
    }
    process.exit(0);
  ' "$1" "$COORD_LOCAL_HASHES" >/dev/null 2>&1
}

coord_check_warm_hit() {
  # Returns 0 (and prints the hit's output_tail to stdout, exits the script
  # with the hit's exit_code) when there's a fresh, hash-matching cached
  # result for our (project, sha, suite). Returns 1 otherwise.
  local hit_output rc
  hit_output=$(node "$SCRIPT_DIR/torque-coord-client" results \
    --project "$COORD_PROJECT" --sha "$COORD_SHA" --suite "$SUITE" 2>/dev/null)
  rc=$?
  if [[ $rc -ne 0 ]]; then return 1; fi
  if echo "$hit_output" | grep -q '"hit":false'; then return 1; fi
  local stored_hashes hit_exit hit_tail
  stored_hashes=$(node -e '
    try {
      const r = JSON.parse(process.argv[1]);
      process.stdout.write(JSON.stringify(r.package_lock_hashes || {}));
    } catch { process.stdout.write("{}"); }
  ' "$hit_output" 2>/dev/null)
  if ! coord_hashes_match "$stored_hashes"; then
    echo "[torque-coord] hash mismatch on cached result, running fresh" >&2
    return 1
  fi
  hit_exit=$(node -e '
    try { process.stdout.write(String(JSON.parse(process.argv[1]).exit_code ?? 1)); }
    catch { process.stdout.write("1"); }
  ' "$hit_output" 2>/dev/null)
  hit_tail=$(node -e '
    try { process.stdout.write(JSON.parse(process.argv[1]).output_tail || ""); }
    catch { process.stdout.write(""); }
  ' "$hit_output" 2>/dev/null)
  echo "[torque-coord] cache hit — replaying stored result (exit $hit_exit)" >&2
  printf "%s" "$hit_tail"
  exit "$hit_exit"
}
```

**4b. Call `coord_check_warm_hit` BEFORE `coord_attempt_acquire`.** Find the existing block:

```bash
if [[ "$SUITE" != "custom" ]]; then
  trap coord_release_on_exit EXIT
  coord_attempt_acquire || true
fi
```

Replace with:

```bash
if [[ "$SUITE" != "custom" ]]; then
  trap coord_release_on_exit EXIT
  coord_check_warm_hit || true
  # If coord_check_warm_hit found a hit it would have exit'd; falling through
  # means cache miss or coord unreachable → proceed to acquire.
  coord_attempt_acquire || true
fi
```

**4c. Pass local hashes to release.** Find `coord_release_on_exit`:

```bash
coord_release_on_exit() {
  local final_exit=$?
  if [[ "$COORD_ACQUIRED" -eq 1 && -n "$COORD_LOCK_ID" ]]; then
    node "$SCRIPT_DIR/torque-coord-client" release \
      --lock-id "$COORD_LOCK_ID" \
      --exit "$final_exit" \
      --status "$([[ $final_exit -eq 0 ]] && echo pass || echo fail)" \
      --tail "" \
      >/dev/null 2>&1 || true
  fi
  cleanup_on_exit
}
```

Replace with:

```bash
coord_release_on_exit() {
  local final_exit=$?
  if [[ "$COORD_ACQUIRED" -eq 1 && -n "$COORD_LOCK_ID" ]]; then
    coord_compute_local_hashes
    node "$SCRIPT_DIR/torque-coord-client" release \
      --lock-id "$COORD_LOCK_ID" \
      --exit "$final_exit" \
      --status "$([[ $final_exit -eq 0 ]] && echo pass || echo fail)" \
      --tail "" \
      --hashes "$COORD_LOCAL_HASHES" \
      >/dev/null 2>&1 || true
  fi
  cleanup_on_exit
}
```

**4d. Post-wait re-check.** Find inside `coord_attempt_acquire` the 202 wait-then-retry block:

```bash
  if [[ $rc -eq 3 ]]; then
    local wait_for
    wait_for=$(echo "$attempt_output" | sed -n 's/.*"wait_for":"\([^"]*\)".*/\1/p')
    if [[ -n "$wait_for" ]]; then
      echo "[torque-coord] waiting for in-flight run ($wait_for, attempt $attempt)…" >&2
      node "$SCRIPT_DIR/torque-coord-client" wait --lock-id "$wait_for" >/dev/null 2>&1 || true
      coord_attempt_acquire $((attempt + 1))
      return $?
    fi
```

Replace with:

```bash
  if [[ $rc -eq 3 ]]; then
    local wait_for
    wait_for=$(echo "$attempt_output" | sed -n 's/.*"wait_for":"\([^"]*\)".*/\1/p')
    if [[ -n "$wait_for" ]]; then
      echo "[torque-coord] waiting for in-flight run ($wait_for, attempt $attempt)…" >&2
      node "$SCRIPT_DIR/torque-coord-client" wait --lock-id "$wait_for" >/dev/null 2>&1 || true
      # The holder just released — they may have written a result for our
      # exact (project, sha, suite). Re-check before paying for our own run.
      coord_check_warm_hit || true
      coord_attempt_acquire $((attempt + 1))
      return $?
    fi
```

- [ ] **Step 5: Run tests — verify all pass**

Run: `cd server && node node_modules/vitest/vitest.mjs run tests/coord-torque-remote-integration.test.js`

Expected: all tests pass (4 original + 2 new = 6).

- [ ] **Step 6: Commit**

```bash
git add bin/torque-remote bin/torque-coord-client server/tests/coord-torque-remote-integration.test.js
git commit -m "feat(coord): warm-hit replay + hash-on-release + post-wait re-check"
```

---

## Task 6: End-to-end smoke for warm-hit

**Files:**
- Modify: `scripts/test-coord-e2e.sh`

Augment the smoke script with a second scenario that exercises the warm-hit path:
1. Run one `torque-remote --suite gate` to populate the result store.
2. Immediately run a second one with the same `--branch`. It should consume the cached result instead of running the inner command.

The existing "two parallel sessions serialize" test stays — both scenarios run.

- [ ] **Step 1: Replace the smoke script with the two-scenario version**

Replace `scripts/test-coord-e2e.sh` entirely with:

```bash
#!/usr/bin/env bash
# torque-coord end-to-end smoke test.
#
# Scenario A (Phase 1 — serialization):
#   Two `torque-remote --suite gate` invocations in parallel. The second
#   observes the first as the holder, waits, and re-acquires after.
#   Total wallclock should be ~2x single-session.
#
# Scenario B (Phase 2 — warm-hit replay):
#   Run one session to populate the result store, then a second session
#   with the same --branch. The second should consume the cached result
#   without invoking the inner command.

set -euo pipefail
cd "$(dirname "$0")/.."

REF="${1:-HEAD}"
echo "[e2e] Target ref: $REF"

# ─── Scenario A: serialization ────────────────────────────────────────────
echo
echo "── Scenario A: two parallel sessions serialize ───────────────"
OUT1=$(mktemp)
OUT2=$(mktemp)
start=$(date +%s)
(time torque-remote --suite gate --branch "$REF" bash -c "echo 'session A' && sleep 30") > "$OUT1" 2>&1 &
PID1=$!
sleep 2
(time torque-remote --suite gate --branch "$REF" bash -c "echo 'session B' && sleep 30") > "$OUT2" 2>&1 &
PID2=$!
wait $PID1
wait $PID2
end=$(date +%s)
duration=$((end - start))
echo "[e2e] Scenario A wallclock: ${duration}s (expected ~60s if serialized, ~30s if parallel)"
if [[ $duration -lt 50 ]]; then
  echo "[e2e] Scenario A FAIL: sessions appear to have run in parallel"
  rm -f "$OUT1" "$OUT2"
  exit 1
fi
echo "[e2e] Scenario A PASS: serialization observed."
rm -f "$OUT1" "$OUT2"

# ─── Scenario B: warm-hit replay ──────────────────────────────────────────
echo
echo "── Scenario B: warm-hit replay ──────────────────────────────"
OUT3=$(mktemp)
OUT4=$(mktemp)
torque-remote --suite gate --branch "$REF" bash -c "echo 'POPULATING' && sleep 5" > "$OUT3" 2>&1
start=$(date +%s)
torque-remote --suite gate --branch "$REF" bash -c "echo 'SHOULD-NOT-PRINT'" > "$OUT4" 2>&1
end=$(date +%s)
hit_duration=$((end - start))
echo "[e2e] Scenario B replay wallclock: ${hit_duration}s (expected <5s for replay; sync skipped)"
echo
echo "── Replay output ────────────────────────────────────────────"
cat "$OUT4"

if grep -q 'SHOULD-NOT-PRINT' "$OUT4"; then
  echo "[e2e] Scenario B FAIL: inner command ran instead of replay"
  rm -f "$OUT3" "$OUT4"
  exit 1
fi
if ! grep -q 'POPULATING' "$OUT4"; then
  echo "[e2e] Scenario B FAIL: cached output not replayed"
  rm -f "$OUT3" "$OUT4"
  exit 1
fi
if ! grep -q '\[torque-coord\] cache hit' "$OUT4"; then
  echo "[e2e] Scenario B FAIL: no cache-hit log line"
  rm -f "$OUT3" "$OUT4"
  exit 1
fi
if [[ $hit_duration -gt 10 ]]; then
  echo "[e2e] Scenario B FAIL: replay took ${hit_duration}s (>10s suggests sync still ran)"
  rm -f "$OUT3" "$OUT4"
  exit 1
fi

echo "[e2e] Scenario B PASS: warm-hit replay observed."
rm -f "$OUT3" "$OUT4"

echo
echo "[e2e] All scenarios PASS."
```

- [ ] **Step 2: Commit**

```bash
git add scripts/test-coord-e2e.sh
git commit -m "test(coord): e2e smoke covers Scenario A (serialization) + B (warm-hit replay)"
```

- [ ] **Step 3: Manual run after cutover (deferred to Task 7)**

The smoke script REQUIRES the workstation daemon to be running with the Phase 2 code. Run it as part of Task 7.

---

## Task 7: Cutover

**Files:** none new — git operation + workstation refresh.

- [ ] **Step 1: Run all coord-related tests as final pre-flight (from the worktree)**

```bash
cd server && node node_modules/vitest/vitest.mjs run \
  tests/coord-config.test.js \
  tests/coord-state.test.js \
  tests/coord-state-persistence.test.js \
  tests/coord-result-store.test.js \
  tests/coord-reaper.test.js \
  tests/coord-http.test.js \
  tests/coord-integration.test.js \
  tests/coord-client-cli.test.js \
  tests/coord-torque-remote-integration.test.js \
  tests/coord-lock-hashes.test.js \
  tests/pre-push-hook-staging.test.js
```

Expected: all pass.

- [ ] **Step 2: Run cutover from the main checkout**

From the main checkout (parent of the worktree):

```bash
scripts/worktree-cutover.sh remote-test-coord-phase2
```

The cutover script merges, drains TORQUE, restarts. Be ready for a `scripts/pre-push-hook` conflict if main has refactored the gate again — same playbook as Phase 1.

- [ ] **Step 3: Refresh the workstation daemon**

The daemon code lives in the synced checkout at `C:\trt\torque-public`. The Scheduled Task already invokes `node server/coord/index.js`, so a sync + restart picks up Phase 2 code:

```bash
ssh <workstation-user>@<workstation-host> 'powershell -Command "cd C:\trt\torque-public; git fetch origin main; git reset --hard origin/main"'
ssh <workstation-user>@<workstation-host> 'schtasks /end /tn TorqueCoord; schtasks /run /tn TorqueCoord'
ssh <workstation-user>@<workstation-host> 'curl -s http://127.0.0.1:9395/health'
```

(Replace `<workstation-user>@<workstation-host>` with values from `~/.torque-remote.local.json`.)

Expected: `{"ok":true,"protocol_version":1,"uptime_ms":<small>,"active_count":0}` (small uptime confirms restart took effect).

- [ ] **Step 4: Sync the user-level `bin/` copies**

The Phase 1 deployment exposed that the user's `~/bin/torque-remote` and `~/bin/torque-coord-client` are separate from the repo's `bin/`. Refresh both (paths are local to your environment):

```bash
cp <repo-root>/bin/torque-remote <user-bin>/torque-remote
cp <repo-root>/bin/torque-coord-client <user-bin>/torque-coord-client
chmod +x <user-bin>/torque-remote <user-bin>/torque-coord-client
```

- [ ] **Step 5: Run e2e smoke**

From the main checkout:

```bash
scripts/test-coord-e2e.sh
```

Expected: both Scenario A and Scenario B PASS.

---

## Spec coverage check

| Spec section | Implementing task |
|---|---|
| §5.7 result-store invalidation tied to package-lock hashes | Tasks 1, 2, 5 |
| §5.7 path-discovery via depth-bounded find | Task 1 |
| §6 path 2 (warm hit) | Task 5 (warm-hit pre-acquire) |
| §6 path 3 (wait then consume) | Task 5 (post-wait re-check via `/results`) |
| §6 path 4 (wait then run own) | Task 5 falls through naturally — re-check misses → re-acquire (Phase 1 path continues) |
| §6 path 5 (global queue) | **Deferred** — Phase 1's `sleep 5 + retry` for `global_semaphore_full` ships; richer queue UX belongs in Phase 3 dashboard |
| §7 result-hit hash mismatch row | Task 2 (TTL only on daemon) + Task 5 (client-side hash compare) |
| §7 path-traversal / `/results` hardening | Task 3 |
| §8 testing — daemon unit, daemon integration, client integration, e2e | Tasks 1–6 each include their tests; Task 6 is the new e2e |
| §9 Phase 2 ship list | This plan |

**Phase 2 explicitly excludes (per spec §9 / by design):**
- Server-side `consumed` SSE event — client-side post-wait re-check via `/results` covers the user-facing behavior.
- `queue_position` SSE events — Phase 1's polling stays.
- Server-side wait→acquire transition for global semaphore — same.
- Phase 3 dashboard mirror, MCP `coord_status`, SSH-tunneled cross-machine coord.

These can each be a follow-up plan when the dashboard work lands.
