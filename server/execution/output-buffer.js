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
    this._lines = [];
    this._interval = null;
    this._destroyed = false;
  }

  append(line) {
    if (this._destroyed) {
      throw new Error('OutputBuffer has been destroyed');
    }
    if (typeof line !== 'string') {
      throw new TypeError('line must be a string');
    }

    this._ensureInterval();
    this._lines.push(line);

    if (this._lines.length >= this.maxLines) {
      this.flush();
    }
  }

  flush() {
    if (this._lines.length === 0) {
      return;
    }

    const lines = this._lines;
    this._lines = [];
    this.flushCallback(lines);
  }

  destroy() {
    if (this._destroyed) {
      return;
    }

    this._destroyed = true;
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }

    this.flush();
  }

  _ensureInterval() {
    if (this._interval) {
      return;
    }

    this._interval = setInterval(() => {
      this.flush();
    }, this.flushIntervalMs);

    if (typeof this._interval.unref === 'function') {
      this._interval.unref();
    }
  }
}

module.exports = {
  OutputBuffer,
};
