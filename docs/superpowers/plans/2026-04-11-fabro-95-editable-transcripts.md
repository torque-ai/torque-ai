# Fabro #95: Editable Conversation Transcripts (gptme)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give every Claude Code session + agent run a **plain-text transcript log** at `.torque/runs/<run_id>/transcript.jsonl` that operators can edit via `$EDITOR`. On next resume, TORQUE re-parses the edited transcript, validates it, and continues from the corrected state. Simple, durable, grep-friendly. Inspired by gptme.

**Architecture:** A `transcript-log.js` module appends a JSON object per message (role/content/tool_calls/tool_results/timestamp/metadata). A `torque transcript edit <run-id>` CLI opens the file in `$EDITOR` with TOML pretty-printing for readability, then validates + converts back on save. Plan 85 (run artifacts) already creates `.torque/runs/<id>/`, so we just drop `transcript.jsonl` inside.

**Tech Stack:** Node.js, `@iarna/toml` for round-tripping, existing CLI infra. Builds on plans 27 (state), 47 (memory), 63 (threads), 85 (run artifacts), 84 (Claude Code SDK provider).

---

## File Structure

**New files:**
- `server/transcripts/transcript-log.js`
- `server/transcripts/transcript-editor.js`
- `server/transcripts/transcript-validator.js`
- `server/tests/transcript-log.test.js`
- `server/tests/transcript-editor.test.js`
- `server/tests/transcript-validator.test.js`
- `server/cli/transcript-cli.js`

**Modified files:**
- `server/execution/task-startup.js` — attach transcript-log to session
- `server/providers/claude-code-sdk.js` (Plan 84) — append each streamed message
- `server/handlers/mcp-tools.js` — `read_transcript`, `edit_transcript`, `replay_from_transcript`

---

## Task 1: Transcript log

- [ ] **Step 1: Tests**

Create `server/tests/transcript-log.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createTranscriptLog } = require('../transcripts/transcript-log');

describe('transcriptLog', () => {
  let dir, log;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-'));
    log = createTranscriptLog({ filePath: path.join(dir, 'transcript.jsonl') });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('append + read roundtrips messages in order', () => {
    log.append({ role: 'user', content: 'hi' });
    log.append({ role: 'assistant', content: 'hello' });
    const messages = log.read();
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[1].content).toBe('hello');
  });

  it('each appended line has timestamp + message_id', () => {
    log.append({ role: 'user', content: 'hi' });
    const [msg] = log.read();
    expect(msg.message_id).toMatch(/^msg_/);
    expect(new Date(msg.timestamp).toString()).not.toBe('Invalid Date');
  });

  it('tool_calls are preserved', () => {
    log.append({ role: 'assistant', content: '', tool_calls: [{ id: 'tc1', name: 'read', args: { path: 'a.js' } }] });
    const [msg] = log.read();
    expect(msg.tool_calls[0].name).toBe('read');
  });

  it('read returns [] when file does not exist', () => {
    const empty = createTranscriptLog({ filePath: path.join(dir, 'missing.jsonl') });
    expect(empty.read()).toEqual([]);
  });

  it('skips malformed lines without throwing', () => {
    const filePath = path.join(dir, 'broken.jsonl');
    fs.writeFileSync(filePath, 'not json\n{"role":"user","content":"ok"}\n');
    const l = createTranscriptLog({ filePath });
    const msgs = l.read();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('ok');
  });

  it('replace overwrites the full file atomically', () => {
    log.append({ role: 'user', content: 'old' });
    log.replace([
      { role: 'user', content: 'new1' },
      { role: 'assistant', content: 'new2' },
    ]);
    const msgs = log.read();
    expect(msgs.map(m => m.content)).toEqual(['new1', 'new2']);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/transcripts/transcript-log.js`:

```js
'use strict';
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

function createTranscriptLog({ filePath }) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  function append(message) {
    const row = {
      message_id: message.message_id || `msg_${randomUUID().slice(0, 12)}`,
      timestamp: message.timestamp || new Date().toISOString(),
      ...message,
    };
    fs.appendFileSync(filePath, JSON.stringify(row) + '\n');
    return row.message_id;
  }

  function read() {
    if (!fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    const out = [];
    for (const line of lines) {
      try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
    return out;
  }

  function replace(messages) {
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, messages.map(m => JSON.stringify(m)).join('\n') + '\n');
    fs.renameSync(tmp, filePath);
  }

  return { append, read, replace, filePath };
}

module.exports = { createTranscriptLog };
```

Run tests → PASS. Commit: `feat(transcripts): append/read/replace JSONL log with atomic replace`.

---

## Task 2: Validator + TOML editor roundtrip

- [ ] **Step 1: Validator tests**

Create `server/tests/transcript-validator.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { validateTranscript } = require('../transcripts/transcript-validator');

describe('validateTranscript', () => {
  it('valid sequence passes', () => {
    const r = validateTranscript([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
    expect(r.ok).toBe(true);
  });

  it('requires role field', () => {
    const r = validateTranscript([{ content: 'hi' }]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/role/);
  });

  it('rejects unknown role', () => {
    const r = validateTranscript([{ role: 'wizard', content: 'hi' }]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/role/);
  });

  it('tool_result must reference a prior tool_call with matching id', () => {
    const r = validateTranscript([
      { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', name: 'read', args: {} }] },
      { role: 'tool', tool_call_id: 'tc1', content: 'result' },
    ]);
    expect(r.ok).toBe(true);

    const bad = validateTranscript([
      { role: 'tool', tool_call_id: 'orphan', content: 'result' },
    ]);
    expect(bad.ok).toBe(false);
    expect(bad.errors[0]).toMatch(/orphan/);
  });

  it('aggregates multiple errors', () => {
    const r = validateTranscript([
      { role: 'user' },              // missing content
      { role: 'bogus', content: 'x' }, // bad role
    ]);
    expect(r.errors.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Implement validator**

Create `server/transcripts/transcript-validator.js`:

```js
'use strict';

const VALID_ROLES = new Set(['system', 'user', 'assistant', 'tool']);

function validateTranscript(messages) {
  const errors = [];
  if (!Array.isArray(messages)) return { ok: false, errors: ['transcript must be an array'] };

  const openToolCalls = new Set();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m.role) errors.push(`msg[${i}]: missing role`);
    if (m.role && !VALID_ROLES.has(m.role)) errors.push(`msg[${i}]: unknown role ${m.role}`);
    if (m.role !== 'tool' && m.content === undefined) errors.push(`msg[${i}]: missing content`);
    if (Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) openToolCalls.add(tc.id);
    if (m.role === 'tool') {
      if (!m.tool_call_id) errors.push(`msg[${i}]: tool message missing tool_call_id`);
      else if (!openToolCalls.has(m.tool_call_id)) errors.push(`msg[${i}]: tool_call_id '${m.tool_call_id}' references no prior tool call`);
    }
  }
  return { ok: errors.length === 0, errors };
}

module.exports = { validateTranscript };
```

Run tests → PASS. Commit: `feat(transcripts): validator with role check + tool_call linkage`.

- [ ] **Step 3: TOML editor roundtrip**

Create `server/transcripts/transcript-editor.js`:

```js
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const TOML = require('@iarna/toml');
const { spawn } = require('child_process');
const { validateTranscript } = require('./transcript-validator');

// Open messages as TOML in $EDITOR, validate on save, return updated messages.
function toTomlDocument(messages) {
  return TOML.stringify({ messages });
}

function fromTomlDocument(text) {
  const parsed = TOML.parse(text);
  return parsed.messages || [];
}

async function editTranscript({ messages, editor = process.env.EDITOR || 'vi' }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-edit-'));
  const tmpFile = path.join(tmpDir, 'transcript.toml');
  fs.writeFileSync(tmpFile, toTomlDocument(messages));

  await new Promise((resolve, reject) => {
    const proc = spawn(editor, [tmpFile], { stdio: 'inherit' });
    proc.on('exit', code => code === 0 ? resolve() : reject(new Error(`editor exited with ${code}`)));
    proc.on('error', reject);
  });

  const edited = fs.readFileSync(tmpFile, 'utf8');
  fs.rmSync(tmpDir, { recursive: true, force: true });

  const newMessages = fromTomlDocument(edited);
  const validation = validateTranscript(newMessages);
  if (!validation.ok) return { ok: false, messages: null, errors: validation.errors };
  return { ok: true, messages: newMessages, errors: [] };
}

module.exports = { editTranscript, toTomlDocument, fromTomlDocument };
```

(No new tests in this step — integration test runs in Task 3 smoke path.)

Commit: `feat(transcripts): editor roundtrip via $EDITOR + TOML pretty form`.

---

## Task 3: CLI + MCP + wire into run dir

- [ ] **Step 1: CLI**

Create `server/cli/transcript-cli.js`:

```js
#!/usr/bin/env node
'use strict';
const path = require('path');
const { createTranscriptLog } = require('../transcripts/transcript-log');
const { editTranscript } = require('../transcripts/transcript-editor');

async function main() {
  const cmd = process.argv[2];
  const taskId = process.argv[3];
  if (!cmd || !taskId) {
    console.error('usage: torque transcript {view|edit|validate} <task-id>');
    process.exit(1);
  }
  const filePath = path.join('.torque', 'runs', taskId, 'transcript.jsonl');
  const log = createTranscriptLog({ filePath });

  if (cmd === 'view') {
    for (const msg of log.read()) {
      console.log(`\n--- [${msg.role}] ${msg.timestamp} ---`);
      console.log(msg.content || JSON.stringify(msg, null, 2));
    }
  } else if (cmd === 'edit') {
    const messages = log.read();
    const result = await editTranscript({ messages });
    if (!result.ok) {
      console.error('Validation failed:');
      for (const e of result.errors) console.error('  - ' + e);
      process.exit(1);
    }
    log.replace(result.messages);
    console.log(`Updated ${result.messages.length} messages.`);
  } else if (cmd === 'validate') {
    const { validateTranscript } = require('../transcripts/transcript-validator');
    const r = validateTranscript(log.read());
    console.log(JSON.stringify(r, null, 2));
    if (!r.ok) process.exit(1);
  } else {
    console.error(`Unknown command: ${cmd}`);
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: MCP tools**

```js
read_transcript: { description: 'Read a task\'s transcript (list of messages).', inputSchema: { type: 'object', required: ['task_id'], properties: { task_id: { type: 'string' } } } },
edit_transcript: { description: 'Replace a task\'s transcript with validated messages.', inputSchema: { type: 'object', required: ['task_id', 'messages'], properties: { task_id: { type: 'string' }, messages: { type: 'array' } } } },
replay_from_transcript: { description: 'Resume a task from its (possibly-edited) transcript. The next turn sees the edited history.', inputSchema: { type: 'object', required: ['task_id'], properties: { task_id: { type: 'string' } } } },
```

- [ ] **Step 3: Wire into task startup + Claude Code provider**

In `server/execution/task-startup.js`: when opening a run dir (Plan 85), create a transcript log and expose it through `task.__transcript`. Each message from provider streams (text_delta → append chunk to running message; tool_call / tool_result → append immediately on completion) is persisted.

In `server/providers/claude-code-sdk.js` (Plan 84): every streamed message → `task.__transcript.append({...})`.

On `replay_from_transcript`, re-read the file, hand the messages as the conversation seed to the provider, and continue. Useful for correcting an agent that went off the rails: edit the transcript, remove or rewrite the bad turn, replay.

`await_restart`. Smoke: run a task that makes 3 tool calls, confirm `.torque/runs/<id>/transcript.jsonl` has expected structure. Run `torque transcript edit <id>` — TOML opens in $EDITOR, rename a tool result, save, confirm file updated. Run `replay_from_transcript` — confirm the agent sees the edited history.

Commit: `feat(transcripts): CLI + MCP + run-dir integration + replay hook`.
