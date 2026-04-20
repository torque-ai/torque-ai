'use strict';

const path = require('node:path');
const modulePath = path.resolve(__dirname, '../factory/dep-resolver/index.js');

describe('dep-resolver resolve()', () => {
  const savedCache = new Map();

  function installMocks({ submit, await: awaitFn, task }) {
    [
      { path: require.resolve('../factory/internal-task-submit'), exports: { submitFactoryInternalTask: submit } },
      { path: require.resolve('../handlers/workflow/await'), exports: { handleAwaitTask: awaitFn } },
      { path: require.resolve('../db/task-core'), exports: { getTask: task } },
    ].forEach(({ path, exports }) => {
      savedCache.set(path, require.cache[path]);
      require.cache[path] = { id: path, filename: path, loaded: true, exports, children: [], paths: [] };
    });
    delete require.cache[modulePath];
  }

  afterEach(() => {
    for (const [p, cached] of savedCache) {
      if (cached) require.cache[p] = cached;
      else delete require.cache[p];
    }
    savedCache.clear();
    delete require.cache[modulePath];
  });

  const baseArgs = () => ({
    classification: {
      classification: 'missing_dep',
      manager: 'python',
      package_name: 'opencv-python',
      module_name: 'cv2',
    },
    project: { id: 'p', path: '/tmp/p' },
    worktree: { path: '/tmp/p/.worktrees/feat-factory-79' },
    workItem: { id: 79, title: 'Add scoring' },
    instance: { id: 'i1', batch_id: 'b1' },
    adapter: {
      manager: 'python',
      buildResolverPrompt: () => 'Install opencv-python and commit.',
      validateManifestUpdate: () => ({ valid: true, manifest: 'pyproject.toml' }),
    },
    options: {},
  });

  it('returns outcome=resolved when resolver task completes and validation passes', async () => {
    installMocks({
      submit: vi.fn().mockResolvedValue({ task_id: 'r1' }),
      await: vi.fn().mockResolvedValue({ status: 'completed' }),
      task: vi.fn().mockReturnValue({ status: 'completed', output: 'done' }),
    });
    const { resolve } = require('../factory/dep-resolver/index');
    const r = await resolve(baseArgs());
    expect(r.outcome).toBe('resolved');
    expect(r.reverifyNeeded).toBe(true);
    expect(r.taskId).toBe('r1');
    expect(r.package).toBe('opencv-python');
  });

  it('returns outcome=resolver_task_failed when submit throws', async () => {
    installMocks({
      submit: vi.fn().mockRejectedValue(new Error('boom')),
      await: vi.fn(),
      task: vi.fn(),
    });
    const { resolve } = require('../factory/dep-resolver/index');
    const r = await resolve(baseArgs());
    expect(r.outcome).toBe('resolver_task_failed');
    expect(r.reverifyNeeded).toBe(false);
    expect(r.reason).toMatch(/submit_threw/);
  });

  it('returns outcome=validation_failed when validator rejects the commit', async () => {
    installMocks({
      submit: vi.fn().mockResolvedValue({ task_id: 'r2' }),
      await: vi.fn().mockResolvedValue({ status: 'completed' }),
      task: vi.fn().mockReturnValue({ status: 'completed', output: 'done' }),
    });
    const args = baseArgs();
    args.adapter.validateManifestUpdate = () => ({ valid: false, reason: 'not found in any manifest' });
    const { resolve } = require('../factory/dep-resolver/index');
    const r = await resolve(args);
    expect(r.outcome).toBe('validation_failed');
    expect(r.reason).toContain('not found');
  });

  it('returns outcome=resolver_task_failed when task completed but status!=completed', async () => {
    installMocks({
      submit: vi.fn().mockResolvedValue({ task_id: 'r3' }),
      await: vi.fn().mockResolvedValue({ status: 'timeout' }),
      task: vi.fn().mockReturnValue({ status: 'failed', output: 'pip: could not resolve' }),
    });
    const { resolve } = require('../factory/dep-resolver/index');
    const r = await resolve(baseArgs());
    expect(r.outcome).toBe('resolver_task_failed');
    expect(r.reason).toMatch(/status/);
  });
});
