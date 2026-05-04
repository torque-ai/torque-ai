'use strict';

const BEHAVIORAL_TAG_KEYS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];

function applyBehavioralTags(tool, hints = {}) {
  const t = { ...tool };
  t.readOnlyHint = hints.readOnlyHint ?? false;
  t.destructiveHint = hints.destructiveHint ?? false;
  t.idempotentHint = hints.idempotentHint ?? (t.destructiveHint ? false : true);
  t.openWorldHint = hints.openWorldHint ?? false;
  return t;
}

function filterByTags(tools, hints) {
  return tools.filter((t) => BEHAVIORAL_TAG_KEYS.every((k) => hints[k] === undefined || t[k] === hints[k]));
}

module.exports = { applyBehavioralTags, filterByTags, BEHAVIORAL_TAG_KEYS };
