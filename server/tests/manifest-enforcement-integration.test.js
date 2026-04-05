'use strict';

const { registerBuiltInHook, listHooks, removeHook } = require('../hooks/post-tool-hooks');

describe('manifest-enforcement integration', () => {
  beforeEach(() => {
    // Clean up any previously registered hook
    const existing = listHooks('task_complete').find(h => h.hook_name === 'manifest_enforcement');
    if (existing) removeHook(existing.id);
  });

  it('can register the manifest_enforcement built-in hook', () => {
    const result = registerBuiltInHook('task_complete', 'manifest_enforcement');
    expect(result.hook_name).toBe('manifest_enforcement');
    expect(result.event_type).toBe('task_complete');
    expect(result.built_in).toBe(true);
  });

  it('appears in listHooks after registration', () => {
    registerBuiltInHook('task_complete', 'manifest_enforcement');
    const hooks = listHooks('task_complete');
    const found = hooks.find(h => h.hook_name === 'manifest_enforcement');
    expect(found).toBeDefined();
    expect(found.built_in).toBe(true);
  });
});
