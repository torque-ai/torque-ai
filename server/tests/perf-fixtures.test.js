'use strict';

const { buildFixture } = require('../perf/fixtures');

describe('perf fixture builder', () => {
  it('returns a sqlite handle plus seeded counts', () => {
    const fx = buildFixture({ tasks: 100 });
    try {
      expect(fx.db).toBeDefined();
      const taskCount = fx.db.prepare('SELECT COUNT(*) as c FROM tasks').get().c;
      expect(taskCount).toBe(100);
      const projectMatches = fx.db.prepare('SELECT COUNT(*) as c FROM tasks WHERE project = ?').get(fx.projectId).c;
      expect(projectMatches).toBe(100);
    } finally {
      fx.close();
    }
  });

  it('seeds deterministically — same options produce same task ids', () => {
    const a = buildFixture({ tasks: 10, seed: 42 });
    const b = buildFixture({ tasks: 10, seed: 42 });
    try {
      const aIds = a.db.prepare('SELECT id FROM tasks ORDER BY id').all().map((r) => r.id);
      const bIds = b.db.prepare('SELECT id FROM tasks ORDER BY id').all().map((r) => r.id);
      expect(aIds).toEqual(bIds);
    } finally {
      a.close();
      b.close();
    }
  });

  it('builds an empty fixture when tasks=0', () => {
    const fx = buildFixture({ tasks: 0 });
    try {
      const taskCount = fx.db.prepare('SELECT COUNT(*) as c FROM tasks').get().c;
      expect(taskCount).toBe(0);
    } finally {
      fx.close();
    }
  });

  it('exposes projectId on the returned object', () => {
    const fx = buildFixture({ tasks: 1, projectId: 'custom-project' });
    try {
      expect(fx.projectId).toBe('custom-project');
    } finally {
      fx.close();
    }
  });
});
