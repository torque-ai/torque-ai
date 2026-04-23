'use strict';

function createReflectionExecutor({ reflect, debounceMs = 500 }) {
  const timers = new Map();

  function submit(key) {
    if (timers.has(key)) clearTimeout(timers.get(key));
    const t = setTimeout(async () => {
      timers.delete(key);
      try { await reflect(key); } catch (err) { console.error('reflect failed', err); }
    }, debounceMs);
    timers.set(key, t);
  }

  function cancel(key) {
    if (timers.has(key)) { clearTimeout(timers.get(key)); timers.delete(key); }
  }

  function cancelAll() {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  }

  return { submit, cancel, cancelAll };
}

module.exports = { createReflectionExecutor };
