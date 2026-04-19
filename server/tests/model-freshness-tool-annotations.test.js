'use strict';

const { getAnnotations, OVERRIDES } = require('../tool-annotations');

describe('model-freshness — tool annotations', () => {
  const tools = [
    'model_watchlist_list',
    'model_watchlist_add',
    'model_watchlist_remove',
    'model_freshness_scan_now',
    'model_freshness_events',
  ];

  it.each(tools)('%s is annotated (covered by OVERRIDES, not fallback)', (name) => {
    expect(OVERRIDES[name]).toBeDefined();
    const ann = getAnnotations(name);
    expect(ann).toBeDefined();
    expect(typeof ann.readOnlyHint).toBe('boolean');
  });

  it('list operations are read-only', () => {
    expect(getAnnotations('model_watchlist_list').readOnlyHint).toBe(true);
    expect(getAnnotations('model_freshness_events').readOnlyHint).toBe(true);
  });

  it('mutation operations are not read-only', () => {
    expect(getAnnotations('model_watchlist_add').readOnlyHint).toBe(false);
    expect(getAnnotations('model_watchlist_remove').readOnlyHint).toBe(false);
  });

  it('scan_now is not read-only (dispatches work)', () => {
    expect(getAnnotations('model_freshness_scan_now').readOnlyHint).toBe(false);
  });
});
