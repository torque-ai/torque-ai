'use strict';

const MEMORY_KINDS = ['semantic', 'episodic', 'procedural'];

function validateMemory(m) {
  if (!MEMORY_KINDS.includes(m.kind)) throw new Error(`unknown kind: ${m.kind}`);
  if (m.kind === 'semantic') {
    if (typeof m.content !== 'string' || !m.content.length) throw new Error('semantic memory requires content');
  } else if (m.kind === 'episodic') {
    let parsed;
    try { parsed = JSON.parse(m.content); } catch { throw new Error('episodic memory content must be JSON'); }
    for (const k of ['input', 'output', 'rationale']) {
      if (parsed[k] === undefined) throw new Error(`episodic memory missing ${k}`);
    }
  } else if (m.kind === 'procedural') {
    if (!m.role) throw new Error('procedural memory requires role');
    if (typeof m.content !== 'string' || !m.content.length) throw new Error('procedural memory requires content (prompt body)');
  }
}

function resolveNamespace(template, vars = {}) {
  return template.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
}

module.exports = { MEMORY_KINDS, validateMemory, resolveNamespace };
