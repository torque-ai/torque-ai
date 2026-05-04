'use strict';

/**
 * Polled file tailer used by the subprocess-detachment arc (see
 * docs/design/2026-05-03-subprocess-detachment-codex-spike.md §4.6).
 *
 * Detached subprocesses write stdout/stderr directly to disk log files
 * instead of in-memory pipes. The runner observes that output by
 * tailing the log file from a saved byte offset and emitting `chunk`
 * events that look like the old pipe `data` events. After a restart,
 * a fresh runner instance can re-attach to the same log by passing
 * `startOffset` from the persisted `output_log_offset` task column —
 * the byte stream is replayed from where the previous runner stopped
 * consuming, so no output is lost and no output is duplicated.
 *
 * Polling, not fs.watch, because:
 *   - fs.watch semantics differ across platforms (events vs. polling
 *     under the hood, network-drive support varies, Windows often
 *     emits change events without payloads).
 *   - We want a deterministic cadence so stall detection's idle-time
 *     calculation aligns with reality.
 *   - Subprocess output rates are modest (~5-50 KB/s for codex CLI);
 *     a 250 ms poll × 64 KB read window handles ~256 KB/s before
 *     lagging, well above the worst case.
 *
 * Phase A ships the tailer with tests; no caller is wired to it yet.
 *
 * Events:
 *   'chunk' (text: string, newOffset: number)
 *     A non-empty slice of new bytes was read from the file. The
 *     listener should append `text` to its accumulator and persist
 *     `newOffset` at a throttled cadence so re-adoption can resume
 *     from the right spot.
 *
 *   'error' (err: Error)
 *     stat()/open()/read() returned a fatal error. ENOENT during
 *     start-up (the writer hasn't created the file yet) is NOT
 *     emitted — the tailer keeps polling and silently waits for
 *     the file to appear. ENOENT after the file existed (the
 *     writer truncated/moved it) IS emitted, and the tailer stops.
 */

const fs = require('fs');
const { EventEmitter } = require('events');

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_READ_CHUNK_BYTES = 64 * 1024;

class Tail extends EventEmitter {
  /**
   * @param {string} filePath
   * @param {object} [options]
   * @param {number} [options.startOffset=0]
   * @param {number} [options.pollIntervalMs=250]
   * @param {number} [options.readChunkBytes=65536]
   */
  constructor(filePath, options = {}) {
    super();
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new Error('Tail requires a non-empty filePath');
    }
    this.filePath = filePath;
    this.offset = Number.isFinite(options.startOffset) && options.startOffset >= 0
      ? Math.floor(options.startOffset)
      : 0;
    this.pollIntervalMs = Number.isFinite(options.pollIntervalMs) && options.pollIntervalMs > 0
      ? options.pollIntervalMs
      : DEFAULT_POLL_INTERVAL_MS;
    this.readChunkBytes = Number.isFinite(options.readChunkBytes) && options.readChunkBytes > 0
      ? options.readChunkBytes
      : DEFAULT_READ_CHUNK_BYTES;

    this._timer = null;
    this._running = false;
    this._sawFile = false;
    this._polling = false;
  }

  start() {
    if (this._running) return;
    this._running = true;
    // Fire one poll immediately so callers waiting on the first chunk
    // don't have to sit through the full poll-interval delay.
    setImmediate(() => this._safePoll());
    this._timer = setInterval(() => this._safePoll(), this.pollIntervalMs);
    if (typeof this._timer.unref === 'function') {
      // Tailers shouldn't keep the event loop alive on their own —
      // the runner that owns the task should drive shutdown.
      this._timer.unref();
    }
  }

  stop() {
    this._running = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Returns the current byte offset. Useful when the runner needs
   * to persist progress between polls without waiting for the next
   * 'chunk' event.
   * @returns {number}
   */
  getOffset() {
    return this.offset;
  }

  _safePoll() {
    // Defensive — overlapping polls could happen if the disk is slow
    // and the read takes longer than the poll interval. Skip overlaps
    // rather than queueing up redundant work.
    if (!this._running || this._polling) return;
    this._polling = true;
    try {
      this._poll();
    } finally {
      this._polling = false;
    }
  }

  _poll() {
    let stat;
    try {
      stat = fs.statSync(this.filePath);
      this._sawFile = true;
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        // Two cases:
        //   1. The writer hasn't created the file yet — keep polling
        //      silently.
        //   2. The file existed and was deleted — stop and surface.
        if (this._sawFile) {
          this.stop();
          this.emit('error', err);
        }
        return;
      }
      this.emit('error', err);
      return;
    }

    // Truncation / rotation: file is shorter than our recorded offset.
    // Reset to read from the start of the new file content.
    if (stat.size < this.offset) {
      this.offset = 0;
    }

    if (stat.size <= this.offset) return; // no new data

    let fd = null;
    try {
      fd = fs.openSync(this.filePath, 'r');
      const available = stat.size - this.offset;
      const bufSize = Math.min(available, this.readChunkBytes);
      const buf = Buffer.alloc(bufSize);
      const bytesRead = fs.readSync(fd, buf, 0, bufSize, this.offset);
      if (bytesRead > 0) {
        const text = buf.slice(0, bytesRead).toString('utf8');
        this.offset += bytesRead;
        this.emit('chunk', text, this.offset);
      }
    } catch (err) {
      this.emit('error', err);
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
    }
  }
}

module.exports = {
  Tail,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_READ_CHUNK_BYTES,
};
