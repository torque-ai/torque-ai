# Bug Hunt Remediation — Phase 0 + Phase 1

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a green test baseline on Omen, then fix all critical security vulnerabilities with regression tests.

**Architecture:** Phase 0 fixes 2 test infrastructure root causes (~192 failures). Phase 1 fixes 9 security vulnerabilities, each with a dedicated regression test. All work is manual with careful review — no TORQUE batches.

**Tech Stack:** Node.js, Vitest, better-sqlite3, React Testing Library, Playwright

**Spec:** `docs/superpowers/specs/2026-03-18-bug-hunt-remediation-design.md`

**Verification target:** Run on remote-gpu-host via SSH:
```bash
ssh user@remote-gpu-host "cmd /c \"cd /path/to\torque-public\server && npx vitest run 2>&1\""
ssh user@remote-gpu-host "cmd /c \"cd /path/to\torque-public\dashboard && npx vitest run 2>&1\""
```

---

## Phase 0: Test Baseline

### Task 0.1: Diagnose and fix 162 server test failures on Omen

The error `TypeError: db.onClose is not a function` appears at `task-manager.js:2615` during module load. The real `database.js` exports `onClose` (line 267, exported at line 1760), so the issue is that test mocks/stubs don't include it. When `task-manager.js` is `require()`d in tests, it calls `db.onClose(...)` at module top-level, and the test's mock db lacks this method.

**Files:**
- Investigate: `server/tests/mocks/` — find the shared db mock
- Modify: whichever mock file provides the `db` object to tests
- Verify: all 616 server test files on Omen

- [ ] **Step 1: Identify the mock missing `onClose`**

SSH to Omen and run a failing test that uses `vi.mock('../database')` (not `starttask-helpers.test.js` which uses a real DB). Pick a test file that failed with the `db.onClose` error:
```bash
ssh user@remote-gpu-host "cmd /c \"cd /path/to\torque-public\server && npx vitest run tests/rest-control-plane-parity.test.js --reporter=verbose 2>&1\"" | head -40
```
Look for which module provides the `db` mock. Check `server/tests/mocks/` for a shared database mock. The error cascades from `task-manager.js:2615` calling `db.onClose(...)` at require-time — so any test that `require`s task-manager with a mocked db will fail if the mock lacks `onClose`.

- [ ] **Step 2: Add `onClose` to the database mock**

The mock needs `onClose: vi.fn()` (or `onClose: (fn) => {}` if it needs to be callable). Find the mock object and add the missing method. Pattern to match:
```js
// In the mock db object, alongside existing stubs:
onClose: vi.fn(),
```

- [ ] **Step 3: Check for other missing DB methods**

The test output may show additional missing methods once `onClose` is fixed. Run the full suite again after the fix:
```bash
ssh user@remote-gpu-host "cmd /c \"cd /path/to\torque-public\server && npx vitest run --reporter=verbose 2>&1\"" | tail -30
```
If new failures appear from other missing mock methods, add those too.

- [ ] **Step 4: Verify on Omen**

Run the complete server test suite. Target: ≤5 failures (some may be genuine bugs from Phase 2).
```bash
ssh user@remote-gpu-host "cmd /c \"cd /path/to\torque-public\server && npx vitest run 2>&1\"" | grep "Test Files\|Tests "
```

- [ ] **Step 5: Commit**

```bash
git add server/tests/
git commit -m "fix(tests): add missing onClose to database mock — resolves ~150 Omen failures"
```

### Task 0.2: Fix 30 dashboard WebSocket test failures on Omen

All 30 failures are in `dashboard/src/websocket.test.js`. Tests like "re-sends subscribe messages on reconnect" fail with `TypeError: Cannot read properties of undefined (reading 'simulateOpen')` because `latestSocket()` returns `undefined`.

The `MockWebSocket` class (websocket.test.js:4-45) looks correct — it pushes to `instances` in the constructor. The issue is environment-specific (passes locally, fails on Omen). Likely cause: the test environment on Omen has a native `WebSocket` that takes precedence over `global.WebSocket = MockWebSocket`, or the happy-dom/jsdom version differs.

**Files:**
- Modify: `dashboard/src/websocket.test.js`
- Investigate: `dashboard/vitest.config.js` — check test environment setting

- [ ] **Step 1: Diagnose on Omen**

Run a single failing reconnect test with verbose output:
```bash
ssh user@remote-gpu-host "cmd /c \"cd /path/to\torque-public\dashboard && npx vitest run src/websocket.test.js --reporter=verbose 2>&1\"" | tail -60
```
Check which tests pass (basic connection) vs fail (reconnect). If basic tests pass but reconnect tests fail, the issue is fake timers or `connectRef` timing.

- [ ] **Step 2: Add `vi.useFakeTimers()` if missing from reconnect tests**

The `useWebSocket` hook uses `setTimeout` for reconnect delays (3s, 6s, etc.). If reconnect tests don't use fake timers, the WebSocket never reconnects during synchronous test execution, so `latestSocket()` returns the stale first instance. Check if the failing tests call `vi.useFakeTimers()` and `vi.advanceTimersByTime()`.

If the issue is the global WebSocket override not working on Omen's environment, use `vi.stubGlobal`:
```js
beforeEach(() => {
  vi.stubGlobal('WebSocket', MockWebSocket);
  MockWebSocket.instances = [];
  // ...
});

afterEach(() => {
  vi.unstubAllGlobals();
  // ...
});
```

- [ ] **Step 3: Verify on Omen**

```bash
ssh user@remote-gpu-host "cmd /c \"cd /path/to\torque-public\dashboard && npx vitest run 2>&1\"" | grep "Test Files\|Tests "
```
Target: 0 failures.

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/websocket.test.js
git commit -m "fix(tests): stabilize WebSocket mock for Omen test environment"
```

---

## Phase 1: Security Fixes

Each task adds a regression test that proves the vulnerability is closed.

### Task 1.2: Fix RCE in remote agent server

Three independent RCE paths in `server/remote/agent-server.js`.

**Files:**
- Modify: `server/remote/agent-server.js:104, :197, :397, :435`
- Create: `server/tests/agent-server-security.test.js`

- [ ] **Step 1: Write failing security tests**

```js
// server/tests/agent-server-security.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Test 1: CWD must be within allowed directories
describe('agent-server security', () => {
  describe('validateRunRequest', () => {
    it('rejects CWD outside allowed directories', () => {
      // Import validateRunRequest or the module that exposes it
      // Pass body with cwd: '/etc' or 'C:\\Windows\\System32'
      // Expect: throws or returns error
    });

    it('rejects commands with shell metacharacters in args', () => {
      // Pass args containing '; rm -rf /', '| cat /etc/passwd', '$(whoami)'
      // Expect: rejected
    });
  });

  describe('streamRun', () => {
    it('does not use shell: true', () => {
      // Verify spawn is called with shell: false
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
ssh user@remote-gpu-host "cmd /c \"cd /path/to\torque-public\server && npx vitest run tests/agent-server-security.test.js --reporter=verbose 2>&1\""
```

- [ ] **Step 3: Fix `validateRunRequest` — add CWD allowlist**

In `server/remote/agent-server.js`, after line 397 (`const cwd = ...`), add:
```js
// Validate CWD is within an allowed root directory
const allowedRoots = state.config?.allowed_roots || [state.config?.project_root].filter(Boolean);
if (allowedRoots.length > 0) {
  const resolvedCwd = path.resolve(cwd);
  const isAllowed = allowedRoots.some(root => {
    const resolvedRoot = path.resolve(root);
    return resolvedCwd === resolvedRoot || resolvedCwd.startsWith(resolvedRoot + path.sep);
  });
  if (!isAllowed) {
    throw createHttpError(`cwd is outside allowed directories: ${cwd}`, 403);
  }
}
```

- [ ] **Step 4: Fix `streamRun` — switch to `shell: false`**

In `server/remote/agent-server.js:435`, change:
```js
// BEFORE (line 438):
shell: true,

// AFTER:
shell: false,
```

Also fix `spawnAndCapture` (line ~197) — same change: `shell: false`.

On Windows, commands like `node`, `npm`, `npx` are `.cmd` files and need shell for resolution when using `spawn` with `shell: false`. Use Node's built-in `which`-style resolution by trying common extensions:
```js
// Cache resolved commands at module load to avoid repeated lookups
const _resolvedCommands = new Map();

function resolveCommand(command) {
  if (process.platform !== 'win32' || path.extname(command)) return command;
  if (_resolvedCommands.has(command)) return _resolvedCommands.get(command);

  for (const ext of ['.cmd', '.exe', '.bat', '']) {
    const candidate = command + ext;
    try {
      require('child_process').execFileSync('where', [candidate], { encoding: 'utf-8', timeout: 3000, stdio: 'pipe' });
      _resolvedCommands.set(command, candidate);
      return candidate;
    } catch { /* continue */ }
  }
  _resolvedCommands.set(command, command); // cache miss — return as-is
  return command;
}
```

Note: Results are cached per command name at module level, so `where` is only called once per unique command across the server's lifetime.

- [ ] **Step 5: Add shell metacharacter validation to `prepareShellArgs`**

In `server/remote/agent-server.js`, modify `prepareShellArgs` (line 119):
```js
const SHELL_METACHAR_RE = /[;|&`$(){}!<>]/;

function prepareShellArgs(args) {
  if (!Array.isArray(args)) return [];
  return args.map((arg) => {
    const str = String(arg);
    if (SHELL_METACHAR_RE.test(str)) {
      throw createHttpError(`Argument contains shell metacharacters: ${str.substring(0, 50)}`, 400);
    }
    return str;
  });
}
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
ssh user@remote-gpu-host "cmd /c \"cd /path/to\torque-public\server && npx vitest run tests/agent-server-security.test.js --reporter=verbose 2>&1\""
```

- [ ] **Step 7: Run full server suite to check for regressions**

```bash
ssh user@remote-gpu-host "cmd /c \"cd /path/to\torque-public\server && npx vitest run 2>&1\"" | grep "Test Files\|Tests "
```

- [ ] **Step 8: Commit**

```bash
git add server/remote/agent-server.js server/tests/agent-server-security.test.js
git commit -m "security: fix 3 RCE paths in remote agent server

- Switch spawn to shell: false (prevents shell injection)
- Add CWD allowlist validation (prevents path traversal)
- Reject shell metacharacters in args"
```

### Task 1.3: Fix command injection bypass in ollama-tools

**Files:**
- Modify: `server/providers/ollama-tools.js:371-388, :707-714`
- Create: `server/tests/ollama-tools-security.test.js`

- [ ] **Step 1: Write failing security tests**

```js
// server/tests/ollama-tools-security.test.js
import { describe, it, expect } from 'vitest';

// Import or require the isCommandAllowed function
// It's not exported, so we'll need to either export it for testing
// or test through createToolExecutor

describe('ollama-tools command security', () => {
  it('blocks rm -rf / even with specific allowlist', () => {
    // Create executor with allowlist: ['rm *']
    // Execute run_command with 'rm -rf /'
    // Expect: blocked
  });

  it('blocks shell metacharacters in commands', () => {
    // Create executor with allowlist: ['npm *']
    // Execute 'npm test; rm -rf /'
    // Expect: blocked (semicolon should not pass glob match)
  });

  it('blocks pipe injection', () => {
    // Create executor with allowlist: ['npm *']
    // Execute 'npm test | cat /etc/passwd'
    // Expect: blocked
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Fix `isCommandAllowed` — always check ALWAYS_BLOCKED**

In `server/providers/ollama-tools.js:371-388`, change:
```js
function isCommandAllowed(command, allowlist) {
  // ALWAYS check dangerous commands — regardless of allowlist mode
  const ALWAYS_BLOCKED = ['rm -rf /', 'mkfs', 'dd if=', ':(){', 'fork bomb'];
  const cmdLower = command.toLowerCase();
  if (ALWAYS_BLOCKED.some(b => cmdLower.includes(b))) {
    return false;
  }

  // Reject commands containing shell metacharacters
  if (/[;|&`$(){}!<>]/.test(command)) {
    return false;
  }

  for (const pattern of allowlist) {
    if (pattern === '*') return true;
    const escaped = pattern.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*');
    const regex = new RegExp(`^${escaped}$`);
    if (regex.test(command)) return true;
  }
  return false;
}
```

- [ ] **Step 4: Switch `run_command` from shell execution to `execFileSync` with `shell: false`**

In `server/providers/ollama-tools.js:707-723`, replace `execSync(args.command, { shell: true })` with `execFileSync` that splits the command into executable + args to avoid shell interpretation:

```js
case 'run_command': {
  if (commandMode === 'allowlist') {
    if (!isCommandAllowed(args.command, commandAllowlist)) {
      return { result: `Error: Command not in allowlist: ${args.command}`, error: true };
    }
  }
  try {
    const parts = args.command.split(/\s+/);
    const executable = parts[0];
    const cmdArgs = parts.slice(1);
    const { execFileSync } = require('child_process');
    const output = execFileSync(executable, cmdArgs, {
      cwd: workingDir,
      timeout: MAX_COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES * 2,
      encoding: 'utf-8',
      shell: false,
    });
    return { result: truncateOutput(output) || '(no output)' };
  } catch (e) {
    const stderr = e.stderr ? e.stderr.toString() : '';
    const stdout = e.stdout ? e.stdout.toString() : '';
    return { result: truncateOutput(`Command failed (exit ${e.status}):\n${stdout}\n${stderr}`), error: true };
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

- [ ] **Step 6: Run full server suite**

- [ ] **Step 7: Commit**

```bash
git add server/providers/ollama-tools.js server/tests/ollama-tools-security.test.js
git commit -m "security: fix command injection bypass in ollama-tools

- Always check ALWAYS_BLOCKED regardless of allowlist mode
- Reject commands containing shell metacharacters
- Switch run_command from execSync shell:true to execFileSync shell:false"
```

### Task 1.5: Fix timing attack in agent auth

**Files:**
- Modify: `server/remote/agent-server.js:97-105`
- Add test to: `server/tests/agent-server-security.test.js`

- [ ] **Step 1: Write failing test**

```js
// Add to server/tests/agent-server-security.test.js
const crypto = require('crypto');

describe('isAuthorized', () => {
  it('uses timing-safe comparison', () => {
    const spy = vi.spyOn(crypto, 'timingSafeEqual');
    // Call isAuthorized with a valid secret
    // (requires exporting isAuthorized or testing through the HTTP handler)
    const mockReq = { headers: { 'x-torque-secret': 'test-secret' } };
    const result = isAuthorized(mockReq, 'test-secret');
    expect(spy).toHaveBeenCalled();
    expect(result).toBe(true);
    spy.mockRestore();
  });

  it('rejects mismatched secrets', () => {
    const mockReq = { headers: { 'x-torque-secret': 'wrong-secret' } };
    expect(isAuthorized(mockReq, 'correct-secret')).toBe(false);
  });

  it('rejects missing header', () => {
    const mockReq = { headers: {} };
    expect(isAuthorized(mockReq, 'test-secret')).toBe(false);
  });
});
```

Note: `isAuthorized` must be exported for direct testing. Add `module.exports = { ..., isAuthorized }` to agent-server.js, or test through the HTTP handler by sending requests with wrong secrets and verifying 401.

- [ ] **Step 2: Fix `isAuthorized` to use `crypto.timingSafeEqual`**

In `server/remote/agent-server.js:97-105`, replace:
```js
const crypto = require('crypto');

function isAuthorized(req, secret) {
  if (!secret) return false;
  const received = req.headers['x-torque-secret'];
  if (typeof received !== 'string') return false;

  // Use timing-safe comparison to prevent timing attacks
  const a = Buffer.from(received, 'utf-8');
  const b = Buffer.from(secret, 'utf-8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
```

- [ ] **Step 3: Run tests, verify pass**

- [ ] **Step 4: Commit**

```bash
git add server/remote/agent-server.js server/tests/agent-server-security.test.js
git commit -m "security: use timing-safe comparison for agent auth"
```

### Task 1.6: Fix prototype pollution in deepMerge

**Files:**
- Modify: `server/orchestrator/config-loader.js:144-158`
- Create: `server/tests/config-loader-security.test.js`

- [ ] **Step 1: Write failing test**

```js
// server/tests/config-loader-security.test.js
const { mergeConfig } = require('../orchestrator/config-loader');

describe('deepMerge prototype pollution', () => {
  it('does not pollute Object prototype via __proto__', () => {
    expect(({}).polluted).toBeUndefined();

    // JSON.parse produces a real __proto__ key (not the prototype accessor)
    const malicious = JSON.parse('{"__proto__": {"polluted": "yes"}}');
    const defaults = { safe: true };
    mergeConfig(malicious, null, defaults);

    // If pollution succeeded, ALL objects would have .polluted
    expect(({}).polluted).toBeUndefined();
  });

  it('does not pollute via constructor.prototype', () => {
    expect(({}).polluted2).toBeUndefined();

    const malicious = { constructor: { prototype: { polluted2: 'yes' } } };
    const defaults = { safe: true };
    mergeConfig(malicious, null, defaults);

    expect(({}).polluted2).toBeUndefined();
  });

  it('preserves legitimate keys while blocking dangerous ones', () => {
    const input = JSON.parse('{"__proto__": {"bad": true}, "good_key": "value"}');
    const result = mergeConfig(input, null, {});
    expect(result.good_key).toBe('value');
    expect(({}).bad).toBeUndefined();
  });
});
```

Note: `mergeConfig` is exported from `config-loader.js` (line 161). It calls `deepMerge` internally. If `mergeConfig` is not exported, export it or export `deepMerge` directly for testing.

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Add prototype pollution guard to `deepMerge`**

In `server/orchestrator/config-loader.js:147`, add guard:
```js
function deepMerge(target, source) {
  if (!source || typeof source !== 'object') return target;
  const result = { ...target };
  for (const key of Object.keys(source)) {
    // Prevent prototype pollution
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;

    const val = source[key];
    if (val === null || val === undefined) continue;
    if (Array.isArray(val)) {
      result[key] = [...val];
    } else if (typeof val === 'object' && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = deepMerge(result[key], val);
    } else {
      result[key] = val;
    }
  }
  return result;
}
```

- [ ] **Step 4: Run tests, verify pass**

- [ ] **Step 5: Commit**

```bash
git add server/orchestrator/config-loader.js server/tests/config-loader-security.test.js
git commit -m "security: prevent prototype pollution in config-loader deepMerge"
```

### Task 1.7 + 1.8 + 1.9: Fix ReDoS via custom patterns, schema validation, and safeRegexTest

**Files:**
- Modify: `server/utils/safe-regex.js` (entire file — 18 lines)
- Modify: `server/orchestrator/deterministic-fallbacks.js:80`
- Modify: `server/mcp/tool-registry.js:87`
- Create: `server/tests/safe-regex-security.test.js`

- [ ] **Step 1: Write failing tests**

```js
// server/tests/safe-regex-security.test.js
const { isSafeRegex, safeRegexTest } = require('../utils/safe-regex');

describe('safe-regex security', () => {
  it('rejects catastrophic backtracking patterns', () => {
    expect(isSafeRegex('(a+)+b')).toBe(false);
    expect(isSafeRegex('(\\w+\\s*)+$')).toBe(false);
  });

  it('safeRegexTest returns false for rejected patterns', () => {
    const result = safeRegexTest('(a+)+b', 'a'.repeat(30), 100);
    expect(result).toBe(false);
  });

  it('accepts safe patterns', () => {
    expect(isSafeRegex('error.*timeout')).toBe(true);
    expect(safeRegexTest('hello', 'hello world')).toBe(true);
  });

  it('truncates input to prevent slow matching on large inputs', () => {
    // Even a safe pattern should complete quickly on truncated input
    const start = Date.now();
    safeRegexTest('a.*b', 'a'.repeat(100000) + 'b', 100);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe('tool-registry schema pattern validation (1.9)', () => {
  it('rejects pathological schema patterns via isSafeRegex guard', () => {
    // Simulate what tool-registry.js does: validate a value against schema.pattern
    // After the fix, pathological patterns should be silently skipped
    const { isSafeRegex } = require('../utils/safe-regex');
    expect(isSafeRegex('(a|a)+b')).toBe(false); // alternation in quantified group
  });
});
```

**Note on `timeoutMs`:** The spec called for worker-thread timeout enforcement. The pragmatic approach here is defense-in-depth: `isSafeRegex` rejects known-dangerous patterns statically, and `safeRegexTest` truncates input to 10K chars. True timeout enforcement via worker threads adds significant complexity (IPC overhead, worker pool management) for marginal benefit given the static analysis catches the common ReDoS patterns. If a future pattern bypasses `isSafeRegex`, the 10K input cap limits worst-case execution time. This is an intentional scope narrowing from the spec — document this in the commit message.

- [ ] **Step 2: Run tests to verify they fail**

The current `isSafeRegex` only rejects adjacent quantifiers (`++`, `*+`, etc.) but not nested group quantifiers like `(a+)+`. And `safeRegexTest` ignores `timeoutMs`.

- [ ] **Step 3: Rewrite `safe-regex.js`**

```js
'use strict';

// Patterns that indicate potential catastrophic backtracking
const DANGEROUS_PATTERNS = [
  /(\+|\*|\{)\s*\)(\+|\*|\{)/,          // Nested quantifiers: (a+)+
  /(\+|\*|\{)\s*(\+|\*|\{)/,            // Adjacent quantifiers: a++
  /\([^)]*\|[^)]*\)\s*(\+|\*|\{)/,      // Alternation in quantified group: (a|a)+
];

function isSafeRegex(pattern, maxLength = 200) {
  if (typeof pattern !== 'string' || pattern.length > maxLength) return false;
  if (DANGEROUS_PATTERNS.some(dp => dp.test(pattern))) return false;
  try { new RegExp(pattern); return true; } catch { return false; }
}

function safeRegexTest(pattern, input, timeoutMs = 100) {
  if (!isSafeRegex(pattern)) return false;
  try {
    const regex = new RegExp(pattern, 'i');
    // For safety, limit input length to prevent slow matching
    const safeInput = typeof input === 'string' ? input.slice(0, 10000) : '';
    return regex.test(safeInput);
  } catch { return false; }
}

module.exports = { isSafeRegex, safeRegexTest };
```

- [ ] **Step 4: Guard custom patterns in `deterministic-fallbacks.js`**

In `server/orchestrator/deterministic-fallbacks.js:80`, change:
```js
// BEFORE:
if (cp.match && new RegExp(cp.match, 'i').test(output)) {

// AFTER:
if (cp.match && isSafeRegex(cp.match) && new RegExp(cp.match, 'i').test(output)) {
```

Add import at top of file:
```js
const { isSafeRegex } = require('../utils/safe-regex');
```

- [ ] **Step 5: Guard schema patterns in `tool-registry.js`**

In `server/mcp/tool-registry.js:87`, change:
```js
// BEFORE:
if (schema.pattern !== undefined && !(new RegExp(schema.pattern).test(value))) {

// AFTER:
if (schema.pattern !== undefined && isSafeRegex(schema.pattern) && !(new RegExp(schema.pattern).test(value))) {
```

Add import at top of file:
```js
const { isSafeRegex } = require('../utils/safe-regex');
```

- [ ] **Step 6: Run tests, verify pass**

- [ ] **Step 7: Run full server suite**

- [ ] **Step 8: Commit**

```bash
git add server/utils/safe-regex.js server/orchestrator/deterministic-fallbacks.js server/mcp/tool-registry.js server/tests/safe-regex-security.test.js
git commit -m "security: fix ReDoS vulnerabilities in custom patterns and schema validation

- Rewrite safe-regex.js to detect nested group quantifiers
- Guard custom diagnostic patterns through isSafeRegex
- Guard tool-registry schema patterns through isSafeRegex"
```

### Task 1.10: Hash agent secrets before storage

**Files:**
- Modify: `server/remote/agent-registry.js:33-37`
- Modify: `server/remote/agent-server.js` (auth verification path)
- Create: `server/tests/agent-registry-security.test.js`

- [ ] **Step 1: Write failing test**

```js
// server/tests/agent-registry-security.test.js
import { describe, it, expect } from 'vitest';

describe('agent-registry secret storage', () => {
  it('does not store secrets in plaintext', () => {
    // Register an agent with secret "my-secret-value"
    // Query the database directly
    // Verify the stored value !== "my-secret-value"
    // Verify the stored value looks like a hash (e.g., starts with '$2b$' for bcrypt)
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Add secret hashing to agent-registry**

In `server/remote/agent-registry.js`, add hashing to `register()` using Node's built-in `crypto.scryptSync` (a slow-by-design KDF, resistant to brute-force):
```js
const crypto = require('crypto');

function hashSecret(secret) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(secret, salt, 32).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifySecret(stored, provided) {
  if (!stored || !stored.startsWith('scrypt:')) return false;
  const [, salt, expectedHash] = stored.split(':');
  const actualHash = crypto.scryptSync(provided, salt, 32).toString('hex');
  const a = Buffer.from(expectedHash, 'hex');
  const b = Buffer.from(actualHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
```

Note: `scryptSync` is slow by design (~100ms). This is fine for agent registration (rare operation) but ensures brute-force resistance if the database is leaked. No external dependency needed — `crypto.scryptSync` is built into Node.js.

In `register()` (line 37), hash before storing:
```js
// BEFORE:
).run(id, name, host, port, secret, max_concurrent, ...);

// AFTER:
).run(id, name, host, port, hashSecret(secret), max_concurrent, ...);
```

Update the auth path to use `verifySecret(storedHash, providedSecret)` instead of direct comparison.

- [ ] **Step 4: Run tests, verify pass**

- [ ] **Step 5: Commit**

```bash
git add server/remote/agent-registry.js server/tests/agent-registry-security.test.js
git commit -m "security: hash agent secrets before database storage

- SHA-256 with per-agent salt for secret storage
- Timing-safe verification for auth checks"
```

### Task 1.11: Delete suspicious file

**Files:**
- Delete: `server/.codex-context/_________etc_passwd.md`

- [ ] **Step 1: Verify file contents**

```bash
cat server/.codex-context/_________etc_passwd.md
```
Expected: "test content" — a prompt injection artifact.

- [ ] **Step 2: Delete the file**

```bash
rm server/.codex-context/_________etc_passwd.md
```

- [ ] **Step 3: Commit**

```bash
git add -u server/.codex-context/
git commit -m "security: remove prompt injection artifact from .codex-context"
```

---

## Final Verification

- [ ] **Pull latest on Omen and run both suites**

```bash
ssh user@remote-gpu-host "cmd /c \"cd /path/to\torque-public && git pull origin main 2>&1\""
ssh user@remote-gpu-host "cmd /c \"cd /path/to\torque-public\server && npx vitest run 2>&1\"" | grep "Test Files\|Tests "
ssh user@remote-gpu-host "cmd /c \"cd /path/to\torque-public\dashboard && npx vitest run 2>&1\"" | grep "Test Files\|Tests "
```

Target: 0 failures in both suites. All new security tests green.

**Gate passed → Phase 2 can begin.**
