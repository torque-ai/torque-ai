'use strict';

const { listEvents } = require('../events/event-emitter');
const { ErrorCodes, makeError } = require('./shared');

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 5000;

function normalizeLimit(value) {
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: DEFAULT_LIMIT };
  }

  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) {
    return { ok: false, error: `limit must be an integer between 1 and ${MAX_LIMIT}` };
  }

  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    return { ok: false, error: `limit must be an integer between 1 and ${MAX_LIMIT}` };
  }

  return { ok: true, value: parsed };
}

function summarizeEvent(event) {
  const taskRef = event.task_id ? event.task_id.slice(0, 8) : 'workflow';
  return `- [${event.ts}] ${event.type} (${event.actor || 'unknown'}) -> ${taskRef}`;
}

function handleListTaskEvents(args = {}) {
  const limit = normalizeLimit(args.limit);
  if (!limit.ok) {
    return makeError(ErrorCodes.INVALID_PARAM, limit.error);
  }

  try {
    const events = listEvents({
      task_id: args.task_id || null,
      workflow_id: args.workflow_id || null,
      type: args.type || null,
      since: args.since || null,
      limit: limit.value,
    });

    const text = `Found ${events.length} event(s):\n\n${events.map(summarizeEvent).join('\n')}`;
    return {
      content: [{ type: 'text', text }],
      structuredData: { events },
    };
  } catch (err) {
    return makeError(ErrorCodes.OPERATION_FAILED, `Failed to list task events: ${err.message}`);
  }
}

module.exports = { handleListTaskEvents };
