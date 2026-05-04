'use strict';

const { applyBehavioralTags, filterByTags, BEHAVIORAL_TAG_KEYS } = require('../tool-behavioral-tags');

describe('behavioralTags', () => {
  it('applyBehavioralTags fills defaults for missing hints', () => {
    const tool = applyBehavioralTags({ name: 'read_file' }, { readOnlyHint: true });
    expect(tool.readOnlyHint).toBe(true);
    expect(tool.destructiveHint).toBe(false);
    expect(tool.idempotentHint).toBe(true);
    expect(tool.openWorldHint).toBe(false);
  });

  it('destructiveHint implies non-idempotent by default', () => {
    const tool = applyBehavioralTags({ name: 'delete_file' }, { destructiveHint: true });
    expect(tool.destructiveHint).toBe(true);
    expect(tool.idempotentHint).toBe(false);
  });

  it('filterByTags keeps tools matching ALL hints', () => {
    const tools = [
      { name: 'a', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      { name: 'b', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      { name: 'c', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    ];
    expect(filterByTags(tools, { readOnlyHint: true, openWorldHint: false }).map((t) => t.name)).toEqual(['a']);
  });

  it('BEHAVIORAL_TAG_KEYS exposes the canonical tag names', () => {
    expect(BEHAVIORAL_TAG_KEYS).toEqual(['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']);
  });
});
