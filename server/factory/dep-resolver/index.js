'use strict';

async function resolve(_opts) {
  return { outcome: 'unhandled', reverifyNeeded: false, reason: 'stub' };
}

module.exports = { resolve };
