'use strict';

const VALID_ROLES = new Set(['system', 'user', 'assistant', 'tool']);

function validateTranscript(messages) {
  const errors = [];
  if (!Array.isArray(messages)) {
    return { ok: false, errors: ['transcript must be an array'] };
  }

  const openToolCalls = new Set();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];

    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      errors.push(`msg[${i}]: message must be an object`);
      continue;
    }

    if (!m.role) errors.push(`msg[${i}]: missing role`);
    if (m.role && !VALID_ROLES.has(m.role)) errors.push(`msg[${i}]: unknown role ${m.role}`);
    if (m.role !== 'tool' && m.content === undefined) errors.push(`msg[${i}]: missing content`);

    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc && tc.id) openToolCalls.add(tc.id);
      }
    }

    if (m.role === 'tool') {
      if (!m.tool_call_id) {
        errors.push(`msg[${i}]: tool message missing tool_call_id`);
      } else if (!openToolCalls.has(m.tool_call_id)) {
        errors.push(`msg[${i}]: tool_call_id '${m.tool_call_id}' references no prior tool call`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

module.exports = { validateTranscript };
