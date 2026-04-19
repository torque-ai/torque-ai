'use strict';

async function escalate(_opts) {
  return { action: 'pause', reason: 'escalation stub' };
}

module.exports = { escalate };
