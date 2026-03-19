'use strict';
const timers = new Set();

module.exports = {
  trackInterval: (handle) => { timers.add(handle); return handle; },
  trackTimeout: (handle) => { timers.add(handle); return handle; },
  remove: (handle) => { timers.delete(handle); },
  clearAll: () => {
    for (const h of timers) {
      clearInterval(h);
      clearTimeout(h);
    }
    timers.clear();
  },
  size: () => timers.size,
};
