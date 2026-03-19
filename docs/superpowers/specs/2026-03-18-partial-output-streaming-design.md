# Partial Output Streaming — Phase 2 of Await Heartbeat

**Date:** 2026-03-18
**Status:** Draft
**Depends on:** Phase 1 — `docs/superpowers/specs/2026-03-18-await-heartbeat-design.md`

## Problem

Phase 1 added heartbeat check-ins to `await_task` and `await_workflow`. The heartbeat handler reads `tasks.partial_output` and includes it in the response. But no provider writes to this column — heartbeats always say "No output captured yet." Phase 2 closes this gap.

## Solution

Hook into the existing `addStreamChunk()` function in `webhooks-streaming.js` — the single bottleneck through which every provider's streaming output already passes. Maintain an in-memory ring buffer per task and periodically flush it to `tasks.partial_output`. Zero changes to provider code.

## Design Decisions

- **Single integration point:** All providers already call `addStreamChunk()`. Accumulating there means zero provider modifications.
- **Ring buffer:** 32 KB cap per task, truncated at newline boundaries when possible. Keeps recent output, discards old.
- **10-second flush:** Throttled DB writes. Heartbeats fire every 5 minutes, so 10-second staleness is imperceptible.
- **Direct SQL flush:** Bypasses `updateTaskStatus()` to avoid side effects (no event dispatch, no dashboard notification).
- **Cleanup in completion pipeline:** Final flush, then accumulator entry deleted and `partial_output` set to NULL.
- **Include both stdout and stderr:** Both stream types contribute diagnostically useful content. Stderr often contains the most valuable information (errors, warnings, stack traces).

## Architecture

```
Provider → addStreamChunk(streamId, token, 'stdout' or 'stderr')
                    ↓
           [existing chunk storage logic]
                    ↓
           [NEW] Accumulate token in per-task ring buffer
                    ↓
           [NEW] If 10s since last flush → UPDATE tasks SET partial_output = ? WHERE id = ?
                    ↓
           [existing] Heartbeat handler reads tasks.partial_output
```

**Why not reuse `stream_chunks` table?** Heartbeats need a single TEXT read, not a query + concatenation across many rows. The `partial_output` column provides O(1) read access. The `stream_chunks` table serves a different purpose (fine-grained history for dashboard streaming) and continues to operate independently.

## Accumulator Implementation

### Module-Level State in `webhooks-streaming.js`

```javascript
const _partialOutputBuffers = new Map(); // taskId → { buffer, lastFlushAt, streamId }
const _streamToTask = new Map();         // streamId → taskId
const FLUSH_INTERVAL_MS = 10000;         // 10 seconds
const MAX_BUFFER_SIZE = 32 * 1024;       // 32 KB
```

### Inside `addStreamChunk()` — After Existing Logic

Both `'stdout'` and `'stderr'` chunks are accumulated. The chunk type is not distinguished in the buffer — both contribute to the partial output window.

```
1. Resolve taskId from _streamToTask.get(streamId)
2. If taskId is undefined → DB fallback: query task_streams table, cache result in _streamToTask
3. If still undefined → skip accumulation (orphaned stream, non-fatal)
4. Get or create buffer entry: { buffer: '', lastFlushAt: Date.now(), streamId }
5. Append chunk text to buffer
6. If buffer.length > MAX_BUFFER_SIZE → truncate from front at newline boundary
7. If (Date.now() - lastFlushAt) >= FLUSH_INTERVAL_MS → flush to DB, update lastFlushAt
```

### StreamId → TaskId Resolution

`addStreamChunk()` receives a `streamId`, not a `taskId`. Resolution strategy:

**Primary:** Cache the mapping in `_streamToTask` when `getOrCreateTaskStream()` is called (this is the function all providers actually call — not `createTaskStream()` directly). Both `getOrCreateTaskStream()` and `createTaskStream()` populate the cache.

**Fallback:** If `_streamToTask.get(streamId)` returns undefined (e.g., stream was created before a server restart and the in-memory map was lost), do a single DB lookup: `SELECT task_id FROM task_streams WHERE id = ?`. Cache the result. One read per orphaned stream.

**If lookup fails:** Skip accumulation silently. The chunk still goes through existing storage (`stream_chunks` table). Only the `partial_output` accumulation is skipped. This is non-fatal.

### Ring Buffer Truncation

```javascript
if (buffer.length > MAX_BUFFER_SIZE) {
  const excess = buffer.length - MAX_BUFFER_SIZE;
  const newlineIdx = buffer.indexOf('\n', excess);
  if (newlineIdx !== -1) {
    buffer = buffer.slice(newlineIdx + 1);
  } else {
    // No newlines in buffer — hard truncate from end.
    // JavaScript String.slice operates on UTF-16 code units, so this
    // is safe for BMP characters. Surrogate pairs (rare in CLI output)
    // could theoretically be split, but this edge case is acceptable.
    buffer = buffer.slice(-MAX_BUFFER_SIZE);
  }
}
```

Truncation at newline boundaries preserves line integrity. The fallback hard-truncate is safe for typical CLI output.

### Flush Function

```javascript
function flushPartialOutput(taskId, buffer) {
  try {
    db.run('UPDATE tasks SET partial_output = ? WHERE id = ?', buffer, taskId);
  } catch (e) {
    // Non-fatal — never block chunk processing
  }
}
```

Direct SQL — no `updateTaskStatus()`, no side effects, no event dispatch.

### Exported API

```javascript
// Called from completion-pipeline.js
// Does a final flush before clearing, so no buffered output is lost.
function clearPartialOutputBuffer(taskId) {
  const entry = _partialOutputBuffers.get(taskId);
  if (entry && entry.buffer.length > 0) {
    flushPartialOutput(taskId, entry.buffer);
  }
  _partialOutputBuffers.delete(taskId);
  // Clean up _streamToTask entry
  if (entry && entry.streamId) {
    _streamToTask.delete(entry.streamId);
  }
}
```

## Cleanup in Completion Pipeline

In `server/execution/completion-pipeline.js`, after the task reaches a terminal state:

```javascript
try {
  const { clearPartialOutputBuffer } = require('../../db/webhooks-streaming');
  clearPartialOutputBuffer(taskId); // final flush + Map cleanup + _streamToTask cleanup
  db.run('UPDATE tasks SET partial_output = NULL WHERE id = ?', taskId);
} catch (e) {
  // Non-fatal
}
```

**Order:** Full `output` is written first → events dispatched → `clearPartialOutputBuffer()` does a final flush (ensures no buffered data is lost) → NULL out `partial_output`. By cleanup time, the task is terminal — heartbeats would return the completion result, not partial output.

## Buffered Providers (No Streaming)

Codex and claude-cli buffer output until process exit. They still call `addStreamChunk()` via `process-streams.js`, but chunks arrive in large batches at the end rather than continuously. For these providers:

- The accumulator works identically — chunks arrive, buffer fills, flush fires.
- But most output arrives at completion time, so `partial_output` will be mostly empty during execution.
- This is expected and documented in Phase 1: "No output captured yet (provider buffers until completion)."

## Server Restart Behavior

- In-memory `_partialOutputBuffers` and `_streamToTask` Maps are lost on restart.
- Previously-flushed `partial_output` in DB survives and is immediately available for heartbeats.
- New chunks after restart: `_streamToTask` miss triggers a DB fallback lookup (one query per stream), then accumulation resumes normally.
- At most 10 seconds of unflushed output is lost — acceptable given heartbeats fire every 5 minutes.

## Database Changes

None. The `partial_output` column already exists (Phase 1, Task 1). The `ALLOWED_TASK_COLUMNS` whitelist already includes it (Phase 1, Task 8).

## Phase 1 Spec Update

The Phase 1 spec (lines 118-119) described Phase 2 as a "provider-by-provider rollout: ollama first, then aider-ollama, then cloud API providers." This is no longer necessary — the `addStreamChunk()` bottleneck means all providers are captured in a single integration point. Update the Phase 1 spec to reflect this simplification.

## Files Modified

| File | Change |
|------|--------|
| `server/db/webhooks-streaming.js` | Add accumulator in `addStreamChunk()`, populate `_streamToTask` in `getOrCreateTaskStream()` and `createTaskStream()`, export `clearPartialOutputBuffer()` |
| `server/execution/completion-pipeline.js` | Call `clearPartialOutputBuffer()` and NULL out `partial_output` |

Two files. Zero provider changes. Zero schema changes.

## Testing Strategy

- Unit test: accumulator appends chunks and respects 32 KB cap
- Unit test: ring buffer truncates at newline boundary
- Unit test: ring buffer fallback truncation when no newlines present
- Unit test: flush fires after 10 seconds (fake timers)
- Unit test: flush does not fire before 10 seconds
- Unit test: both stdout and stderr chunks are accumulated
- Unit test: `clearPartialOutputBuffer` does final flush before clearing
- Unit test: `clearPartialOutputBuffer` cleans up `_streamToTask` entry
- Unit test: `_streamToTask` map is populated by `getOrCreateTaskStream`
- Unit test: DB fallback lookup when `_streamToTask` misses (post-restart scenario)
- Unit test: graceful skip when streamId → taskId resolution fails entirely
- Integration test: submit task with streaming provider, verify `partial_output` is populated in DB
- Integration test: completion pipeline clears `partial_output` to NULL
- Integration test: heartbeat includes partial output from streaming task
