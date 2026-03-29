'use strict';

class OutputBuffer {
  constructor({ flushCallback, maxLines = 20, flushIntervalMs = 500 } = {}) {
    if (typeof flushCallback !== 'function') {
      throw new TypeError('flushCallback must be a function');
    }
    if (!Number.isInteger(maxLines) || maxLines <= 0) {
      throw new TypeError('maxLines must be a positive integer');
    }
    if (!Number.isInteger(flushIntervalMs) || flushIntervalMs <= 0) {
      throw new TypeError('flushIntervalMs must be a positive integer');
    }

    this.flushCallback = flushCallback;
    this.maxLines = maxLines;
    this.flushIntervalMs = flushIntervalMs;
    this.buffer = [];
    this.timer = null;
    this.flushing = false;
    this._destroyed = false;
  }

  append(line) {
    if (this._destroyed) {
      throw new Error('OutputBuffer has been destroyed');
    }
    if (typeof line !== 'string') {
      throw new TypeError('line must be a string');
    }

    this.buffer.push(line);
    if (this.buffer.length >= this.maxLines) {
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.flushIntervalMs);
      if (typeof this.timer.unref === 'function') {
        this.timer.unref();
      }
    }
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0 || this.flushing) {
      return;
    }

    this.flushing = true;
    const lines = this.buffer.splice(0);
    try {
      this.flushCallback(lines.join('\n'));
    } finally {
      this.flushing = false;
    }
  }

  destroy() {
    if (this._destroyed) {
      return;
    }

    this._destroyed = true;
    this.flush();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

module.exports = OutputBuffer;
module.exports.OutputBuffer = OutputBuffer;
