/**
 * Tests for streamId-to-taskId cache in webhooks-streaming.js
 *
 * Phase 2 Task 1: Verifies that _streamToTask Map is populated by
 * createTaskStream and getOrCreateTaskStream, and that getStreamTaskId
 * returns the correct taskId for a given streamId.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { setupTestDb, setupTestDbModule, teardownTestDb, rawDb: _rawDb } = require('./vitest-setup');

let testDir, origDataDir, db, taskCore, mod;

function setup() {
  ({ db, testDir } = setupTestDb('partial-output-'));
  taskCore = require('../db/task-core');
  mod = require('../db/webhooks-streaming');
  mod.setDb(db.getDb ? db.getDb() : db.getDbInstance());
}

function teardown() {
  teardownTestDb();
}

/**
 * Create a task row in the DB so that task_streams foreign key constraints
 * are satisfied (task_id must exist in the tasks table).
 */
function makeTask(id) {
  taskCore.createTask({
    id,
    task_description: 'partial-output-streaming test task',
    working_directory: testDir,
    status: 'queued',
    priority: 0,
    project: null,
    provider: 'codex',
  });
}

beforeEach(() => {
  setup();
});

afterEach(() => {
  teardown();
});

describe('streamToTask cache', () => {
  test('createTaskStream populates _streamToTask cache', () => {
    const taskId = `test-task-1-${randomUUID()}`;
    makeTask(taskId);
    const streamId = mod.createTaskStream(taskId, 'output');
    expect(streamId).toBeDefined();
    expect(mod.getStreamTaskId(streamId)).toBe(taskId);
  });

  test('getOrCreateTaskStream populates _streamToTask cache', () => {
    const taskId = `test-task-2-${randomUUID()}`;
    makeTask(taskId);
    const streamId = mod.getOrCreateTaskStream(taskId, 'output');
    expect(mod.getStreamTaskId(streamId)).toBe(taskId);
  });

  test('getOrCreateTaskStream returns cached streamId on second call', () => {
    const taskId = `test-task-3-${randomUUID()}`;
    makeTask(taskId);
    const id1 = mod.getOrCreateTaskStream(taskId, 'output');
    const id2 = mod.getOrCreateTaskStream(taskId, 'output');
    expect(id1).toBe(id2);
    expect(mod.getStreamTaskId(id1)).toBe(taskId);
  });

  test('getStreamTaskId returns null for unknown streamId', () => {
    expect(mod.getStreamTaskId('nonexistent-stream-id')).toBeNull();
  });

  test('createTaskStream creates independent streams for different tasks', () => {
    const taskId1 = `test-task-a-${randomUUID()}`;
    const taskId2 = `test-task-b-${randomUUID()}`;
    makeTask(taskId1);
    makeTask(taskId2);
    const streamId1 = mod.createTaskStream(taskId1, 'output');
    const streamId2 = mod.createTaskStream(taskId2, 'output');
    expect(streamId1).not.toBe(streamId2);
    expect(mod.getStreamTaskId(streamId1)).toBe(taskId1);
    expect(mod.getStreamTaskId(streamId2)).toBe(taskId2);
  });
});

// ============================================================
// Phase 2 Task 2: Partial output accumulator tests
// ============================================================

/**
 * Helper: read partial_output directly from the DB for a given taskId.
 */
function getPartialOutputFromDb(taskId) {
  const raw = db.getDb ? db.getDb() : db.getDbInstance();
  const row = raw.prepare('SELECT partial_output FROM tasks WHERE id = ?').get(taskId);
  return row ? row.partial_output : null;
}

describe('partial output accumulator', () => {
  test('chunks are accumulated in buffer', () => {
    const taskId = `acc-task-1-${randomUUID()}`;
    makeTask(taskId);
    const streamId = mod.createTaskStream(taskId, 'output');

    mod.addStreamChunk(streamId, 'Hello ');
    mod.addStreamChunk(streamId, 'World');

    const buf = mod.getPartialOutputBuffer(taskId);
    expect(buf).toContain('Hello ');
    expect(buf).toContain('World');
  });

  test('stderr chunks are also accumulated', () => {
    const taskId = `acc-task-2-${randomUUID()}`;
    makeTask(taskId);
    const streamId = mod.createTaskStream(taskId, 'output');

    mod.addStreamChunk(streamId, 'stdout line\n', 'stdout');
    mod.addStreamChunk(streamId, 'stderr line\n', 'stderr');

    const buf = mod.getPartialOutputBuffer(taskId);
    expect(buf).toContain('stdout line');
    expect(buf).toContain('stderr line');
  });

  test('buffer respects 32 KB cap', () => {
    const taskId = `acc-task-3-${randomUUID()}`;
    makeTask(taskId);
    const streamId = mod.createTaskStream(taskId, 'output');

    // Write 40+ KB of data in multiple chunks
    const chunkSize = 4096;
    const numChunks = 12; // 12 * 4096 = 49152 bytes > 32KB
    for (let i = 0; i < numChunks; i++) {
      mod.addStreamChunk(streamId, 'X'.repeat(chunkSize) + '\n');
    }

    const buf = mod.getPartialOutputBuffer(taskId);
    expect(buf.length).toBeLessThanOrEqual(32 * 1024);
  });

  test('ring buffer truncates at newline boundary', () => {
    const taskId = `acc-task-4-${randomUUID()}`;
    makeTask(taskId);
    const streamId = mod.createTaskStream(taskId, 'output');

    // Write numbered lines that exceed 32 KB total
    const lines = [];
    for (let i = 0; i < 500; i++) {
      const line = `Line ${String(i).padStart(4, '0')}: ${'A'.repeat(100)}\n`;
      lines.push(line);
      mod.addStreamChunk(streamId, line);
    }

    const buf = mod.getPartialOutputBuffer(taskId);
    expect(buf.length).toBeLessThanOrEqual(32 * 1024);

    // Buffer should start at a line boundary (first char should be 'L' for "Line")
    expect(buf[0]).toBe('L');

    // Buffer should contain recent lines but not the oldest ones
    expect(buf).toContain('Line 0499');
    expect(buf).not.toContain('Line 0000');
  });

  test('ring buffer fallback when no newlines', () => {
    const taskId = `acc-task-5-${randomUUID()}`;
    makeTask(taskId);
    const streamId = mod.createTaskStream(taskId, 'output');

    // Write 40 KB without newlines
    mod.addStreamChunk(streamId, 'Z'.repeat(40 * 1024));

    const buf = mod.getPartialOutputBuffer(taskId);
    expect(buf.length).toBeLessThanOrEqual(32 * 1024);
    // Should be exactly 32 KB (tail slice)
    expect(buf.length).toBe(32 * 1024);
    expect(buf).toBe('Z'.repeat(32 * 1024));
  });

  test('flush writes to DB after 10 seconds', () => {
    vi.useFakeTimers();
    try {
      const taskId = `acc-task-6-${randomUUID()}`;
      makeTask(taskId);
      const streamId = mod.createTaskStream(taskId, 'output');

      // Add initial chunk — buffer created with lastFlushAt = Date.now()
      mod.addStreamChunk(streamId, 'chunk-A\n');

      // Advance time by 11 seconds
      vi.advanceTimersByTime(11000);

      // Add another chunk — this triggers the flush check
      mod.addStreamChunk(streamId, 'chunk-B\n');

      // partial_output should now be written to DB
      const output = getPartialOutputFromDb(taskId);
      expect(output).toContain('chunk-A');
      expect(output).toContain('chunk-B');
    } finally {
      vi.useRealTimers();
    }
  });

  test('flush does NOT fire before 10 seconds', () => {
    vi.useFakeTimers();
    try {
      const taskId = `acc-task-7-${randomUUID()}`;
      makeTask(taskId);
      const streamId = mod.createTaskStream(taskId, 'output');

      mod.addStreamChunk(streamId, 'chunk-A\n');

      // Advance only 5 seconds
      vi.advanceTimersByTime(5000);

      mod.addStreamChunk(streamId, 'chunk-B\n');

      // partial_output should still be NULL — flush hasn't fired
      const output = getPartialOutputFromDb(taskId);
      expect(output).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test('unknown streamId skips accumulation without corrupting buffer state', () => {
    // When the _streamToTask cache doesn't contain the mapping and the DB
    // fallback also doesn't find a task_id, the accumulator should gracefully
    // skip without affecting buffers for other tasks.
    const taskId = `acc-task-8-${randomUUID()}`;
    makeTask(taskId);
    const streamId = mod.createTaskStream(taskId, 'output');

    // Add a valid chunk to build up some buffer state
    mod.addStreamChunk(streamId, 'valid-data\n');

    // The existing addStreamChunk throws on FK violation for unknown streams.
    // Verify the accumulator doesn't corrupt existing buffers even if
    // an error occurs in the transaction for a different stream.
    try {
      mod.addStreamChunk('nonexistent-stream-id-xyz', 'bad data');
    } catch {
      // Expected — FK constraint violation from the INSERT transaction
    }

    // Original task's buffer should be unaffected
    const buf = mod.getPartialOutputBuffer(taskId);
    expect(buf).toContain('valid-data');
  });
});

// ============================================================
// Phase 2 Task 3: clearPartialOutputBuffer tests
// ============================================================

describe('clearPartialOutputBuffer', () => {
  test('does final flush before clearing', () => {
    const taskId = `clear-task-1-${randomUUID()}`;
    makeTask(taskId);
    const streamId = mod.createTaskStream(taskId, 'output');

    // Add chunks (unflushed — well under 10 second flush threshold)
    mod.addStreamChunk(streamId, 'unflushed-data\n');

    // Verify buffer has content before clear
    expect(mod.getPartialOutputBuffer(taskId)).toContain('unflushed-data');

    // Call clearPartialOutputBuffer — should flush then clear
    mod.clearPartialOutputBuffer(taskId);

    // Buffer entry should be gone
    expect(mod.getPartialOutputBuffer(taskId)).toBeNull();
  });

  test('NULLs out partial_output in DB', () => {
    const taskId = `clear-task-2-${randomUUID()}`;
    makeTask(taskId);
    const streamId = mod.createTaskStream(taskId, 'output');

    mod.addStreamChunk(streamId, 'some-output\n');

    // Call clearPartialOutputBuffer — flushes then NULLs partial_output
    mod.clearPartialOutputBuffer(taskId);

    // partial_output should be NULL in DB
    const raw = db.getDb ? db.getDb() : db.getDbInstance();
    const row = raw.prepare('SELECT partial_output FROM tasks WHERE id = ?').get(taskId);
    expect(row.partial_output).toBeNull();
  });

  test('cleans up _streamToTask entry', () => {
    const taskId = `clear-task-3-${randomUUID()}`;
    makeTask(taskId);
    const streamId = mod.createTaskStream(taskId, 'output');

    mod.addStreamChunk(streamId, 'some-data\n');

    // Verify the stream→task mapping is present before clear
    expect(mod.getStreamTaskId(streamId)).toBe(taskId);

    // Call clearPartialOutputBuffer
    mod.clearPartialOutputBuffer(taskId);

    // _streamToTask entry for this stream should be gone
    expect(mod.getStreamTaskId(streamId)).toBeNull();
  });

  test('no-op for unknown taskId', () => {
    // Should not throw for a taskId that has no buffer entry
    expect(() => mod.clearPartialOutputBuffer('nonexistent-task-id')).not.toThrow();
  });
});

// ============================================================
// Phase 2 Task 4: End-to-end integration tests
// ============================================================

describe('end-to-end integration', () => {
  test('streaming chunks appear in tasks.partial_output after flush', () => {
    vi.useFakeTimers();
    try {
      const taskId = `e2e-task-1-${randomUUID()}`;
      makeTask(taskId);

      // Create a stream for the task
      const streamId = mod.getOrCreateTaskStream(taskId, 'output');

      // Add multiple chunks (no flush yet — under 10s threshold)
      mod.addStreamChunk(streamId, 'chunk-one\n');
      mod.addStreamChunk(streamId, 'chunk-two\n');
      mod.addStreamChunk(streamId, 'chunk-three\n');

      // Advance time past the 10 second flush threshold
      vi.advanceTimersByTime(11000);

      // Add another chunk to trigger the flush check
      mod.addStreamChunk(streamId, 'chunk-four\n');

      // Read partial_output directly from the DB
      const output = getPartialOutputFromDb(taskId);
      expect(output).not.toBeNull();
      expect(output).toContain('chunk-one');
      expect(output).toContain('chunk-two');
      expect(output).toContain('chunk-three');
      expect(output).toContain('chunk-four');
    } finally {
      vi.useRealTimers();
    }
  });

  test('completion pipeline clears partial_output to NULL', () => {
    const taskId = `e2e-task-2-${randomUUID()}`;
    makeTask(taskId);

    const streamId = mod.getOrCreateTaskStream(taskId, 'output');

    // Add chunks and force a flush by calling clearPartialOutputBuffer
    // (which itself does a final flush before NULLing)
    mod.addStreamChunk(streamId, 'pre-completion-data\n');

    // Verify buffer has content before clear
    expect(mod.getPartialOutputBuffer(taskId)).toContain('pre-completion-data');

    // Force a manual flush so partial_output is populated in DB before we clear
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(11000);
      mod.addStreamChunk(mod.getOrCreateTaskStream(taskId, 'output'), 'trigger-flush\n');
    } finally {
      vi.useRealTimers();
    }

    // partial_output should now be populated
    const beforeClear = getPartialOutputFromDb(taskId);
    expect(beforeClear).not.toBeNull();

    // Simulate completion pipeline: clear partial output buffer
    mod.clearPartialOutputBuffer(taskId);

    // partial_output should be NULL after completion
    const afterClear = getPartialOutputFromDb(taskId);
    expect(afterClear).toBeNull();
  });

  test('DB fallback lookup when _streamToTask cache misses', () => {
    const taskId = `e2e-task-3-${randomUUID()}`;
    makeTask(taskId);

    // Create a stream — this populates _streamToTask and writes to task_streams DB table
    const streamId = mod.getOrCreateTaskStream(taskId, 'output');
    expect(mod.getStreamTaskId(streamId)).toBe(taskId);

    // Add a chunk so a buffer entry exists (required for clearPartialOutputBuffer
    // to delete the _streamToTask entry via entry.streamId)
    mod.addStreamChunk(streamId, 'initial-chunk\n');

    // Simulate a server restart: clearPartialOutputBuffer evicts the cache entry
    // (entry.streamId is deleted from _streamToTask). The stream record still
    // exists in the task_streams DB table, so the DB fallback can recover it.
    mod.clearPartialOutputBuffer(taskId);

    // Cache should now be empty for this stream
    expect(mod.getStreamTaskId(streamId)).toBeNull();

    // Add a chunk — addStreamChunk should detect the cache miss and fall back
    // to querying task_streams in the DB to recover the taskId mapping
    mod.addStreamChunk(streamId, 'post-restart-chunk\n');

    // The accumulator should have worked: in-memory buffer should contain the chunk
    const buf = mod.getPartialOutputBuffer(taskId);
    expect(buf).not.toBeNull();
    expect(buf).toContain('post-restart-chunk');

    // _streamToTask should have been re-populated by the DB fallback
    expect(mod.getStreamTaskId(streamId)).toBe(taskId);
  });
});
