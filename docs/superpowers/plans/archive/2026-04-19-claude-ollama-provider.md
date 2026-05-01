# ClaudeOllama Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new TORQUE provider (`claude-ollama`) that wraps `ollama launch claude --model <local> -- -p "<prompt>"`, letting locally-hosted Ollama models drive the Claude Code harness (tool loop, Read/Edit/Bash, agentic planning) instead of the raw prompt-response shape used by `ollama-agentic`.

**Architecture:** New subclass of `BaseProvider` at `server/providers/claude-ollama.js`. Reuses streaming record normalization extracted from `claude-code-sdk.js` into a shared module `server/providers/claude-code/stream-parser.js`. Concurrency is capped per-host via the existing `host-mutex.js`. Ships disabled by default; smart routing never auto-routes to it (opt-in only via explicit `provider: "claude-ollama"`).

**Tech Stack:** Node.js + vitest (existing TORQUE stack). No new dependencies — the provider spawns the `ollama.exe` CLI (which internally spawns `claude.exe`) and parses stream-json output the same way `claude-code-sdk.js` already does.

**Spec:** `docs/superpowers/specs/2026-04-19-claude-ollama-provider-design.md` in this worktree.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `server/providers/claude-code/stream-parser.js` | **Create** | Pure functions: `normalizeToolCall`, `normalizeToolResult`, `normalizeUsage`, `extractTextDelta`, `extractFallbackText`, `extractTextFromContent`. Extracted from `claude-code-sdk.js` verbatim. |
| `server/providers/claude-code-sdk.js` | **Modify** | Replace the inline helper definitions with `require('./claude-code/stream-parser')`. Pure refactor, no behavior change. |
| `server/providers/claude-ollama.js` | **Create** | `ClaudeOllamaProvider` class. Spawns `ollama launch claude --model ... -- ...`, parses stream-json, manages sessions, acquires host mutex. |
| `server/providers/registry.js` | **Modify** | Add `'claude-ollama'` to `PROVIDER_CATEGORIES.codex` (CLI-spawned category). Register provider class. |
| `server/constants.js` | **Modify** | Add `claude-ollama` to `PROVIDER_DEFAULTS` with `enabled: false`. |
| `server/tests/claude-code-stream-parser.test.js` | **Create** | Unit tests for each extracted parser function. |
| `server/tests/claude-ollama.test.js` | **Create** | Provider unit tests: health, models, arg construction, stream parsing, session append. |
| `server/tests/claude-ollama-registry.test.js` | **Create** | Registration and constants tests. |
| `server/tests/claude-ollama-smoke.test.js` | **Create** | Gated smoke test against a real Ollama host. |
| `docs/guides/providers.md` | **Modify** | Add `claude-ollama` entry to the provider table. |
| `CLAUDE.md` | **Modify** | Add `claude-ollama` to the provider section with the local-only caveat. |

---

## Phase 1 — Extract shared stream parser (prep)

### Task 1: Extract stream-parser module with tests

**Files:**
- Create: `server/providers/claude-code/stream-parser.js`
- Create: `server/tests/claude-code-stream-parser.test.js`

**Context:** The functions below currently live inline in `server/providers/claude-code-sdk.js` (lines ~129-343). Extract them verbatim so both `claude-code-sdk.js` and the new `claude-ollama.js` can consume them. No behavior change.

- [ ] **Step 1.1: Write failing test file**

Create `server/tests/claude-code-stream-parser.test.js`:

```js
'use strict';

const { describe, it, expect } = require('vitest');
const parser = require('../providers/claude-code/stream-parser');

describe('stream-parser.normalizeUsage', () => {
  it('returns null when record has no usage field', () => {
    expect(parser.normalizeUsage({})).toBeNull();
    expect(parser.normalizeUsage(null)).toBeNull();
    expect(parser.normalizeUsage({ usage: null })).toBeNull();
  });

  it('extracts input/output/total token counts', () => {
    const result = parser.normalizeUsage({
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    });
    expect(result).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it('computes total_tokens when absent', () => {
    const result = parser.normalizeUsage({
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    });
    expect(result.total_tokens).toBe(10);
  });
});

describe('stream-parser.normalizeToolCall', () => {
  it('accepts type=tool_call records', () => {
    const result = parser.normalizeToolCall({
      type: 'tool_call',
      tool_call_id: 'abc',
      name: 'Read',
      args: { file_path: '/tmp/x' },
    });
    expect(result).toEqual({
      tool_call_id: 'abc',
      name: 'Read',
      args: { file_path: '/tmp/x' },
    });
  });

  it('accepts type=tool_use records and maps input→args', () => {
    const result = parser.normalizeToolCall({
      type: 'tool_use',
      id: 'xyz',
      name: 'Bash',
      input: { command: 'ls' },
    });
    expect(result.name).toBe('Bash');
    expect(result.args).toEqual({ command: 'ls' });
  });

  it('accepts content_block envelopes', () => {
    const result = parser.normalizeToolCall({
      content_block: { type: 'tool_use', id: 'cb1', name: 'Edit', input: { path: 'f' } },
    });
    expect(result.name).toBe('Edit');
  });

  it('returns null for non-tool records', () => {
    expect(parser.normalizeToolCall({ type: 'text_delta', delta: 'hi' })).toBeNull();
    expect(parser.normalizeToolCall(null)).toBeNull();
  });
});

describe('stream-parser.normalizeToolResult', () => {
  it('accepts tool_result records with content field', () => {
    const result = parser.normalizeToolResult({
      type: 'tool_result',
      tool_call_id: 'abc',
      result: 'file contents',
    });
    expect(result.tool_call_id).toBe('abc');
    expect(result.content).toBe('file contents');
    expect(result.error).toBeNull();
  });

  it('serializes non-string content to JSON', () => {
    const result = parser.normalizeToolResult({
      type: 'tool_result',
      tool_call_id: 'abc',
      output: { lines: 42 },
    });
    expect(result.content).toBe('{"lines":42}');
  });

  it('captures error field', () => {
    const result = parser.normalizeToolResult({
      type: 'tool_result',
      tool_call_id: 'abc',
      error: 'permission denied',
    });
    expect(result.error).toBe('permission denied');
  });
});

describe('stream-parser.extractTextDelta', () => {
  it('pulls text from text_delta records', () => {
    expect(parser.extractTextDelta({ type: 'text_delta', delta: 'hello' })).toBe('hello');
  });

  it('pulls text from content_block_delta.delta.text', () => {
    expect(parser.extractTextDelta({
      type: 'content_block_delta',
      delta: { text: ' world' },
    })).toBe(' world');
  });

  it('returns empty string for unrelated records', () => {
    expect(parser.extractTextDelta({ type: 'tool_call' })).toBe('');
    expect(parser.extractTextDelta(null)).toBe('');
  });
});

describe('stream-parser.extractFallbackText', () => {
  it('reads .text field', () => {
    expect(parser.extractFallbackText({ text: 'foo' })).toBe('foo');
  });

  it('reads .message.content string', () => {
    expect(parser.extractFallbackText({ message: { content: 'bar' } })).toBe('bar');
  });

  it('reads .content array with text blocks', () => {
    expect(parser.extractFallbackText({
      content: [{ type: 'text', text: 'baz' }, { type: 'text', text: 'qux' }],
    })).toBe('bazqux');
  });
});
```

- [ ] **Step 1.2: Run the failing test**

```bash
cd server && npx vitest run tests/claude-code-stream-parser.test.js
```

Expected: FAIL — `Cannot find module '../providers/claude-code/stream-parser'`.

- [ ] **Step 1.3: Create the stream-parser module**

Create `server/providers/claude-code/stream-parser.js` by copying these functions verbatim from `server/providers/claude-code-sdk.js`:

```js
'use strict';

const { randomUUID } = require('crypto');
const { EventType } = require('../../streaming/event-types');

function cleanText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function extractTextFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  let combined = '';
  for (const entry of content) {
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.text === 'string') {
      combined += entry.text;
      continue;
    }
    if (entry.type === 'text' && typeof entry.content === 'string') {
      combined += entry.content;
    }
  }
  return combined;
}

function normalizeToolCall(record) {
  if (!record || typeof record !== 'object') return null;

  if ((record.type === 'tool_call' || record.type === EventType.TOOL_CALL) && record.name) {
    return {
      tool_call_id: cleanText(record.tool_call_id) || cleanText(record.id) || `tool_${randomUUID()}`,
      name: cleanText(record.name),
      args: record.args && typeof record.args === 'object' ? record.args : {},
    };
  }

  if ((record.type === 'tool_use' || record.type === 'content_block_start') && record.name) {
    return {
      tool_call_id: cleanText(record.tool_call_id) || cleanText(record.id) || `tool_${randomUUID()}`,
      name: cleanText(record.name),
      args: record.input && typeof record.input === 'object'
        ? record.input
        : (record.args && typeof record.args === 'object' ? record.args : {}),
    };
  }

  const block = record.content_block;
  if (block && block.type === 'tool_use' && block.name) {
    return {
      tool_call_id: cleanText(block.id) || `tool_${randomUUID()}`,
      name: cleanText(block.name),
      args: block.input && typeof block.input === 'object' ? block.input : {},
    };
  }

  return null;
}

function normalizeToolResult(record) {
  if (!record || typeof record !== 'object') return null;

  const toContent = (value, error = null) => {
    if (value === undefined || value === null || value === '') {
      return error ? JSON.stringify({ error }) : '';
    }
    return typeof value === 'string' ? value : JSON.stringify(value);
  };

  if ((record.type === 'tool_result' || record.type === EventType.TOOL_RESULT) && (record.tool_call_id || record.id)) {
    const error = cleanText(record.error) || null;
    return {
      tool_call_id: cleanText(record.tool_call_id) || cleanText(record.id) || `tool_${randomUUID()}`,
      content: toContent(record.result ?? record.output ?? record.content, error),
      error,
    };
  }

  const block = record.content_block;
  if (block && block.type === 'tool_result') {
    const error = cleanText(block.error) || null;
    return {
      tool_call_id: cleanText(block.tool_use_id) || cleanText(block.tool_call_id) || cleanText(block.id) || `tool_${randomUUID()}`,
      content: toContent(block.content ?? block.result ?? block.output, error),
      error,
    };
  }

  return null;
}

function normalizeUsage(record) {
  if (!record || typeof record !== 'object') return null;
  const usage = record.usage && typeof record.usage === 'object' ? record.usage : null;
  if (!usage) return null;

  const promptTokens = Number(usage.input_tokens || usage.prompt_tokens || 0);
  const completionTokens = Number(usage.output_tokens || usage.completion_tokens || 0);
  const totalTokens = Number(usage.total_tokens || (promptTokens + completionTokens));

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
  };
}

function extractTextDelta(record) {
  if (!record || typeof record !== 'object') return '';

  if (record.type === 'text_delta' && typeof record.delta === 'string') {
    return record.delta;
  }

  if (record.type === 'content_block_delta' && typeof record.delta?.text === 'string') {
    return record.delta.text;
  }

  if (record.delta && typeof record.delta === 'string') {
    return record.delta;
  }

  return '';
}

function extractFallbackText(record) {
  if (!record || typeof record !== 'object') return '';

  if (typeof record.text === 'string') return record.text;
  if (typeof record.output === 'string') return record.output;
  if (typeof record.result === 'string') return record.result;
  if (typeof record.message === 'string') return record.message;

  if (record.message && typeof record.message === 'object') {
    if (typeof record.message.content === 'string') return record.message.content;
    const contentText = extractTextFromContent(record.message.content);
    if (contentText) return contentText;
  }

  const contentText = extractTextFromContent(record.content);
  if (contentText) return contentText;

  return '';
}

module.exports = {
  cleanText,
  extractTextFromContent,
  normalizeToolCall,
  normalizeToolResult,
  normalizeUsage,
  extractTextDelta,
  extractFallbackText,
};
```

- [ ] **Step 1.4: Run the tests again**

```bash
cd server && npx vitest run tests/claude-code-stream-parser.test.js
```

Expected: PASS — all test cases green.

- [ ] **Step 1.5: Commit**

```bash
git add server/providers/claude-code/stream-parser.js server/tests/claude-code-stream-parser.test.js
git commit -m "feat(providers): extract shared stream-parser module

Pure functions extracted verbatim from claude-code-sdk.js so they can be
reused by the upcoming claude-ollama provider. No behavior change yet —
claude-code-sdk.js still has inline copies until Task 2."
```

### Task 2: Refactor claude-code-sdk.js to import from stream-parser

**Files:**
- Modify: `server/providers/claude-code-sdk.js:27-343` — remove inline helper definitions, add `require('./claude-code/stream-parser')`

- [ ] **Step 2.1: Verify existing claude-code-sdk tests pass BEFORE refactor**

```bash
cd server && npx vitest run tests/claude-code-permission-chain.test.js tests/claude-code-session-store.test.js
```

Expected: PASS (baseline before refactor).

- [ ] **Step 2.2: Replace inline helpers with require**

Open `server/providers/claude-code-sdk.js`. Find the top of the file (around line 12):

```js
const { buildSafeEnv } = require('../utils/safe-env');
const { createSessionStore } = require('./claude-code/session-store');
```

Add right after those lines:

```js
const {
  cleanText,
  extractTextFromContent,
  normalizeToolCall,
  normalizeToolResult,
  normalizeUsage,
  extractTextDelta,
  extractFallbackText,
} = require('./claude-code/stream-parser');
```

Then delete the inline function definitions for these six functions at lines ~27-343 (exact span: `cleanText`, `extractTextFromContent`, `normalizeToolCall`, `normalizeToolResult`, `normalizeUsage`, `extractTextDelta`, `extractFallbackText`). Keep `safeJsonParse` and `uniqueStrings` inline — they are not moving.

Verify the file still has `cleanText` available — it's now imported from stream-parser.

- [ ] **Step 2.3: Run all claude-code-sdk related tests**

```bash
cd server && npx vitest run tests/claude-code-permission-chain.test.js tests/claude-code-session-store.test.js tests/claude-code-stream-parser.test.js
```

Expected: PASS — zero regressions, same test results as Step 2.1 plus the new parser tests.

- [ ] **Step 2.4: Commit**

```bash
git add server/providers/claude-code-sdk.js
git commit -m "refactor(providers): use shared stream-parser in claude-code-sdk

Removes inline copies of normalizeToolCall/normalizeToolResult/
normalizeUsage/extractTextDelta/extractFallbackText/extractTextFromContent
in favor of the extracted module. Pure refactor; behavior unchanged."
```

---

## Phase 2 — ClaudeOllamaProvider

### Task 3: Provider class skeleton

**Files:**
- Create: `server/providers/claude-ollama.js`
- Create: `server/tests/claude-ollama.test.js`

- [ ] **Step 3.1: Write failing skeleton test**

Create `server/tests/claude-ollama.test.js`:

```js
'use strict';

const { describe, it, expect } = require('vitest');
const ClaudeOllamaProvider = require('../providers/claude-ollama');

describe('ClaudeOllamaProvider — construction', () => {
  it('has provider name "claude-ollama"', () => {
    const p = new ClaudeOllamaProvider();
    expect(p.name).toBe('claude-ollama');
  });

  it('defaults to enabled=false (opt-in provider)', () => {
    const p = new ClaudeOllamaProvider();
    expect(p.enabled).toBe(false);
  });

  it('respects config.enabled=true', () => {
    const p = new ClaudeOllamaProvider({ enabled: true });
    expect(p.enabled).toBe(true);
  });

  it('exposes supportsStreaming=true', () => {
    const p = new ClaudeOllamaProvider();
    expect(p.supportsStreaming).toBe(true);
  });

  it('derives providerId for config lookups', () => {
    const p = new ClaudeOllamaProvider();
    expect(p.providerId).toBe('claude-ollama');
  });
});
```

- [ ] **Step 3.2: Run failing test**

```bash
cd server && npx vitest run tests/claude-ollama.test.js
```

Expected: FAIL — `Cannot find module '../providers/claude-ollama'`.

- [ ] **Step 3.3: Create skeleton file**

Create `server/providers/claude-ollama.js`:

```js
'use strict';

const path = require('path');
const { randomUUID } = require('crypto');
const { spawn, spawnSync } = require('child_process');

const BaseProvider = require('./base');
const hostManagement = require('../db/host-management');
const { getDataDir } = require('../data-dir');
const { EventType } = require('../streaming/event-types');
const { buildSafeEnv } = require('../utils/safe-env');
const { createSessionStore } = require('./claude-code/session-store');
const { evaluatePermission } = require('./claude-code/permission-chain');
const { acquireHostLock } = require('./host-mutex');
const {
  cleanText,
  normalizeToolCall,
  normalizeToolResult,
  normalizeUsage,
  extractTextDelta,
  extractFallbackText,
} = require('./claude-code/stream-parser');

const DEFAULT_MODE = 'auto';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const SUPPORTED_PERMISSION_MODES = new Set(['auto', 'acceptEdits', 'plan', 'bypassPermissions']);

function safeJsonParse(text, fallback = null) {
  try { return JSON.parse(text); } catch { return fallback; }
}

class ClaudeOllamaProvider extends BaseProvider {
  constructor(config = {}) {
    super({
      name: 'claude-ollama',
      enabled: config.enabled === true,
      maxConcurrent: config.maxConcurrent || 1,
    });
    this.providerId = 'claude-ollama';
    this.ollamaBinary = config.ollamaBinary || null;
    this.claudeBinary = config.claudeBinary || null;
    this.sessionsRoot = config.sessionsRoot || path.join(getDataDir(), 'claude-ollama-sessions');
    this.sessionStore = createSessionStore({ rootDir: this.sessionsRoot });
    this.activeSessionId = null;
  }

  get supportsStreaming() {
    return true;
  }
}

module.exports = ClaudeOllamaProvider;
```

- [ ] **Step 3.4: Run tests again**

```bash
cd server && npx vitest run tests/claude-ollama.test.js
```

Expected: PASS.

- [ ] **Step 3.5: Commit**

```bash
git add server/providers/claude-ollama.js server/tests/claude-ollama.test.js
git commit -m "feat(providers): ClaudeOllamaProvider class skeleton

Minimal subclass of BaseProvider. Disabled by default; sessions root
lives under <dataDir>/claude-ollama-sessions separate from claude-code-sdk.
No execution logic yet."
```

### Task 4: checkHealth — CLI + host preflight

**Files:**
- Modify: `server/providers/claude-ollama.js` — add `resolveOllamaBinary`, `resolveClaudeBinary`, `checkHealth`
- Modify: `server/tests/claude-ollama.test.js` — add health tests

**Context:** The provider is available only when all three are satisfied: (1) `ollama` binary on PATH, (2) `claude` binary on PATH, (3) at least one active Ollama host with at least one non-cloud local model. Each failure emits a distinct error.

- [ ] **Step 4.1: Add failing health tests**

Append to `server/tests/claude-ollama.test.js`:

```js
const { vi } = require('vitest');
const child_process = require('child_process');
const hostManagement = require('../db/host-management');

describe('ClaudeOllamaProvider.checkHealth', () => {
  it('returns unavailable when ollama binary is missing', async () => {
    const spawnSyncSpy = vi.spyOn(child_process, 'spawnSync').mockImplementation((bin) => {
      if (String(bin).includes('ollama')) return { status: 1, stderr: 'not found' };
      return { status: 0, stdout: '2.1.0' };
    });
    const p = new ClaudeOllamaProvider({ enabled: true });
    const health = await p.checkHealth();
    expect(health.available).toBe(false);
    expect(health.error).toMatch(/ollama/i);
    spawnSyncSpy.mockRestore();
  });

  it('returns unavailable when claude binary is missing', async () => {
    const spawnSyncSpy = vi.spyOn(child_process, 'spawnSync').mockImplementation((bin) => {
      if (String(bin).includes('claude')) return { status: 1, stderr: 'not found' };
      return { status: 0, stdout: 'ollama version 0.20.7' };
    });
    const p = new ClaudeOllamaProvider({ enabled: true });
    const health = await p.checkHealth();
    expect(health.available).toBe(false);
    expect(health.error).toMatch(/claude/i);
    spawnSyncSpy.mockRestore();
  });

  it('returns unavailable when no active Ollama host has local models', async () => {
    const spawnSyncSpy = vi.spyOn(child_process, 'spawnSync').mockReturnValue({ status: 0, stdout: 'v1' });
    const hostsSpy = vi.spyOn(hostManagement, 'listOllamaHosts').mockReturnValue([]);
    const p = new ClaudeOllamaProvider({ enabled: true });
    const health = await p.checkHealth();
    expect(health.available).toBe(false);
    expect(health.error).toMatch(/no.*host/i);
    spawnSyncSpy.mockRestore();
    hostsSpy.mockRestore();
  });
});
```

- [ ] **Step 4.2: Run tests — confirm failure**

```bash
cd server && npx vitest run tests/claude-ollama.test.js
```

Expected: FAIL — `checkHealth is not a function`.

- [ ] **Step 4.3: Implement checkHealth**

Add to `server/providers/claude-ollama.js`, inside the class:

```js
  resolveOllamaBinary() {
    if (this.ollamaBinary) return this.ollamaBinary;
    return process.platform === 'win32' ? 'ollama.exe' : 'ollama';
  }

  resolveClaudeBinary() {
    if (this.claudeBinary) return this.claudeBinary;
    return process.platform === 'win32' ? 'claude.exe' : 'claude';
  }

  async checkHealth() {
    const ollamaResult = spawnSync(this.resolveOllamaBinary(), ['--version'], {
      timeout: 5000, encoding: 'utf8', windowsHide: true,
    });
    if (ollamaResult.status !== 0) {
      return {
        available: false,
        models: [],
        error: `ollama binary not reachable: ${cleanText(ollamaResult.stderr) || cleanText(ollamaResult.stdout) || 'unknown error'}`,
      };
    }

    const claudeResult = spawnSync(this.resolveClaudeBinary(), ['--version'], {
      timeout: 5000, encoding: 'utf8', windowsHide: true,
    });
    if (claudeResult.status !== 0) {
      return {
        available: false,
        models: [],
        error: `claude binary not reachable: ${cleanText(claudeResult.stderr) || cleanText(claudeResult.stdout) || 'unknown error'}`,
      };
    }

    const hosts = hostManagement.listOllamaHosts({ enabled: true }) || [];
    if (hosts.length === 0) {
      return { available: false, models: [], error: 'no active Ollama host registered' };
    }

    const models = await this.listModels();
    if (models.length === 0) {
      return { available: false, models: [], error: 'no local models available on any host' };
    }

    return { available: true, models, version: `${cleanText(ollamaResult.stdout)} / ${cleanText(claudeResult.stdout)}` };
  }
```

(Note: `listModels` is implemented in Task 5. The "no local models available" case can't fully pass until then; that's expected.)

- [ ] **Step 4.4: Run tests — first two cases should now pass**

```bash
cd server && npx vitest run tests/claude-ollama.test.js
```

Expected: "ollama missing" and "claude missing" cases PASS. "no host with models" case PASSES once empty host list short-circuits (the function returns "no active Ollama host" before calling listModels).

- [ ] **Step 4.5: Commit**

```bash
git add server/providers/claude-ollama.js server/tests/claude-ollama.test.js
git commit -m "feat(claude-ollama): checkHealth preflight

Validates ollama + claude binaries on PATH and at least one active
Ollama host before reporting available. Distinct error messages per
failing precondition."
```

### Task 5: listModels — cloud-tag filtering

**Files:**
- Modify: `server/providers/claude-ollama.js` — add `listModels`
- Modify: `server/tests/claude-ollama.test.js` — add listModels tests

- [ ] **Step 5.1: Write failing tests**

Append to the test file (use reserved-for-testing TLDs to avoid PII hook blocks):

```js
describe('ClaudeOllamaProvider.listModels', () => {
  it('returns union of local models across all active hosts', async () => {
    const hostsSpy = vi.spyOn(hostManagement, 'listOllamaHosts').mockReturnValue([
      { id: 'h1', name: 'HostA', url: 'http://host-a.test:11434', enabled: 1 },
      { id: 'h2', name: 'HostB', url: 'http://host-b.test:11434', enabled: 1 },
    ]);
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      if (url.includes('host-a')) return { ok: true, json: async () => ({ models: [
        { name: 'qwen3-coder:30b' }, { name: 'gemma4:latest' },
      ] }) };
      return { ok: true, json: async () => ({ models: [
        { name: 'qwen3.5:latest' }, { name: 'gemma4:latest' },
      ] }) };
    });
    const p = new ClaudeOllamaProvider({ enabled: true });
    const models = await p.listModels();
    expect(models.sort()).toEqual(['gemma4:latest', 'qwen3-coder:30b', 'qwen3.5:latest']);
    hostsSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  it('filters out cloud-tagged models', async () => {
    const hostsSpy = vi.spyOn(hostManagement, 'listOllamaHosts').mockReturnValue([
      { id: 'h1', url: 'http://host-a.test:11434', enabled: 1 },
    ]);
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true, json: async () => ({ models: [
        { name: 'qwen3-coder:30b' },
        { name: 'qwen3-coder:480b-cloud' },
        { name: 'gpt-oss:120b-cloud' },
      ] }),
    });
    const p = new ClaudeOllamaProvider({ enabled: true });
    const models = await p.listModels();
    expect(models).toEqual(['qwen3-coder:30b']);
    hostsSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  it('returns empty array when no hosts are registered', async () => {
    const hostsSpy = vi.spyOn(hostManagement, 'listOllamaHosts').mockReturnValue([]);
    const p = new ClaudeOllamaProvider({ enabled: true });
    expect(await p.listModels()).toEqual([]);
    hostsSpy.mockRestore();
  });

  it('skips a host whose /api/tags fails', async () => {
    const hostsSpy = vi.spyOn(hostManagement, 'listOllamaHosts').mockReturnValue([
      { id: 'h1', url: 'http://host-a.test:11434', enabled: 1 },
      { id: 'h2', url: 'http://host-b.test:11434', enabled: 1 },
    ]);
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      if (url.includes('host-a')) throw new Error('ECONNREFUSED');
      return { ok: true, json: async () => ({ models: [{ name: 'qwen3.5:latest' }] }) };
    });
    const p = new ClaudeOllamaProvider({ enabled: true });
    const models = await p.listModels();
    expect(models).toEqual(['qwen3.5:latest']);
    hostsSpy.mockRestore();
    fetchSpy.mockRestore();
  });
});
```

- [ ] **Step 5.2: Run tests — confirm failure**

Expected: all four new cases FAIL with `listModels is not a function`.

- [ ] **Step 5.3: Implement listModels**

Add inside the class in `server/providers/claude-ollama.js`:

```js
  async listModels() {
    const hosts = hostManagement.listOllamaHosts({ enabled: true }) || [];
    const union = new Set();
    for (const host of hosts) {
      const url = cleanText(host.url);
      if (!url) continue;
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        const resp = await fetch(`${url.replace(/\/$/, '')}/api/tags`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!resp.ok) continue;
        const data = await resp.json();
        const models = Array.isArray(data?.models) ? data.models : [];
        for (const m of models) {
          const name = cleanText(m?.name);
          if (!name) continue;
          if (name.endsWith('-cloud')) continue;
          union.add(name);
        }
      } catch {
        // host unreachable — skip, don't fail the whole listing
      }
    }
    return Array.from(union).sort();
  }
```

- [ ] **Step 5.4: Run tests — all listModels cases should pass**

```bash
cd server && npx vitest run tests/claude-ollama.test.js
```

Expected: all four listModels tests PASS.

- [ ] **Step 5.5: Commit**

```bash
git add server/providers/claude-ollama.js server/tests/claude-ollama.test.js
git commit -m "feat(claude-ollama): listModels from host /api/tags union

Queries every enabled Ollama host's /api/tags, unions the model names,
filters out *-cloud tags (unreachable via the launcher bridge), tolerates
unreachable hosts."
```

### Task 6: buildCommandArgs — full argv construction

**Files:**
- Modify: `server/providers/claude-ollama.js` — add `buildCommandArgs` method
- Modify: `server/tests/claude-ollama.test.js` — add arg-building tests

**Context:** Produces the argv passed to `spawn(ollama, [...args])`. Structure:
`launch claude --model <m> -- -p --output-format stream-json --include-partial-messages [permission flags] [tool flags] [session flags] [skill prompt] [working dir]`

- [ ] **Step 6.1: Write failing tests**

```js
describe('ClaudeOllamaProvider.buildCommandArgs', () => {
  it('includes launch/claude/model and the -- passthrough boundary', () => {
    const p = new ClaudeOllamaProvider();
    const args = p.buildCommandArgs({
      model: 'qwen3-coder:30b',
      workingDirectory: '/tmp/wd',
      permissionMode: 'auto',
      allowedTools: [],
      disallowedTools: [],
      claudeSessionId: 'cs1',
      messageCount: 0,
    });
    expect(args[0]).toBe('launch');
    expect(args[1]).toBe('claude');
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('qwen3-coder:30b');
    expect(args).toContain('--');
    const postDash = args.slice(args.indexOf('--') + 1);
    expect(postDash).toContain('--output-format');
    expect(postDash[postDash.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(postDash).toContain('-p');
  });

  it('emits --add-dir with the working directory', () => {
    const p = new ClaudeOllamaProvider();
    const args = p.buildCommandArgs({
      model: 'qwen3-coder:30b',
      workingDirectory: '/tmp/wd',
      permissionMode: 'auto',
      allowedTools: [], disallowedTools: [],
      claudeSessionId: 'cs1', messageCount: 0,
    });
    const idx = args.indexOf('--add-dir');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('/tmp/wd');
  });

  it('emits --allowed-tools / --disallowed-tools when non-empty', () => {
    const p = new ClaudeOllamaProvider();
    const args = p.buildCommandArgs({
      model: 'qwen3-coder:30b',
      workingDirectory: '/tmp/wd',
      permissionMode: 'auto',
      allowedTools: ['Read', 'Edit'],
      disallowedTools: ['Bash'],
      claudeSessionId: 'cs1', messageCount: 0,
    });
    expect(args[args.indexOf('--allowed-tools') + 1]).toBe('Read,Edit');
    expect(args[args.indexOf('--disallowed-tools') + 1]).toBe('Bash');
  });

  it('uses --session-id for a new session (messageCount=0)', () => {
    const p = new ClaudeOllamaProvider();
    const args = p.buildCommandArgs({
      model: 'qwen3-coder:30b',
      workingDirectory: '/tmp/wd',
      permissionMode: 'auto',
      allowedTools: [], disallowedTools: [],
      claudeSessionId: 'cs-new', messageCount: 0,
    });
    expect(args).toContain('--session-id');
    expect(args[args.indexOf('--session-id') + 1]).toBe('cs-new');
    expect(args).not.toContain('--resume');
  });

  it('uses --resume when messageCount > 0', () => {
    const p = new ClaudeOllamaProvider();
    const args = p.buildCommandArgs({
      model: 'qwen3-coder:30b',
      workingDirectory: '/tmp/wd',
      permissionMode: 'auto',
      allowedTools: [], disallowedTools: [],
      claudeSessionId: 'cs-existing', messageCount: 3,
    });
    expect(args).toContain('--resume');
    expect(args[args.indexOf('--resume') + 1]).toBe('cs-existing');
    expect(args).not.toContain('--session-id');
  });

  it('includes --append-system-prompt when skillPrompt is provided', () => {
    const p = new ClaudeOllamaProvider();
    const args = p.buildCommandArgs({
      model: 'qwen3-coder:30b',
      workingDirectory: '/tmp/wd',
      permissionMode: 'auto',
      allowedTools: [], disallowedTools: [],
      claudeSessionId: 'cs1', messageCount: 0,
      skillPrompt: 'Follow the docstring style guide.',
    });
    const idx = args.indexOf('--append-system-prompt');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('Follow the docstring style guide.');
  });
});
```

- [ ] **Step 6.2: Run tests — confirm failure**

Expected: FAIL — `buildCommandArgs is not a function`.

- [ ] **Step 6.3: Implement buildCommandArgs**

Add inside the class:

```js
  buildCommandArgs({
    model,
    workingDirectory,
    permissionMode,
    allowedTools,
    disallowedTools,
    skillPrompt,
    claudeSessionId,
    messageCount,
  }) {
    const args = ['launch', 'claude', '--model', cleanText(model), '--'];

    // claude-cli flags follow the -- boundary
    args.push(
      '-p',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--strict-mcp-config',
    );

    if (cleanText(permissionMode) && SUPPORTED_PERMISSION_MODES.has(permissionMode)) {
      args.push('--permission-mode', permissionMode);
    }
    if (allowedTools && allowedTools.length > 0) {
      args.push('--allowed-tools', allowedTools.join(','));
    }
    if (disallowedTools && disallowedTools.length > 0) {
      args.push('--disallowed-tools', disallowedTools.join(','));
    }
    if (cleanText(skillPrompt)) {
      args.push('--append-system-prompt', skillPrompt);
    }
    if (cleanText(workingDirectory)) {
      args.push('--add-dir', workingDirectory);
    }

    const sid = cleanText(claudeSessionId);
    if (messageCount > 0) {
      args.push('--resume', sid);
    } else {
      args.push('--session-id', sid);
    }

    return args;
  }
```

- [ ] **Step 6.4: Run tests**

```bash
cd server && npx vitest run tests/claude-ollama.test.js
```

Expected: all buildCommandArgs tests PASS.

- [ ] **Step 6.5: Commit**

```bash
git add server/providers/claude-ollama.js server/tests/claude-ollama.test.js
git commit -m "feat(claude-ollama): buildCommandArgs constructs ollama launch argv

Produces the full argv for 'ollama launch claude --model M -- ...' with
claude-cli flags after the -- boundary: stream-json output, permission
mode, allowed/disallowed tools, session-id or resume, skill prompt,
working dir."
```

### Task 7a: runPrompt — spawn and collect plain text output

**Files:**
- Modify: `server/providers/claude-ollama.js` — add `ensureSession`, `readSessionMeta`, `runPrompt` (text-only version)
- Modify: `server/tests/claude-ollama.test.js` — add runPrompt text test

- [ ] **Step 7a.1: Add failing test**

```js
describe('ClaudeOllamaProvider.runPrompt — simple text', () => {
  it('spawns with correct binary+args and returns collected output', async () => {
    const p = new ClaudeOllamaProvider({ enabled: true });
    const fakeStdout = [
      { type: 'text_delta', delta: 'Hello ' },
      { type: 'text_delta', delta: 'world' },
      { usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } },
    ].map(JSON.stringify).join('\n') + '\n';

    const spawnSpy = vi.spyOn(child_process, 'spawn').mockImplementation(() => {
      const { EventEmitter } = require('events');
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { end: vi.fn() };
      child.kill = vi.fn();
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(fakeStdout));
        child.emit('close', 0, null);
      });
      return child;
    });

    const result = await p.runPrompt('say hello', 'qwen3-coder:30b', {
      working_directory: '/tmp/wd',
    });
    expect(result.output).toBe('Hello world');
    expect(result.status).toBe('completed');
    expect(result.usage.total_tokens).toBe(7);
    expect(result.usage.model).toBe('qwen3-coder:30b');
    spawnSpy.mockRestore();
  });
});
```

- [ ] **Step 7a.2: Add session helpers and runPrompt skeleton**

Add inside the class (before the closing `}`):

```js
  ensureSession({ sessionId = null, workingDirectory = process.cwd() } = {}) {
    let localSessionId = cleanText(sessionId);
    if (!localSessionId) {
      localSessionId = this.sessionStore.create({
        name: 'claude-ollama',
        metadata: {
          claude_session_id: randomUUID(),
          working_directory: workingDirectory,
        },
      });
    }
    if (!this.sessionStore.exists(localSessionId)) {
      throw new Error(`Unknown Claude-Ollama session: ${localSessionId}`);
    }
    this.activeSessionId = localSessionId;
    return localSessionId;
  }

  readSessionMeta(sessionId) {
    const metaPath = path.join(this.sessionsRoot, sessionId, 'meta.json');
    try {
      const parsed = JSON.parse(require('fs').readFileSync(metaPath, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : { metadata: {} };
    } catch {
      return { metadata: {} };
    }
  }

  async runPrompt(prompt, model, options = {}) {
    const workingDirectory = cleanText(options.working_directory) || process.cwd();
    const rawPromptText = cleanText(prompt);
    if (!rawPromptText) throw new Error('prompt must be a non-empty string');

    const localSessionId = this.ensureSession({
      sessionId: options.session_id,
      workingDirectory,
    });
    const sessionMeta = this.readSessionMeta(localSessionId);
    const claudeSessionId = cleanText(sessionMeta.metadata?.claude_session_id) || randomUUID();
    const messageCount = this.sessionStore.readAll(localSessionId).length;

    const permissionMode = SUPPORTED_PERMISSION_MODES.has(cleanText(options.mode))
      ? cleanText(options.mode) : DEFAULT_MODE;
    const allowedTools = Array.isArray(options.allowed_tools) ? options.allowed_tools : [];
    const disallowedTools = Array.isArray(options.disallowed_tools) ? options.disallowed_tools : [];

    const commandArgs = this.buildCommandArgs({
      model, workingDirectory, permissionMode,
      allowedTools, disallowedTools,
      skillPrompt: cleanText(options.skill_prompt),
      claudeSessionId, messageCount,
    });

    const timeoutMs = Number(options.timeout_ms) > 0 ? Number(options.timeout_ms) : DEFAULT_TIMEOUT_MS;
    const startTime = Date.now();

    const result = await new Promise((resolve, reject) => {
      const child = spawn(this.resolveOllamaBinary(), commandArgs, {
        cwd: workingDirectory,
        env: buildSafeEnv(this.providerId, {
          FORCE_COLOR: '0', NO_COLOR: '1', TERM: 'dumb', CI: '1',
          CLAUDE_NON_INTERACTIVE: '1', PYTHONIOENCODING: 'utf-8',
        }),
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdoutRemainder = '';
      let aggregatedText = '';
      const stderrChunks = [];
      let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      let settled = false;
      let timeoutHandle = null;

      const finish = (fn, v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        fn(v);
      };

      const handleRecord = (rec) => {
        const u = normalizeUsage(rec);
        if (u) usage = { ...usage, ...u };
        const delta = extractTextDelta(rec);
        if (delta) aggregatedText += delta;
      };

      child.stdout.on('data', (chunk) => {
        stdoutRemainder += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        const lines = stdoutRemainder.split(/\r?\n/);
        stdoutRemainder = lines.pop() || '';
        for (const line of lines) {
          const trimmed = cleanText(line);
          if (!trimmed || trimmed === '[DONE]') continue;
          const parsed = safeJsonParse(trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed);
          if (parsed) handleRecord(parsed);
        }
      });

      child.stderr.on('data', (c) => stderrChunks.push(Buffer.isBuffer(c) ? c.toString('utf8') : String(c)));

      child.once('error', (err) => finish(reject, err));
      child.once('close', (code, signal) => {
        if (stdoutRemainder) {
          const parsed = safeJsonParse(stdoutRemainder);
          if (parsed) handleRecord(parsed);
        }
        if (code !== 0) {
          const stderrText = stderrChunks.join('');
          finish(reject, new Error(`claude-ollama exited with status ${code}${signal ? ` (${signal})` : ''}: ${stderrText || aggregatedText || 'unknown error'}`));
          return;
        }
        finish(resolve, { output: aggregatedText, usage, stderr: stderrChunks.join('') });
      });

      timeoutHandle = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        finish(reject, new Error(`claude-ollama timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdin.end(rawPromptText, 'utf8');
    });

    const durationMs = Date.now() - startTime;
    return {
      output: result.output,
      status: 'completed',
      session_id: localSessionId,
      claude_session_id: claudeSessionId,
      usage: {
        input_tokens: result.usage.prompt_tokens || 0,
        output_tokens: result.usage.completion_tokens || 0,
        total_tokens: result.usage.total_tokens || 0,
        tokens: result.usage.total_tokens || 0,
        cost: 0,
        duration_ms: durationMs,
        model: cleanText(model),
      },
    };
  }
```

- [ ] **Step 7a.3: Run test**

```bash
cd server && npx vitest run tests/claude-ollama.test.js
```

Expected: text-only test PASSES.

- [ ] **Step 7a.4: Commit**

```bash
git add server/providers/claude-ollama.js server/tests/claude-ollama.test.js
git commit -m "feat(claude-ollama): runPrompt spawn + text collection

Spawns ollama launch claude, parses stream-json text_delta records,
aggregates text output, collects usage, returns BaseProvider-shaped
result. Handles stdout line buffering, stderr collection, timeout,
and process error events."
```

### Task 7b: runPrompt — tool-call permission handling

**Files:**
- Modify: `server/providers/claude-ollama.js` — extend `runPrompt` with tool-call permission path
- Modify: `server/tests/claude-ollama.test.js` — add permission test

- [ ] **Step 7b.1: Failing test for denied tool**

```js
describe('ClaudeOllamaProvider.runPrompt — tool permission', () => {
  it('rejects with an error when a disallowed tool is requested', async () => {
    const p = new ClaudeOllamaProvider({ enabled: true });
    const events = [
      { type: 'tool_call', tool_call_id: 't1', name: 'Bash', args: { cmd: 'rm -rf /' } },
    ].map(JSON.stringify).join('\n') + '\n';

    const spawnSpy = vi.spyOn(child_process, 'spawn').mockImplementation(() => {
      const { EventEmitter } = require('events');
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { end: vi.fn() };
      child.kill = vi.fn(() => setImmediate(() => child.emit('close', 137, 'SIGKILL')));
      setImmediate(() => child.stdout.emit('data', Buffer.from(events)));
      return child;
    });

    await expect(p.runPrompt('test', 'qwen3-coder:30b', {
      working_directory: '/tmp/wd',
      disallowed_tools: ['Bash'],
    })).rejects.toThrow(/Bash.*denied/);

    spawnSpy.mockRestore();
  });
});
```

- [ ] **Step 7b.2: Wire permission check into handleRecord**

Extend the Promise-internal state in `runPrompt` (add these declarations near the top of the Promise body):

```js
      let permissionDeniedError = null;
      let processing = Promise.resolve();
```

Replace the `handleRecord` function with the async variant:

```js
      const handleRecord = async (rec) => {
        const u = normalizeUsage(rec);
        if (u) usage = { ...usage, ...u };

        const toolCall = normalizeToolCall(rec);
        if (toolCall) {
          const permission = await evaluatePermission({
            toolName: toolCall.name,
            args: toolCall.args,
            settings: { allowed_tools: allowedTools, disallowed_tools: disallowedTools },
            mode: permissionMode,
            hooks: Array.isArray(options.hooks) ? options.hooks : [],
            canUseTool: typeof options.canUseTool === 'function' ? options.canUseTool : null,
          });
          if (permission.decision !== 'allow') {
            permissionDeniedError = new Error(
              `Claude tool "${toolCall.name}" denied by ${permission.source}: ${permission.reason}`,
            );
            try { child.kill(); } catch { /* ignore */ }
            return;
          }
          if (typeof options.onEvent === 'function') {
            await options.onEvent({
              type: EventType.TOOL_CALL,
              tool_call_id: toolCall.tool_call_id,
              name: toolCall.name,
              args: toolCall.args,
              permission,
            });
          }
        }

        const delta = extractTextDelta(rec);
        if (delta) {
          aggregatedText += delta;
          if (typeof options.onChunk === 'function') await options.onChunk(delta);
        }

        const toolResult = normalizeToolResult(rec);
        if (toolResult && typeof options.onEvent === 'function') {
          await options.onEvent({
            type: EventType.TOOL_RESULT,
            tool_call_id: toolResult.tool_call_id,
            ...(toolResult.error ? { error: toolResult.error } : { result: toolResult.content }),
          });
        }
      };
```

Update the stdout handler to serialize async record handling through the `processing` chain:

```js
      child.stdout.on('data', (chunk) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        processing = processing.then(async () => {
          stdoutRemainder += text;
          const lines = stdoutRemainder.split(/\r?\n/);
          stdoutRemainder = lines.pop() || '';
          for (const line of lines) {
            const trimmed = cleanText(line);
            if (!trimmed || trimmed === '[DONE]') continue;
            const parsed = safeJsonParse(trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed);
            if (parsed) await handleRecord(parsed);
            if (permissionDeniedError) return;
          }
        });
      });
```

In the `close` handler, wait for `processing` before finalizing and honor `permissionDeniedError`:

```js
      child.once('close', (code, signal) => {
        processing = processing.then(async () => {
          if (stdoutRemainder) {
            const parsed = safeJsonParse(stdoutRemainder);
            if (parsed) await handleRecord(parsed);
            stdoutRemainder = '';
          }
          if (permissionDeniedError) {
            finish(reject, permissionDeniedError);
            return;
          }
          if (code !== 0) {
            const stderrText = stderrChunks.join('');
            finish(reject, new Error(`claude-ollama exited with status ${code}${signal ? ` (${signal})` : ''}: ${stderrText || aggregatedText || 'unknown error'}`));
            return;
          }
          finish(resolve, { output: aggregatedText, usage, stderr: stderrChunks.join('') });
        });
      });
```

- [ ] **Step 7b.3: Run tests**

```bash
cd server && npx vitest run tests/claude-ollama.test.js
```

Expected: permission test PASSES; earlier text-only test still PASSES.

- [ ] **Step 7b.4: Commit**

```bash
git add server/providers/claude-ollama.js server/tests/claude-ollama.test.js
git commit -m "feat(claude-ollama): tool-call permission enforcement

Intercepts tool_call records via evaluatePermission. On deny, kills
the spawned subprocess and rejects with a specific error naming the
tool and rejection source. Accepted tool calls propagate to onEvent.
Serializes async record handling through a promise chain."
```

### Task 7c: runPrompt — session + transcript append

**Files:**
- Modify: `server/providers/claude-ollama.js` — append user/assistant messages to session store
- Modify: `server/tests/claude-ollama.test.js` — add session append test

- [ ] **Step 7c.1: Failing test**

```js
describe('ClaudeOllamaProvider.runPrompt — session append', () => {
  it('appends user and assistant messages to the session store', async () => {
    const p = new ClaudeOllamaProvider({ enabled: true });
    const fakeStdout = JSON.stringify({ type: 'text_delta', delta: 'OK' }) + '\n';
    const spawnSpy = vi.spyOn(child_process, 'spawn').mockImplementation(() => {
      const { EventEmitter } = require('events');
      const c = new EventEmitter();
      c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
      c.stdin = { end: vi.fn() }; c.kill = vi.fn();
      setImmediate(() => { c.stdout.emit('data', Buffer.from(fakeStdout)); c.emit('close', 0, null); });
      return c;
    });

    const result = await p.runPrompt('ping', 'qwen3-coder:30b', {
      working_directory: '/tmp/wd',
    });
    const messages = p.sessionStore.readAll(result.session_id);
    const roles = messages.map(m => m.role);
    expect(roles).toEqual(['user', 'assistant']);
    expect(messages[0].content).toBe('ping');
    expect(messages[1].content).toBe('OK');
    spawnSpy.mockRestore();
  });
});
```

- [ ] **Step 7c.2: Append session messages in runPrompt**

At the top of `runPrompt`, after `this.ensureSession`, append the user message:

```js
    this.sessionStore.append(localSessionId, {
      role: 'user',
      content: rawPromptText,
      timestamp: new Date().toISOString(),
    });
```

After the Promise resolves, append the assistant message:

```js
    this.sessionStore.append(localSessionId, {
      role: 'assistant',
      content: result.output,
      timestamp: new Date().toISOString(),
    });
```

- [ ] **Step 7c.3: Run tests; commit**

```bash
cd server && npx vitest run tests/claude-ollama.test.js
git add server/providers/claude-ollama.js server/tests/claude-ollama.test.js
git commit -m "feat(claude-ollama): session store append

Writes user prompt and assistant response into the session store so
message history survives across runPrompt calls within a session."
```

### Task 8: Public API — submit, submitStream, dispatchSubagent

**Files:**
- Modify: `server/providers/claude-ollama.js`
- Modify: `server/tests/claude-ollama.test.js`

- [ ] **Step 8.1: Failing tests**

```js
describe('ClaudeOllamaProvider — public API', () => {
  it('submit delegates to runPrompt', async () => {
    const p = new ClaudeOllamaProvider({ enabled: true });
    const spy = vi.spyOn(p, 'runPrompt').mockResolvedValue({ output: 'ok', status: 'completed', usage: {} });
    await p.submit('task', 'qwen3-coder:30b', { working_directory: '/tmp' });
    expect(spy).toHaveBeenCalledWith('task', 'qwen3-coder:30b', { working_directory: '/tmp' });
    spy.mockRestore();
  });

  it('submitStream delegates to runPrompt', async () => {
    const p = new ClaudeOllamaProvider({ enabled: true });
    const spy = vi.spyOn(p, 'runPrompt').mockResolvedValue({ output: 'ok', status: 'completed', usage: {} });
    await p.submitStream('task', 'qwen3-coder:30b', { working_directory: '/tmp' });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('dispatchSubagent forwards prompt and returns structured result', async () => {
    const p = new ClaudeOllamaProvider({ enabled: true });
    const spy = vi.spyOn(p, 'submit').mockResolvedValue({
      output: 'done', status: 'completed', session_id: 's1',
      claude_session_id: 'cs1', usage: { tokens: 10 },
    });
    const res = await p.dispatchSubagent({ prompt: 'go', model: 'qwen3-coder:30b' });
    expect(res.output).toBe('done');
    expect(res.session_id).toBe('s1');
    spy.mockRestore();
  });

  it('dispatchSubagent rejects empty prompt', async () => {
    const p = new ClaudeOllamaProvider({ enabled: true });
    await expect(p.dispatchSubagent({ prompt: '' })).rejects.toThrow(/non-empty/);
  });
});
```

- [ ] **Step 8.2: Add delegates**

```js
  async submit(task, model, options = {}) {
    return this.runPrompt(task, model, options);
  }

  async submitStream(task, model, options = {}) {
    return this.runPrompt(task, model, options);
  }

  async dispatchSubagent(options = {}) {
    const prompt = cleanText(options.prompt);
    if (!prompt) throw new Error('prompt must be a non-empty string');
    const response = await this.submit(prompt, options.model || null, options);
    return {
      session_id: response.session_id,
      claude_session_id: response.claude_session_id,
      output: response.output,
      usage: response.usage,
      mode: SUPPORTED_PERMISSION_MODES.has(cleanText(options.mode)) ? cleanText(options.mode) : DEFAULT_MODE,
    };
  }
```

- [ ] **Step 8.3: Run tests; commit**

```bash
cd server && npx vitest run tests/claude-ollama.test.js
git add server/providers/claude-ollama.js server/tests/claude-ollama.test.js
git commit -m "feat(claude-ollama): submit/submitStream/dispatchSubagent surface

Thin delegates over runPrompt that match the interface used by
claude-code-sdk. dispatchSubagent validates prompt non-empty and
returns a structured subagent result."
```

### Task 9: Host mutex integration

**Files:**
- Modify: `server/providers/claude-ollama.js` — wrap runPrompt spawn in acquireHostLock
- Modify: `server/tests/claude-ollama.test.js` — add mutex integration test

**Context:** Without a mutex, two concurrent tasks on the same host trigger a costly model unload/load cycle. The probe showed up to minute-scale serialization per swap. Lock is keyed by host ID; mutex is released in `finally`.

- [ ] **Step 9.1: Failing test**

```js
describe('ClaudeOllamaProvider — host mutex', () => {
  it('acquires and releases a host lock around runPrompt', async () => {
    const hostMutex = require('../providers/host-mutex');
    const acquireSpy = vi.spyOn(hostMutex, 'acquireHostLock');
    const p = new ClaudeOllamaProvider({ enabled: true });

    // Stub target host resolution
    vi.spyOn(hostManagement, 'selectOllamaHostForModel').mockReturnValue({ id: 'h1' });

    // Stub spawn to complete immediately
    vi.spyOn(child_process, 'spawn').mockImplementation(() => {
      const { EventEmitter } = require('events');
      const c = new EventEmitter();
      c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
      c.stdin = { end: vi.fn() }; c.kill = vi.fn();
      setImmediate(() => c.emit('close', 0, null));
      return c;
    });

    await p.runPrompt('x', 'qwen3-coder:30b', { working_directory: '/tmp' });
    expect(acquireSpy).toHaveBeenCalledWith('h1');
    vi.restoreAllMocks();
  });
});
```

- [ ] **Step 9.2: Wrap runPrompt spawn in acquireHostLock**

In `runPrompt`, after session setup and before the Promise:

```js
    const selectedHost = hostManagement.selectOllamaHostForModel
      ? hostManagement.selectOllamaHostForModel(cleanText(model))
      : null;
    const hostId = selectedHost?.id || selectedHost?.host_id || 'default-host';
    const release = await acquireHostLock(hostId);
```

Wrap the entire Promise in try/finally so the lock releases even on rejection:

```js
    let result;
    try {
      result = await new Promise((resolve, reject) => { /* existing spawn logic */ });
    } finally {
      release();
    }
```

- [ ] **Step 9.3: Run tests; commit**

```bash
cd server && npx vitest run tests/claude-ollama.test.js
git add server/providers/claude-ollama.js server/tests/claude-ollama.test.js
git commit -m "feat(claude-ollama): per-host mutex serialization

Wraps runPrompt spawn in acquireHostLock to prevent VRAM contention
when multiple tasks target the same Ollama host. Releases on
completion or error."
```

---

## Phase 3 — Registration and config

### Task 10: Register in provider registry

**Files:**
- Modify: `server/providers/registry.js` — add `'claude-ollama'` to `PROVIDER_CATEGORIES.codex`
- Modify: `server/providers/registry.js` — register claude-ollama constructor
- Create: `server/tests/claude-ollama-registry.test.js`

- [ ] **Step 10.1: Failing test for category membership**

Create `server/tests/claude-ollama-registry.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { PROVIDER_CATEGORIES, ALL_PROVIDERS, getCategory } = require('../providers/registry');

describe('providers/registry — claude-ollama', () => {
  it('claude-ollama is categorized under codex (CLI-spawned)', () => {
    expect(PROVIDER_CATEGORIES.codex).toContain('claude-ollama');
  });
  it('claude-ollama appears in ALL_PROVIDERS', () => {
    expect(ALL_PROVIDERS.has('claude-ollama')).toBe(true);
  });
  it('getCategory("claude-ollama") returns "codex"', () => {
    expect(getCategory('claude-ollama')).toBe('codex');
  });
});
```

- [ ] **Step 10.2: Run test — confirm failure**

Expected: FAIL — `PROVIDER_CATEGORIES.codex` does not yet include `'claude-ollama'`.

- [ ] **Step 10.3: Update registry.js**

In `server/providers/registry.js`, change:

```js
  codex:  ['codex', 'codex-spark', 'claude-cli', 'claude-code-sdk'],
```

to:

```js
  codex:  ['codex', 'codex-spark', 'claude-cli', 'claude-code-sdk', 'claude-ollama'],
```

- [ ] **Step 10.4: Register constructor**

Find the provider-class registration section in `registry.js` (look for existing `registerProviderClass(...)` calls near the bottom). Add:

```js
const ClaudeOllamaProvider = require('./claude-ollama');
registerProviderClass('claude-ollama', ClaudeOllamaProvider);
```

- [ ] **Step 10.5: Run tests; commit**

```bash
cd server && npx vitest run tests/claude-ollama-registry.test.js tests/claude-ollama.test.js
git add server/providers/registry.js server/tests/claude-ollama-registry.test.js
git commit -m "feat(claude-ollama): register provider in registry

Adds 'claude-ollama' to PROVIDER_CATEGORIES.codex (CLI-spawned category)
and registers the constructor for lazy instantiation."
```

### Task 11: Config stanza — disabled by default

**Files:**
- Modify: `server/constants.js` — add `claude-ollama` to `PROVIDER_DEFAULTS`
- Modify: `server/tests/claude-ollama-registry.test.js` — add defaults test

**Preflight:** locate `PROVIDER_DEFAULTS` with:

```bash
grep -n "PROVIDER_DEFAULTS" server/constants.js
```

- [ ] **Step 11.1: Write failing test**

Append to `server/tests/claude-ollama-registry.test.js`:

```js
const { PROVIDER_DEFAULTS } = require('../constants');

describe('constants.PROVIDER_DEFAULTS — claude-ollama', () => {
  it('claude-ollama default is disabled', () => {
    const entry = PROVIDER_DEFAULTS['claude-ollama'];
    expect(entry).toBeDefined();
    expect(entry.enabled).toBe(false);
  });
});
```

- [ ] **Step 11.2: Run — confirm failure**

Expected: FAIL — entry missing from `PROVIDER_DEFAULTS`.

- [ ] **Step 11.3: Add stanza**

In `server/constants.js`, locate `PROVIDER_DEFAULTS` and add:

```js
  'claude-ollama': {
    enabled: false,
    maxConcurrent: 1,
    description: 'Local Ollama models via Claude Code harness (ollama launch claude bridge)',
    requires: ['ollama binary on PATH', 'claude binary on PATH', 'at least one healthy Ollama host'],
  },
```

- [ ] **Step 11.4: Run tests; commit**

```bash
cd server && npx vitest run tests/claude-ollama-registry.test.js
git add server/constants.js
git commit -m "feat(claude-ollama): default config stanza (disabled)

Adds claude-ollama to PROVIDER_DEFAULTS with enabled=false and
maxConcurrent=1 (VRAM-constrained). Requires explicit enablement
via configure_provider."
```

---

## Phase 4 — Integration verification

### Task 12: Smoke test against a real Ollama host

**Context:** This task validates end-to-end behavior against a real Ollama host. Skip locally; run manually against the configured workstation. Uses vitest's `.skipIf` to auto-skip when env vars absent.

**Files:**
- Create: `server/tests/claude-ollama-smoke.test.js`

- [ ] **Step 12.1: Write smoke test**

```js
'use strict';
const { describe, it, expect } = require('vitest');
const ClaudeOllamaProvider = require('../providers/claude-ollama');

const skip = !process.env.CLAUDE_OLLAMA_SMOKE;

describe.skipIf(skip)('claude-ollama — smoke (real host)', () => {
  it('runPrompt returns output from a real qwen3-coder:30b', async () => {
    const p = new ClaudeOllamaProvider({ enabled: true });
    const result = await p.runPrompt(
      'Respond with just the word OK and nothing else.',
      'qwen3-coder:30b',
      { working_directory: process.cwd(), timeout_ms: 180000 },
    );
    expect(result.status).toBe('completed');
    expect(result.output.length).toBeGreaterThan(0);
    expect(result.usage.model).toBe('qwen3-coder:30b');
  }, 200000);
});
```

- [ ] **Step 12.2: Run the smoke test via torque-remote against the workstation**

```bash
torque-remote bash -c 'CLAUDE_OLLAMA_SMOKE=1 cd server && npx vitest run tests/claude-ollama-smoke.test.js'
```

Expected: PASS with a short response from qwen3-coder:30b. If FAIL, the error message names the failing precondition (ollama missing, claude missing, host unreachable, etc.) — fix accordingly.

- [ ] **Step 12.3: Commit the smoke test**

```bash
git add server/tests/claude-ollama-smoke.test.js
git commit -m "test(claude-ollama): smoke test against real Ollama host

Gated behind CLAUDE_OLLAMA_SMOKE env var so local test runs skip it.
Run manually via torque-remote to validate the full pipeline against
qwen3-coder:30b."
```

---

## Phase 5 — Documentation

### Task 13: Update providers guide + CLAUDE.md

**Files:**
- Modify: `docs/guides/providers.md` — add claude-ollama entry
- Modify: `CLAUDE.md` — add provider table row

- [ ] **Step 13.1: Add entry to providers guide**

Open `docs/guides/providers.md`. Locate the section listing CLI-based providers (should be alongside claude-cli / codex). Add:

```markdown
### claude-ollama (Local + Claude Code harness)

Wraps `ollama launch claude --model <local> -- -p "<prompt>"` so local Ollama models
drive the Claude Code harness (Read/Edit/Bash/tool loop) instead of the raw
prompt-response shape used by the `ollama` provider. Disabled by default.

**Requires:**
- `ollama` binary on PATH (tested with 0.20.7+)
- `claude` binary on PATH (Claude Code CLI)
- At least one healthy Ollama host with non-cloud models

**Not for cloud Ollama models** — those tags (`*-cloud`) use SSH-keypair signin at
ollama.com and cannot be reached through the launcher bridge. Use `ollama-cloud`
(bearer-token REST) for those.

**Concurrency:** 1 task per host (VRAM constraint; model swaps are slow).

**Enable:**
```
configure_provider { provider: "claude-ollama", enabled: true }
```

**Use:**
```
smart_submit_task { provider: "claude-ollama", model: "qwen3-coder:30b", description: "..." }
```
```

- [ ] **Step 13.2: Add row to CLAUDE.md provider table**

Open `CLAUDE.md`. Add a new section under the existing provider tables:

```markdown
### Local (CLI-harness)

| Provider | Requirement | Best For |
|----------|------------|----------|
| **claude-ollama** | `ollama` + `claude` CLIs, local Ollama host | Local models with Claude Code tool loop |
```

- [ ] **Step 13.3: Commit**

```bash
git add docs/guides/providers.md CLAUDE.md
git commit -m "docs: claude-ollama provider entries

Adds claude-ollama to the providers guide and CLAUDE.md provider table
with enablement preconditions, scope (local models only), and concurrency
notes."
```

---

## Final verification

- [ ] **Run full provider test suite locally**

```bash
cd server && npx vitest run tests/claude-code-stream-parser.test.js tests/claude-ollama.test.js tests/claude-ollama-registry.test.js tests/claude-code-permission-chain.test.js tests/claude-code-session-store.test.js
```

Expected: all PASS.

- [ ] **Run the DI lint check**

```bash
cd server && npm run lint:di
```

Expected: no new violations introduced by claude-ollama.js (it uses `hostManagement` via direct require — same pattern as claude-code-sdk.js currently).

- [ ] **Push to feature branch**

```bash
git push origin feat/claude-ollama-provider
```

(Do NOT cutover to main yet — benchmarking against `ollama-agentic` is a separate follow-on that should land before graduating this provider into smart routing defaults.)

---

## Post-implementation corrections (2026-04-19)

This plan was executed end-to-end. Seven defects were discovered — four during task execution, three during cutover. Re-runs should incorporate the corrections below.

### 1. Task 1 — `stream-parser` must unwrap `stream_event` envelope

**Symptom:** Live smoke test returned empty output despite streaming succeeding.

**Root cause:** claude-cli with `--verbose` wraps every real payload in `{type:'stream_event',event:{...real payload...}}`. The parser's `extractTextDelta` / `normalizeUsage` / `normalizeToolCall` saw the outer `type === 'stream_event'` and returned null/empty. `message_start` payloads also put usage at `event.message.usage` (not `record.usage`).

**Fix:** Add `unwrapStreamEvent(record)` at the top of each extractor and in `normalizeUsage` check `record.message.usage` in addition to `record.usage`. Three new unit-test cases cover the envelope shape.

Landed as commit `c91eb7a4` (`fix(stream-parser): unwrap claude-cli --verbose stream_event envelope`).

### 2. Task 6 — `buildCommandArgs` must emit `--verbose`

**Symptom:** Smoke test failed with `Error: When using --print, --output-format=stream-json requires --verbose`.

**Root cause:** claude-cli rejects `--print` combined with `--output-format=stream-json` unless `--verbose` is also passed. Unit tests mocked spawn so never caught this.

**Fix:** Add `'--verbose'` to the args.push after `'--output-format', 'stream-json'`. Add test assertion `expect(postDash).toContain('--verbose')`.

Landed as commit `82531bdf` (`fix(claude-ollama): emit --verbose in buildCommandArgs`).

### 3. Task 7a — read `messageCount` BEFORE appending user message

**Symptom:** First call to a fresh session used `--resume` instead of `--session-id`, causing claude-cli to fail because the session didn't exist yet.

**Root cause:** Plan ordered the user-message append inside `ensureSession()` and then computed `messageCount = this.sessionStore.readAll(localSessionId).length` after. That makes messageCount=1 on first call.

**Fix:** Compute `messageCount` BEFORE any session append. The agent caught this in-flight.

### 4. Task 9 — host-selection needs DB-unavailable guard

**Symptom:** Three unit tests regressed on the mutex integration because `selectOllamaHostForModel` threw when the DB wasn't initialized.

**Fix:** Wrap the call in try/catch and fall back to a `'default-host'` lock key. Landed as commit `4a6f83cf` (`fix(claude-ollama): guard host selection against DB unavailability`).

### 5. Task 10 — `registerProviderClass` lives in `task-manager.js` + `container.js`, NOT `registry.js`

**Symptom:** Task 10 Step 10.4 said "register constructor in `registry.js` at the bottom". Not only does `registry.js` not have a canonical registration block, but the live TORQUE bootstrap reads from `task-manager.js:44` and `server/container.js:242`.

**Fix:** Add `providerRegistry.registerProviderClass('claude-ollama', require('./providers/claude-ollama'))` to **both** bootstrap paths. Keep the `PROVIDER_CATEGORIES.codex` update in `registry.js` as the plan said — that part was correct.

### 6. Task 11 — `PROVIDER_DEFAULTS` shape + `optInProviders` gap

**Symptom:** The plan assumed `PROVIDER_DEFAULTS` is a per-provider config map (`{'claude-ollama': {enabled: false}}`). In reality it's a flat constants map with UPPERCASE keys (`STARTUP_TIMEOUT_MS` etc.). The plan's test passed because the entry was added as a string key alongside the constants — but that alone does NOT disable the provider at runtime.

**Root cause:** Runtime enablement check is `isProviderEnabled('claude-ollama')` in `server/providers/config.js`, which defaults to enabled (opt-out) unless the provider name appears in the `optInProviders` list inside that function.

**Fix:** Add `'claude_ollama'` (underscore form) to `optInProviders` in `providers/config.js:isProviderEnabled` in addition to the constants entry. Without this, the "disabled by default" requirement from the spec isn't actually enforced.

### 7. Schema seeds must include a `claude-ollama` row (missing from plan entirely)

**Symptom:** After merge + restart, `list_providers` did not show `claude-ollama`, and `configure_provider` couldn't toggle it because no row existed in `provider_config`.

**Root cause:** The plan covered `constants.js` (for defaults) and registry (for category/class). But `server/db/schema-seeds.js` is the source of truth for what rows get INSERTed into `provider_config` on first DB init. The plan never touched schema-seeds.

**Fix:** Add a new task between Tasks 10 and 11 (or fold into 11) that edits `server/db/schema-seeds.js`:
- Add `insertProvider.run('claude-ollama', 0, 5, 'ollama', 'cli', null, JSON.stringify([...quota-patterns]), 1, now);` (disabled by default, priority 5, max_concurrent 1 for VRAM)
- Add `'claude-ollama': 'local-cli'` to the `providerTypes` map
- Add `'claude-ollama': { capabilities: ['file_edit', 'reasoning', 'code_review'], band: 'C' }` to `PROVIDER_CAPABILITIES`

Landed as commit `8d8de03b` (`fix(schema-seeds): seed claude-ollama provider row`).

### 8. Vitest filter flakiness (process note, not code)

Per-file filter `npx vitest run tests/claude-ollama-smoke.test.js` intermittently returns "No test files found". Clearing the vitest cache (`rm -rf node_modules/.vite node_modules/.vitest`) or using a broader substring filter (`claude-ollama-smoke`) works reliably. Suggest updating the plan's test commands to use substring filters everywhere.

### 9. `schema-seeds.test.js` has a `VALID_PROVIDER_NAMES` allowlist

**Symptom:** After the cutover, `server/tests/schema-seeds.test.js` failed on main because the seeded row for `claude-ollama` wasn't in the test's hardcoded `VALID_PROVIDER_NAMES` set. Fixed in a follow-up commit by another session.

**Fix:** When the plan adds a new provider to `schema-seeds.js`, it must ALSO extend the `VALID_PROVIDER_NAMES` set in the test (or refactor it to read from `registry.PROVIDER_CATEGORIES`). Treat these as paired edits.

Landed as commit `29bc4811` (`fix(tests): extend schema-seeds VALID_PROVIDER_NAMES with new providers`), by a different session's factory loop picking up the regression.

### 10. `tool-annotations.test.js` `getExposedToolNames()` helper is plugin-aware but not extensible

**Symptom:** After merging the freshness plugin with its 5 `OVERRIDES` entries in `tool-annotations.js`, the annotations test failed: `validateCoverage` flagged the 5 `model_watchlist_*` / `model_freshness_*` entries as "stale" because the helper's tool-name collector only pulled remote-agents plugin tool-defs, not freshness.

**Chain of events:** Another session saw the failure, deleted the OVERRIDES entries thinking they were for a non-merged plugin (commit `44a34d67`), realized they WERE for a merged plugin, reverted (`e5e3f434`), and then fixed the underlying helper (`ce27b1fc`).

**Fix:** The helper at the top of `server/tests/tool-annotations.test.js` now uses a `pluginToolNames()` factory that extends cleanly. When this plan adds a new plugin's annotations, it must also register that plugin's tool-defs in the helper's list. Or refactor the helper to auto-discover from `server/plugins/*/tool-defs.js`.
