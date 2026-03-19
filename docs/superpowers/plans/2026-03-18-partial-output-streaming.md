# Partial Output Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire streaming output from all providers into `tasks.partial_output` so heartbeat check-ins show real progress instead of "No output captured yet."

**Architecture:** Hook into the existing `addStreamChunk()` function in `webhooks-streaming.js` — the single bottleneck all providers already funnel through. Maintain a 32 KB ring buffer per task, flush to DB every 10 seconds. Clean up in the completion pipeline. Two files modified, zero provider changes.

**Tech Stack:** Node.js, SQLite (better-sqlite3), Vitest

**Spec:** `docs/superpowers/specs/2026-03-18-partial-output-streaming-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `server/db/webhooks-streaming.js` | Modify | Add `_streamToTask` cache in stream creation, add accumulator in `addStreamChunk()`, export `clearPartialOutputBuffer()` |
| `server/execution/completion-pipeline.js` | Modify | Call `clearPartialOutputBuffer()` and NULL out `partial_output` on task completion |
| `server/tests/partial-output-streaming.test.js` | Create | All tests for accumulator, flush, cleanup |

---

## Task 1: StreamId-to-TaskId Cache

**Files:**
- Modify: `server/db/webhooks-streaming.js:433-473` (createTaskStream and getOrCreateTaskStream)
- Create: `server/tests/partial-output-streaming.test.js`

- [ ] **Step 1: Write the failing tests**

Create `server/tests/partial-output-streaming.test.js`:

```javascript
import { describe, test, expect, beforeEach, vi } from 'vitest';

describe('streamToTask cache', () => {
  test('createTaskStream populates _streamToTask cache', async () => {
    const mod = await import('../db/webhooks-streaming.js');
    // createTaskStream returns a streamId
    // After calling it, the internal _streamToTask map should have the mapping
    // We need to expose a test helper or the map itself
    // Check if getStreamTaskId is exported for testing
    const streamId = mod.createTaskStream('test-task-1', 'output');
    expect(streamId).toBeDefined();
    // The mapping should be retrievable
    expect(mod.getStreamTaskId(streamId)).toBe('test-task-1');
  });

  test('getOrCreateTaskStream populates _streamToTask cache', async () => {
    const mod = await import('../db/webhooks-streaming.js');
    const streamId = mod.getOrCreateTaskStream('test-task-2', 'output');
    expect(mod.getStreamTaskId(streamId)).toBe('test-task-2');
  });

  test('getOrCreateTaskStream returns cached streamId on second call', async () => {
    const mod = await import('../db/webhooks-streaming.js');
    const id1 = mod.getOrCreateTaskStream('test-task-3', 'output');
    const id2 = mod.getOrCreateTaskStream('test-task-3', 'output');
    expect(id1).toBe(id2);
    expect(mod.getStreamTaskId(id1)).toBe('test-task-3');
  });
});
```

Note: The test requires a working DB. Check how other tests in `server/tests/` set up the DB (look at `server/tests/test-helpers.js` for `setupTestDb` pattern). The `getStreamTaskId` function needs to be exported as a test helper.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /c/Users/Werem/Projects/torque-public && npx vitest run server/tests/partial-output-streaming.test.js`
Expected: FAIL — `getStreamTaskId` not exported

- [ ] **Step 3: Implement the cache**

In `server/db/webhooks-streaming.js`, add at module scope (near line 476, after the existing stream functions):

```javascript
// Partial output streaming: streamId → taskId cache
const _streamToTask = new Map();

// Test/debug helper: resolve a streamId to its taskId
function getStreamTaskId(streamId) {
  return _streamToTask.get(streamId) || null;
}
```

In `createTaskStream` (line 433), after `stmt.run(id, taskId, streamType)` (line 439), add:

```javascript
  _streamToTask.set(id, taskId);
```

In `getOrCreateTaskStream` (line 450), the function has two paths:
- **Existing stream found** (line 458-460): Replace `return existing.id;` with:
  ```javascript
  _streamToTask.set(existing.id, taskId);
  return existing.id;
  ```
- **New stream created** (line 463-469): After the INSERT, add:
  ```javascript
  _streamToTask.set(id, taskId);
  ```

Add `getStreamTaskId` and `_streamToTask` to `module.exports` (line 1057).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /c/Users/Werem/Projects/torque-public && npx vitest run server/tests/partial-output-streaming.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/db/webhooks-streaming.js server/tests/partial-output-streaming.test.js
git commit -m "feat(streaming): add streamId-to-taskId cache in webhooks-streaming"
```

---

## Task 2: Ring Buffer Accumulator and Flush

**Files:**
- Modify: `server/db/webhooks-streaming.js:489-534` (addStreamChunk)
- Append to: `server/tests/partial-output-streaming.test.js`

This is the core task — add the accumulator inside `addStreamChunk()`.

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/partial-output-streaming.test.js`:

```javascript
describe('partial output accumulator', () => {
  test('chunks are accumulated in buffer', async () => {
    const mod = await import('../db/webhooks-streaming.js');
    const taskId = 'accum-test-1';
    const streamId = mod.getOrCreateTaskStream(taskId, 'output');

    mod.addStreamChunk(streamId, 'hello ', 'stdout');
    mod.addStreamChunk(streamId, 'world', 'stdout');

    // Buffer should contain both chunks
    const buffer = mod.getPartialOutputBuffer(taskId);
    expect(buffer).toContain('hello ');
    expect(buffer).toContain('world');
  });

  test('stderr chunks are also accumulated', async () => {
    const mod = await import('../db/webhooks-streaming.js');
    const taskId = 'accum-test-2';
    const streamId = mod.getOrCreateTaskStream(taskId, 'output');

    mod.addStreamChunk(streamId, 'normal output\n', 'stdout');
    mod.addStreamChunk(streamId, 'error: something failed\n', 'stderr');

    const buffer = mod.getPartialOutputBuffer(taskId);
    expect(buffer).toContain('normal output');
    expect(buffer).toContain('error: something failed');
  });

  test('buffer respects 32 KB cap', async () => {
    const mod = await import('../db/webhooks-streaming.js');
    const taskId = 'accum-test-3';
    const streamId = mod.getOrCreateTaskStream(taskId, 'output');

    // Write 40 KB of data (over 32 KB cap)
    const chunk = 'x'.repeat(1000) + '\n';
    for (let i = 0; i < 41; i++) {
      mod.addStreamChunk(streamId, chunk, 'stdout');
    }

    const buffer = mod.getPartialOutputBuffer(taskId);
    expect(buffer.length).toBeLessThanOrEqual(32 * 1024 + 100); // small margin for last chunk
  });

  test('ring buffer truncates at newline boundary', async () => {
    const mod = await import('../db/webhooks-streaming.js');
    const taskId = 'accum-test-4';
    const streamId = mod.getOrCreateTaskStream(taskId, 'output');

    // Fill buffer with numbered lines
    for (let i = 0; i < 500; i++) {
      mod.addStreamChunk(streamId, `line ${i}: ${'x'.repeat(100)}\n`, 'stdout');
    }

    const buffer = mod.getPartialOutputBuffer(taskId);
    // Buffer should start at a line boundary (first char should be 'l' from 'line')
    expect(buffer[0]).toBe('l');
    // Should contain recent lines, not old ones
    expect(buffer).toContain('line 499');
    expect(buffer).not.toContain('line 0:');
  });

  test('ring buffer fallback when no newlines', async () => {
    const mod = await import('../db/webhooks-streaming.js');
    const taskId = 'accum-test-5';
    const streamId = mod.getOrCreateTaskStream(taskId, 'output');

    // Write 40 KB without any newlines
    mod.addStreamChunk(streamId, 'x'.repeat(40 * 1024), 'stdout');

    const buffer = mod.getPartialOutputBuffer(taskId);
    expect(buffer.length).toBeLessThanOrEqual(32 * 1024);
  });

  test('flush writes to DB after 10 seconds', async () => {
    vi.useFakeTimers();
    // Use setupTestDb or setupTestDbModule to get a DB-backed module instance.
    // The exact pattern depends on project test infrastructure. Adapt from
    // server/tests/test-helpers.js. The key: we need rawDb() to query directly.
    const mod = await import('../db/webhooks-streaming.js');
    const taskId = 'flush-test-1';

    // Create a task row so the UPDATE has a target
    // db.createTask({ id: taskId, task_description: 'flush test', status: 'running', working_directory: '/tmp' });

    const streamId = mod.getOrCreateTaskStream(taskId, 'output');
    mod.addStreamChunk(streamId, 'first chunk\n', 'stdout');

    // Advance time past flush interval (Date.now() is replaced by vi.useFakeTimers)
    vi.advanceTimersByTime(11000);

    // Next chunk triggers the flush check
    mod.addStreamChunk(streamId, 'second chunk\n', 'stdout');

    // Verify partial_output was written to DB
    // Use rawDb() or db.getTask() depending on test setup:
    const task = db.getTask(taskId);
    expect(task.partial_output).toContain('first chunk');

    vi.useRealTimers();
  });

  test('flush does NOT fire before 10 seconds', async () => {
    vi.useFakeTimers();
    const mod = await import('../db/webhooks-streaming.js');
    const taskId = 'flush-test-2';

    // Create task row
    // db.createTask({ id: taskId, task_description: 'no-flush test', status: 'running', working_directory: '/tmp' });

    const streamId = mod.getOrCreateTaskStream(taskId, 'output');
    mod.addStreamChunk(streamId, 'early chunk\n', 'stdout');

    vi.advanceTimersByTime(5000); // Only 5 seconds

    mod.addStreamChunk(streamId, 'still early\n', 'stdout');

    // partial_output should still be NULL in DB (no flush yet)
    const task = db.getTask(taskId);
    expect(task.partial_output).toBeNull();

    vi.useRealTimers();
  });

  test('unknown streamId skips accumulation silently', async () => {
    const mod = await import('../db/webhooks-streaming.js');
    // This should not throw — just skip accumulation
    expect(() => {
      mod.addStreamChunk('nonexistent-stream-id', 'some data', 'stdout');
    }).not.toThrow();
  });
});
```

Note: The flush tests need a real DB to verify the `partial_output` column is written. Use the `setupTestDb` or `setupTestDbModule` pattern from `server/tests/test-helpers.js` to get a DB-backed module instance. The `getPartialOutputBuffer(taskId)` is a test helper that reads the in-memory buffer (no DB needed).

The implementation uses `Date.now()` for flush timing. Vitest's `vi.useFakeTimers()` replaces `Date.now()` by default, so fake timers will work correctly for flush interval tests.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /c/Users/Werem/Projects/torque-public && npx vitest run server/tests/partial-output-streaming.test.js`
Expected: FAIL — `getPartialOutputBuffer` not exported, accumulator not implemented

- [ ] **Step 3: Implement the accumulator**

In `server/db/webhooks-streaming.js`, add at module scope (near the `_streamToTask` map):

```javascript
// Partial output accumulator
const _partialOutputBuffers = new Map(); // taskId → { buffer, lastFlushAt, streamId }
const FLUSH_INTERVAL_MS = 10000;         // 10 seconds
const MAX_BUFFER_SIZE = 32 * 1024;       // 32 KB

// Test helper: read the in-memory buffer for a task
function getPartialOutputBuffer(taskId) {
  const entry = _partialOutputBuffers.get(taskId);
  return entry ? entry.buffer : null;
}

function flushPartialOutput(taskId, buffer) {
  try {
    db.prepare('UPDATE tasks SET partial_output = ? WHERE id = ?').run(buffer, taskId);
  } catch (e) {
    // Non-fatal — never block chunk processing
  }
}

function truncateBuffer(buffer) {
  if (buffer.length <= MAX_BUFFER_SIZE) return buffer;
  const excess = buffer.length - MAX_BUFFER_SIZE;
  const newlineIdx = buffer.indexOf('\n', excess);
  if (newlineIdx !== -1) {
    return buffer.slice(newlineIdx + 1);
  }
  return buffer.slice(-MAX_BUFFER_SIZE);
}
```

At the END of `addStreamChunk()` (line 533, just before `return transaction()`), add the accumulator logic. IMPORTANT: This must be OUTSIDE the transaction block — the accumulator is in-memory and should not participate in the SQLite transaction:

```javascript
  const seqResult = transaction();

  // --- Partial output accumulation (outside transaction) ---
  try {
    let taskId = _streamToTask.get(streamId);
    if (!taskId) {
      // DB fallback for post-restart orphaned streams
      const row = db.prepare('SELECT task_id FROM task_streams WHERE id = ?').get(streamId);
      if (row) {
        taskId = row.task_id;
        _streamToTask.set(streamId, taskId);
      }
    }
    if (taskId) {
      let entry = _partialOutputBuffers.get(taskId);
      if (!entry) {
        entry = { buffer: '', lastFlushAt: Date.now(), streamId };
        _partialOutputBuffers.set(taskId, entry);
      }
      // Use truncatedData (post-truncation) to match what's stored in stream_chunks
      entry.buffer += (typeof truncatedData === 'string' ? truncatedData : String(truncatedData));
      entry.buffer = truncateBuffer(entry.buffer);

      const now = Date.now();
      if (now - entry.lastFlushAt >= FLUSH_INTERVAL_MS) {
        flushPartialOutput(taskId, entry.buffer);
        entry.lastFlushAt = now;
      }
    }
  } catch (e) {
    // Non-fatal — never block chunk processing
  }

  return seqResult;
```

Note: The function currently ends with `return transaction()`. Change it to store the result and return after the accumulator logic runs.

Add `getPartialOutputBuffer` to `module.exports`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /c/Users/Werem/Projects/torque-public && npx vitest run server/tests/partial-output-streaming.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/db/webhooks-streaming.js server/tests/partial-output-streaming.test.js
git commit -m "feat(streaming): ring buffer accumulator with throttled flush in addStreamChunk"
```

---

## Task 3: Cleanup in Completion Pipeline

**Files:**
- Modify: `server/db/webhooks-streaming.js` (export clearPartialOutputBuffer)
- Modify: `server/execution/completion-pipeline.js:176-186`
- Append to: `server/tests/partial-output-streaming.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/partial-output-streaming.test.js`:

```javascript
describe('clearPartialOutputBuffer', () => {
  test('does final flush before clearing', async () => {
    const mod = await import('../db/webhooks-streaming.js');
    const taskId = 'clear-test-1';

    // Create a task in DB, add some chunks
    const streamId = mod.getOrCreateTaskStream(taskId, 'output');
    mod.addStreamChunk(streamId, 'unflushed data\n', 'stdout');

    // Buffer should have content
    expect(mod.getPartialOutputBuffer(taskId)).toContain('unflushed data');

    // Clear — should do final flush then remove
    mod.clearPartialOutputBuffer(taskId);

    // Buffer should be gone
    expect(mod.getPartialOutputBuffer(taskId)).toBeNull();

    // DB should have the flushed data then been NULLed out
    // (clearPartialOutputBuffer flushes first, then NULLs)
    // Verify flush happened by checking the task was updated
    // Note: after clear, partial_output is NULL because clearPartialOutputBuffer
    // does flush → NULL in sequence. To test the flush, check before the NULL:
    // this is inherently a timing test. Instead, verify the buffer was non-empty
    // before clear (already done above) and the Map is empty after (done below).
  });

  test('NULLs out partial_output in DB', async () => {
    const mod = await import('../db/webhooks-streaming.js');
    const taskId = 'clear-test-null';

    // Create task, add chunks, force a flush
    const streamId = mod.getOrCreateTaskStream(taskId, 'output');
    mod.addStreamChunk(streamId, 'data to flush\n', 'stdout');

    // Force a flush by calling clearPartialOutputBuffer (which flushes then NULLs)
    mod.clearPartialOutputBuffer(taskId);

    // partial_output should be NULL in DB
    const task = db.getTask(taskId);
    expect(task.partial_output).toBeNull();
  });

  test('cleans up _streamToTask entry', async () => {
    const mod = await import('../db/webhooks-streaming.js');
    const taskId = 'clear-test-2';
    const streamId = mod.getOrCreateTaskStream(taskId, 'output');
    mod.addStreamChunk(streamId, 'data\n', 'stdout');

    // StreamId should resolve before cleanup
    expect(mod.getStreamTaskId(streamId)).toBe(taskId);

    mod.clearPartialOutputBuffer(taskId);

    // StreamId mapping should be cleaned up
    expect(mod.getStreamTaskId(streamId)).toBeNull();
  });

  test('no-op for unknown taskId', async () => {
    const mod = await import('../db/webhooks-streaming.js');
    expect(() => {
      mod.clearPartialOutputBuffer('nonexistent-task');
    }).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /c/Users/Werem/Projects/torque-public && npx vitest run server/tests/partial-output-streaming.test.js -t "clearPartialOutputBuffer"`
Expected: FAIL — function not exported

- [ ] **Step 3: Implement clearPartialOutputBuffer**

In `server/db/webhooks-streaming.js`, add:

```javascript
/**
 * Final-flush and cleanup for task partial output.
 * Called from completion-pipeline.js when a task reaches terminal state.
 * Handles both the in-memory cleanup AND the DB NULL-out, because this module
 * has direct access to the db object (via setDb). The completion pipeline
 * does NOT have a raw db.run() method, so all DB work happens here.
 */
function clearPartialOutputBuffer(taskId) {
  const entry = _partialOutputBuffers.get(taskId);
  if (entry) {
    // Final flush — don't lose buffered data
    if (entry.buffer.length > 0) {
      flushPartialOutput(taskId, entry.buffer);
    }
    // Clean up _streamToTask
    if (entry.streamId) {
      _streamToTask.delete(entry.streamId);
    }
    _partialOutputBuffers.delete(taskId);
  }
  // NULL out partial_output in DB — full output is already in the output column
  try {
    db.prepare('UPDATE tasks SET partial_output = NULL WHERE id = ?').run(taskId);
  } catch (e) {
    // Non-fatal
  }
}
```

Add `clearPartialOutputBuffer` to `module.exports`.

- [ ] **Step 4: Add cleanup call in completion pipeline**

In `server/execution/completion-pipeline.js`, after the `dispatchTaskEvent` try/catch block (around line 182, inside the outer try block but after the MCP notify try/catch), add:

```javascript
    // Clean up partial output streaming buffer + NULL out partial_output
    try {
      const { clearPartialOutputBuffer } = require('../db/webhooks-streaming');
      clearPartialOutputBuffer(taskId);
    } catch (poErr) {
      // Non-fatal
    }
```

Note: The `clearPartialOutputBuffer` function handles both the in-memory cleanup AND the DB NULL-out internally (it has direct access to the `db` object via `setDb()`). The completion pipeline only needs to call the one function — no separate DB update needed. The relative import path is `../db/webhooks-streaming` (completion-pipeline is at `server/execution/`, webhooks-streaming is at `server/db/`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /c/Users/Werem/Projects/torque-public && npx vitest run server/tests/partial-output-streaming.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/db/webhooks-streaming.js server/execution/completion-pipeline.js server/tests/partial-output-streaming.test.js
git commit -m "feat(streaming): cleanup partial output buffer in completion pipeline"
```

---

## Task 4: Integration Test — End-to-End Streaming to Heartbeat

**Files:**
- Append to: `server/tests/partial-output-streaming.test.js`

- [ ] **Step 1: Write integration tests**

Append to `server/tests/partial-output-streaming.test.js`:

```javascript
describe('end-to-end integration', () => {
  test('streaming chunks appear in tasks.partial_output after flush', async () => {
    // 1. Create a task in the DB (status: running)
    // 2. Create a stream for the task
    // 3. Add multiple chunks over time
    // 4. Trigger a flush (advance time or add enough chunks)
    // 5. Read the task from DB
    // 6. Verify partial_output contains the chunks
  });

  test('completion pipeline NULLs out partial_output', async () => {
    // 1. Create a task, add chunks, flush
    // 2. Verify partial_output is populated
    // 3. Simulate task completion (call handlePostCompletion or the cleanup directly)
    // 4. Verify partial_output is NULL
  });

  test('DB fallback lookup when _streamToTask misses', async () => {
    // 1. Create a task and stream (populates _streamToTask)
    // 2. Manually delete the _streamToTask entry to simulate server restart
    // 3. Add a chunk — should trigger DB fallback lookup
    // 4. Verify accumulation still works
  });
});
```

- [ ] **Step 2: Implement the tests using real DB setup**

Follow the DB setup patterns from existing test files. Key assertions:
- `partial_output` appears in DB after flush
- `partial_output` is NULL after completion cleanup
- DB fallback lookup succeeds when in-memory cache misses

- [ ] **Step 3: Run all partial output tests**

Run: `cd /c/Users/Werem/Projects/torque-public && npx vitest run server/tests/partial-output-streaming.test.js`
Expected: ALL PASS

- [ ] **Step 4: Run heartbeat tests to verify no regression**

Run: `cd /c/Users/Werem/Projects/torque-public && npx vitest run server/tests/await-heartbeat.test.js`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add server/tests/partial-output-streaming.test.js
git commit -m "test(streaming): end-to-end integration tests for partial output pipeline"
```

---

## Dependency Graph

```
Task 1 (streamId→taskId cache) → Task 2 (accumulator + flush) → Task 3 (cleanup) → Task 4 (integration)
```

All tasks are sequential — each depends on the previous.
