# User-Scoped MCP Config Injection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-inject TORQUE's MCP server entry into `~/.claude/.mcp.json` at startup so TORQUE tools work in every Claude Code session without per-project configuration.

**Architecture:** A new `server/auth/mcp-config-injector.js` module reads the bootstrap API key from disk, reads/merges the global Claude Code MCP config, and writes back only if the TORQUE entry is missing or stale. Called once during server startup after `serverConfig.init()`.

**Tech Stack:** Node.js, fs (sync), path, os, child_process (icacls on Windows)

**Spec:** `docs/superpowers/specs/2026-03-25-user-scoped-mcp-config-injection-design.md`

---

## File Structure

| File | Responsibility |
|------|----------------|
| `server/auth/mcp-config-injector.js` | **NEW** — `ensureGlobalMcpConfig()`: read key file, resolve config path, read/merge/write `.mcp.json` |
| `server/tests/mcp-config-injector.test.js` | **NEW** — Unit tests for all injection paths |
| `server/index.js` | **MODIFY** — Call injector after `serverConfig.init()` (~line 583) |
| `.mcp.json` | **DELETE** — Project-local config, redundant with global injection |

---

### Task 1: Create `mcp-config-injector.js` with tests

**Files:**
- Create: `server/auth/mcp-config-injector.js`
- Create: `server/tests/mcp-config-injector.test.js`

- [ ] **Step 1: Write failing tests**

Create `server/tests/mcp-config-injector.test.js`:

```js
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

let injector;
let tmpHome;
let tmpDataDir;

function claudeDir() { return path.join(tmpHome, '.claude'); }
function mcpPath() { return path.join(claudeDir(), '.mcp.json'); }
function keyFilePath() { return path.join(tmpDataDir, '.torque-api-key'); }

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-mcp-inject-'));
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-mcp-data-'));

  // Write a test API key
  fs.writeFileSync(keyFilePath(), 'torque_sk_test-key-1234');

  // Fresh require to avoid stale state
  delete require.cache[require.resolve('../auth/mcp-config-injector')];
  injector = require('../auth/mcp-config-injector');
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe('ensureGlobalMcpConfig', () => {
  it('creates ~/.claude/.mcp.json when absent', () => {
    const result = injector.ensureGlobalMcpConfig('torque_sk_test-key-1234', {
      homeDir: tmpHome, ssePort: 3458,
    });

    expect(result.injected).toBe(true);
    expect(result.reason).toBe('created');
    const data = JSON.parse(fs.readFileSync(mcpPath(), 'utf-8'));
    expect(data.mcpServers.torque.type).toBe('sse');
    expect(data.mcpServers.torque.url).toContain('torque_sk_test-key-1234');
    expect(data.mcpServers.torque.url).toContain('3458');
  });

  it('merges into existing file with other servers', () => {
    fs.mkdirSync(claudeDir(), { recursive: true });
    fs.writeFileSync(mcpPath(), JSON.stringify({
      mcpServers: {
        'other-tool': { type: 'stdio', command: 'other', args: [] },
      },
    }, null, 2));

    const result = injector.ensureGlobalMcpConfig('torque_sk_test-key-1234', {
      homeDir: tmpHome, ssePort: 3458,
    });

    expect(result.injected).toBe(true);
    const data = JSON.parse(fs.readFileSync(mcpPath(), 'utf-8'));
    expect(data.mcpServers['other-tool'].command).toBe('other');
    expect(data.mcpServers.torque.url).toContain('torque_sk_test-key-1234');
  });

  it('skips write when entry already matches', () => {
    fs.mkdirSync(claudeDir(), { recursive: true });
    const existing = {
      mcpServers: {
        torque: {
          type: 'sse',
          url: 'http://127.0.0.1:3458/sse?apiKey=torque_sk_test-key-1234',
          description: 'TORQUE - Task Orchestration System with local LLM routing',
        },
      },
    };
    fs.writeFileSync(mcpPath(), JSON.stringify(existing, null, 2));
    const mtimeBefore = fs.statSync(mcpPath()).mtimeMs;

    const result = injector.ensureGlobalMcpConfig('torque_sk_test-key-1234', {
      homeDir: tmpHome, ssePort: 3458,
    });

    expect(result.injected).toBe(false);
    expect(result.reason).toBe('already_current');
    // File should not have been rewritten
    expect(fs.statSync(mcpPath()).mtimeMs).toBe(mtimeBefore);
  });

  it('updates URL when key changes', () => {
    fs.mkdirSync(claudeDir(), { recursive: true });
    fs.writeFileSync(mcpPath(), JSON.stringify({
      mcpServers: {
        torque: {
          type: 'sse',
          url: 'http://127.0.0.1:3458/sse?apiKey=torque_sk_old-key',
          description: 'TORQUE - Task Orchestration System with local LLM routing',
        },
      },
    }, null, 2));

    const result = injector.ensureGlobalMcpConfig('torque_sk_new-key', {
      homeDir: tmpHome, ssePort: 3458,
    });

    expect(result.injected).toBe(true);
    expect(result.reason).toBe('updated');
    const data = JSON.parse(fs.readFileSync(mcpPath(), 'utf-8'));
    expect(data.mcpServers.torque.url).toContain('torque_sk_new-key');
    expect(data.mcpServers.torque.url).not.toContain('old-key');
  });

  it('preserves file on JSON parse failure', () => {
    fs.mkdirSync(claudeDir(), { recursive: true });
    fs.writeFileSync(mcpPath(), '{ broken json !!!');

    const result = injector.ensureGlobalMcpConfig('torque_sk_test-key-1234', {
      homeDir: tmpHome, ssePort: 3458,
    });

    expect(result.injected).toBe(false);
    expect(result.reason).toBe('parse_error');
    // Original content preserved
    expect(fs.readFileSync(mcpPath(), 'utf-8')).toBe('{ broken json !!!');
  });

  it('creates ~/.claude/ directory when missing', () => {
    expect(fs.existsSync(claudeDir())).toBe(false);

    const result = injector.ensureGlobalMcpConfig('torque_sk_test-key-1234', {
      homeDir: tmpHome, ssePort: 3458,
    });

    expect(result.injected).toBe(true);
    expect(fs.existsSync(claudeDir())).toBe(true);
  });

  it('skips when apiKey is empty or missing', () => {
    const result1 = injector.ensureGlobalMcpConfig('', { homeDir: tmpHome });
    expect(result1.injected).toBe(false);
    expect(result1.reason).toBe('no_key');

    const result2 = injector.ensureGlobalMcpConfig(null, { homeDir: tmpHome });
    expect(result2.injected).toBe(false);
    expect(result2.reason).toBe('no_key');
  });

  it('uses non-default SSE port', () => {
    const result = injector.ensureGlobalMcpConfig('torque_sk_test-key-1234', {
      homeDir: tmpHome, ssePort: 9999,
    });

    expect(result.injected).toBe(true);
    const data = JSON.parse(fs.readFileSync(mcpPath(), 'utf-8'));
    expect(data.mcpServers.torque.url).toContain(':9999/sse');
  });

  it('preserves user-added fields on entry update', () => {
    fs.mkdirSync(claudeDir(), { recursive: true });
    fs.writeFileSync(mcpPath(), JSON.stringify({
      mcpServers: {
        torque: {
          type: 'sse',
          url: 'http://127.0.0.1:3458/sse?apiKey=torque_sk_old-key',
          description: 'TORQUE',
          customField: 'user-value',
          timeout: 30000,
        },
      },
    }, null, 2));

    injector.ensureGlobalMcpConfig('torque_sk_new-key', {
      homeDir: tmpHome, ssePort: 3458,
    });

    const data = JSON.parse(fs.readFileSync(mcpPath(), 'utf-8'));
    expect(data.mcpServers.torque.url).toContain('torque_sk_new-key');
    expect(data.mcpServers.torque.customField).toBe('user-value');
    expect(data.mcpServers.torque.timeout).toBe(30000);
  });
});

describe('readKeyFromFile', () => {
  it('reads plaintext key from .torque-api-key file', () => {
    const key = injector.readKeyFromFile(tmpDataDir);
    expect(key).toBe('torque_sk_test-key-1234');
  });

  it('returns null when key file does not exist', () => {
    fs.unlinkSync(keyFilePath());
    const key = injector.readKeyFromFile(tmpDataDir);
    expect(key).toBeNull();
  });

  it('trims whitespace and newlines from key file', () => {
    fs.writeFileSync(keyFilePath(), '  torque_sk_trimmed  \n');
    const key = injector.readKeyFromFile(tmpDataDir);
    expect(key).toBe('torque_sk_trimmed');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp-config-injector.test.js`
Expected: FAIL — module `../auth/mcp-config-injector` not found.

- [ ] **Step 3: Implement `mcp-config-injector.js`**

Create `server/auth/mcp-config-injector.js`:

```js
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const logger = require('../logger').child({ component: 'mcp-config-injector' });

const MCP_CONFIG_FILENAME = '.mcp.json';
const CLAUDE_DIR_NAME = '.claude';
const KEY_FILENAME = '.torque-api-key';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_SSE_PORT = 3458;
const DESCRIPTION = 'TORQUE - Task Orchestration System with local LLM routing';

/**
 * Read the plaintext API key from the .torque-api-key file in the data directory.
 * @param {string} dataDir - TORQUE data directory path
 * @returns {string|null} The trimmed key, or null if the file doesn't exist
 */
function readKeyFromFile(dataDir) {
  const keyPath = path.join(dataDir, KEY_FILENAME);
  try {
    return fs.readFileSync(keyPath, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Ensure the current user's ~/.claude/.mcp.json contains a torque SSE entry
 * with the current API key. Merges non-destructively — other MCP servers
 * are preserved. Only writes if the entry is missing or the key changed.
 *
 * @param {string} apiKey - The plaintext API key to bake into the URL
 * @param {object} [options]
 * @param {number} [options.ssePort=3458] - SSE port
 * @param {string} [options.host='127.0.0.1'] - Server host
 * @param {string} [options.homeDir] - Override home directory (for tests)
 * @returns {{ injected: boolean, path: string, reason: string }}
 */
function ensureGlobalMcpConfig(apiKey, options = {}) {
  const {
    ssePort = DEFAULT_SSE_PORT,
    host = DEFAULT_HOST,
    homeDir,
  } = options;

  // Resolve paths
  const home = homeDir || os.homedir();
  const claudeDir = path.join(home, CLAUDE_DIR_NAME);
  const configPath = path.join(claudeDir, MCP_CONFIG_FILENAME);

  // Validate key
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    return { injected: false, path: configPath, reason: 'no_key' };
  }

  const expectedUrl = `http://${host}:${ssePort}/sse?apiKey=${apiKey}`;

  try {
    // Ensure ~/.claude/ exists
    fs.mkdirSync(claudeDir, { recursive: true });

    // Read existing config
    let data = { mcpServers: {} };
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      data = JSON.parse(raw);
      if (!data || typeof data !== 'object') {
        data = { mcpServers: {} };
      }
      if (!data.mcpServers || typeof data.mcpServers !== 'object') {
        data.mcpServers = {};
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // File exists but unreadable or unparseable — don't corrupt it
        logger.info(`[MCP Config] Cannot read/parse ${configPath}: ${err.message} — skipping injection`);
        return { injected: false, path: configPath, reason: 'parse_error' };
      }
      // ENOENT — file doesn't exist, we'll create it
    }

    // Check if entry already matches
    const existing = data.mcpServers.torque;
    if (existing && existing.url === expectedUrl) {
      return { injected: false, path: configPath, reason: 'already_current' };
    }

    // Merge: preserve user-added fields, overlay our required fields
    data.mcpServers.torque = {
      ...(existing || {}),
      type: 'sse',
      url: expectedUrl,
      description: DESCRIPTION,
    };

    // Atomic write: write to temp file, then rename
    const tmpPath = configPath + '.tmp.' + process.pid;
    const content = JSON.stringify(data, null, 2) + '\n';
    fs.writeFileSync(tmpPath, content, { mode: 0o600 });
    fs.renameSync(tmpPath, configPath);

    // Windows: restrict file permissions via icacls
    if (process.platform === 'win32') {
      try {
        const { execFileSync } = require('child_process');
        execFileSync('icacls', [
          configPath, '/inheritance:r', '/grant:r',
          `${process.env.USERNAME}:(F)`,
        ], { stdio: 'pipe', windowsHide: true });
      } catch { /* best-effort */ }
    }

    const reason = existing ? 'updated' : 'created';
    logger.info(`[MCP Config] Injected TORQUE entry into ${configPath} (${reason})`);
    return { injected: true, path: configPath, reason };
  } catch (err) {
    logger.info(`[MCP Config] Injection failed: ${err.message}`);
    return { injected: false, path: configPath, reason: `error: ${err.message}` };
  }
}

module.exports = { ensureGlobalMcpConfig, readKeyFromFile };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp-config-injector.test.js`
Expected: All 11 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/auth/mcp-config-injector.js server/tests/mcp-config-injector.test.js
git commit -m "feat(auth): add mcp-config-injector for global MCP config auto-setup"
```

---

### Task 2: Wire injector into server startup

**Files:**
- Modify: `server/index.js:583+` (after `serverConfig.init()`)

- [ ] **Step 1: Read the integration point**

Read `server/index.js` lines 575-595 to confirm the exact insertion point after `serverConfig.init({ db })` at line 583.

- [ ] **Step 2: Add the injector call**

Insert after line 583 (`serverConfig.init({ db });`):

```js
  // Auto-inject TORQUE MCP config into user's global ~/.claude/.mcp.json
  // so TORQUE tools are available in every Claude Code session.
  try {
    const mcpConfigInjector = require('./auth/mcp-config-injector');
    const { getDataDir } = require('./data-dir');
    const apiKey = mcpConfigInjector.readKeyFromFile(getDataDir());
    if (apiKey) {
      const ssePort = serverConfig.getInt('mcp_sse_port', 3458);
      const result = mcpConfigInjector.ensureGlobalMcpConfig(apiKey, { ssePort });
      if (result.injected) {
        debugLog(`MCP config ${result.reason}: ${result.path}`);
      }
    }
  } catch (err) {
    debugLog(`MCP config injection skipped: ${err.message}`);
  }
```

- [ ] **Step 3: Run full test suite to verify no regressions**

Run: `npx vitest run`
Expected: All existing tests pass, no new failures.

- [ ] **Step 4: Commit**

```bash
git add server/index.js
git commit -m "feat(auth): wire MCP config injection into server startup"
```

---

### Task 3: Remove project-local `.mcp.json`

**Files:**
- Delete: `.mcp.json`

- [ ] **Step 1: Delete the file**

```bash
git rm .mcp.json
```

- [ ] **Step 2: Verify `.mcp.json` is in `.gitignore`**

Confirm `.mcp.json` appears in `.gitignore` (it does, line 35). No change needed.

- [ ] **Step 3: Commit**

```bash
git commit -m "chore: remove project-local .mcp.json (global injection handles it)"
```

---

### Task 4: Update CLAUDE.md setup instructions

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the Setup section**

In `CLAUDE.md`, the Setup section currently says to copy `.mcp.json.example` to `.mcp.json`. Replace that manual step with a note that TORQUE auto-injects the global MCP config on first startup. Keep the `.mcp.json.example` reference for users who want manual configuration.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md setup instructions for auto MCP config injection"
```

---

### Task 5: Manual verification

- [ ] **Step 1: Restart TORQUE server**

Stop and restart the TORQUE server using the standard start command.

- [ ] **Step 2: Verify `~/.claude/.mcp.json` was updated**

```bash
cat ~/.claude/.mcp.json
```

Expected: `mcpServers.torque` entry present with the current API key baked into the URL.

- [ ] **Step 3: Open Claude Code in a different project directory**

Start a Claude Code session in a directory that does NOT have a `.mcp.json`. Verify TORQUE MCP tools are available (e.g., `ping` tool works).

- [ ] **Step 4: Push**

```bash
git push origin main
```
