'use strict';

const path = require('node:path');
const modulePath = path.resolve(__dirname, '../factory/dep-resolver/escalation.js');

describe('escalation.escalate()', () => {
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

  const baseArgs = {
    project: { id: 'p', path: '/tmp/p' },
    workItem: { id: 1, title: 't' },
    originalError: 'ModuleNotFoundError: No module named cv2',
    resolverError: 'ERROR: Could not find a version that satisfies the requirement cv2',
    resolverPrompt: 'Add opencv...',
    manifestExcerpt: '[project]\nname="x"',
  };

  it('returns {action:"retry", revisedPrompt} when LLM says retry with a new prompt', async () => {
    installMocks({
      submit: vi.fn().mockResolvedValue({ task_id: 'e1' }),
      await: vi.fn().mockResolvedValue({ status: 'completed' }),
      task: vi.fn().mockReturnValue({
        status: 'completed',
        output: '{"action":"retry","revised_prompt":"Install `opencv-python` not `cv2`","reason":"wrong name"}',
      }),
    });
    const { escalate } = require('../factory/dep-resolver/escalation');
    const r = await escalate(baseArgs);
    expect(r.action).toBe('retry');
    expect(r.revisedPrompt).toContain('opencv-python');
    expect(r.reason).toBe('wrong name');
  });

  it('returns {action:"pause"} when LLM says pause', async () => {
    installMocks({
      submit: vi.fn().mockResolvedValue({ task_id: 'e2' }),
      await: vi.fn().mockResolvedValue({ status: 'completed' }),
      task: vi.fn().mockReturnValue({
        status: 'completed',
        output: '{"action":"pause","revised_prompt":null,"reason":"private registry unreachable"}',
      }),
    });
    const { escalate } = require('../factory/dep-resolver/escalation');
    const r = await escalate(baseArgs);
    expect(r.action).toBe('pause');
    expect(r.reason).toContain('private registry');
  });

  it('fail-opens to pause when submit throws', async () => {
    installMocks({
      submit: vi.fn().mockRejectedValue(new Error('provider down')),
      await: vi.fn(),
      task: vi.fn(),
    });
    const { escalate } = require('../factory/dep-resolver/escalation');
    const r = await escalate(baseArgs);
    expect(r.action).toBe('pause');
    expect(r.reason).toMatch(/escalation_llm_unavailable/);
  });

  it('fail-opens to pause when output is unparseable', async () => {
    installMocks({
      submit: vi.fn().mockResolvedValue({ task_id: 'e3' }),
      await: vi.fn().mockResolvedValue({ status: 'completed' }),
      task: vi.fn().mockReturnValue({ status: 'completed', output: 'not json' }),
    });
    const { escalate } = require('../factory/dep-resolver/escalation');
    const r = await escalate(baseArgs);
    expect(r.action).toBe('pause');
    expect(r.reason).toMatch(/escalation_llm_unavailable/);
  });

  it('fail-opens to pause when action is neither retry nor pause', async () => {
    installMocks({
      submit: vi.fn().mockResolvedValue({ task_id: 'e4' }),
      await: vi.fn().mockResolvedValue({ status: 'completed' }),
      task: vi.fn().mockReturnValue({ status: 'completed', output: '{"action":"maybe","reason":"?"}' }),
    });
    const { escalate } = require('../factory/dep-resolver/escalation');
    const r = await escalate(baseArgs);
    expect(r.action).toBe('pause');
  });
});
