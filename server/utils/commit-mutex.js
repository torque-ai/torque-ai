'use strict';

let locked = false;
let waitQueue = [];

function validateTimeout(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new TypeError('CommitMutex: timeoutMs must be a non-negative finite number');
  }
}

function createReleaseHandle() {
  let released = false;

  return function releaseHandle() {
    if (released) return;
    released = true;
    release();
  };
}

async function acquire(timeoutMs = 30000) {
  validateTimeout(timeoutMs);

  if (!locked) {
    locked = true;
    return createReleaseHandle();
  }

  let entry;
  let settled = false;
  let timer = null;

  const waitPromise = new Promise((resolve) => {
    entry = {
      resolve: () => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        resolve();
      }
    };

    waitQueue.push(entry);
  });

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;

      const index = waitQueue.indexOf(entry);
      if (index !== -1) {
        waitQueue.splice(index, 1);
      }

      reject(new Error('CommitMutex: acquire timeout'));
    }, timeoutMs);
  });

  await Promise.race([waitPromise, timeoutPromise]);

  if (timer !== null) clearTimeout(timer);
  return createReleaseHandle();
}

function release() {
  if (!locked) return;

  const next = waitQueue.shift();
  if (next) {
    next.resolve();
    return;
  }

  locked = false;
}

function isLocked() {
  return locked;
}

function waitingCount() {
  return waitQueue.length;
}

function _reset() {
  locked = false;
  waitQueue = [];
}

module.exports = {
  acquire,
  release,
  isLocked,
  waitingCount,
  _reset
};
