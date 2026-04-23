'use strict';

function createAction({ name, reads, writes, run }) {
  if (!name) throw new Error('action: name required');
  if (typeof run !== 'function') throw new Error('action: run(state,inputs) required');
  if (!Array.isArray(reads)) throw new Error('action: reads array required');
  if (!Array.isArray(writes)) throw new Error('action: writes array required');

  const writeSet = new Set(writes);

  async function invoke(state, inputs = {}) {
    const view = {};
    for (const k of reads) view[k] = state[k];
    const out = await run(view, inputs);
    if (!out || typeof out !== 'object') throw new Error(`action ${name}: run must return {result,patch}`);
    const patch = out.patch || {};
    for (const k of Object.keys(patch)) {
      if (!writeSet.has(k)) throw new Error(`action ${name}: undeclared write "${k}"`);
    }
    return { result: out.result ?? null, patch };
  }

  return { name, reads: reads.slice(), writes: writes.slice(), invoke };
}

module.exports = { createAction };
