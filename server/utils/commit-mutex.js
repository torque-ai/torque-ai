'use strict';

class CommitMutex {
  constructor() {
    this._locked = false;
    this._waiting = [];
  }

  _validateTimeout(timeoutMs) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new TypeError('CommitMutex: timeoutMs must be a non-negative finite number');
    }
  }

  acquire(timeoutMs = 30000) {
    this._validateTimeout(timeoutMs);

    if (!this._locked) {
      this._locked = true;
      return Promise.resolve(this._createReleaseHandle());
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        grant: () => {
          if (waiter._settled) return;
          waiter._settled = true;
          clearTimeout(waiter._timer);
          resolve(this._createReleaseHandle());
        },
        _settled: false,
        _timer: null
      };

      waiter._timer = setTimeout(() => {
        if (waiter._settled) return;
        waiter._settled = true;

        const index = this._waiting.indexOf(waiter);
        if (index !== -1) {
          this._waiting.splice(index, 1);
        }

        reject(new Error('CommitMutex: acquire timeout'));
      }, timeoutMs);

      this._waiting.push(waiter);
    });
  }

  _createReleaseHandle() {
    let released = false;

    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  release() {
    if (!this._locked) return;

    const next = this._waiting.shift();
    if (!next) {
      this._locked = false;
      return;
    }

    next.grant();
  }

  isLocked() {
    return this._locked;
  }

  waitingCount() {
    return this._waiting.length;
  }
}

const mutex = new CommitMutex();

module.exports = { mutex, CommitMutex };
