'use strict';

const engine = require('../policy-engine/engine');
const profileStore = require('../policy-engine/profile-store');
const shadowEnforcer = require('../policy-engine/shadow-enforcer');

function runEvaluateWithEffects(task, effects) {
  const rules = [{
    id: 'policy-active-effects-test',
    mode: 'warn',
    matcher: {},
    active_effects: effects,
  }];

  vi.spyOn(profileStore, 'resolvePolicyProfile').mockReturnValue({
    id: 'active-effects-profile',
  });
  vi.spyOn(profileStore, 'resolvePoliciesForStage').mockReturnValue(rules);

  // Assign extra props directly onto task so engine.evaluate receives
  // the same object reference (effects mutate task in place)
  task.stage = 'task_submit';
  task.target_type = 'task';
  task.target_id = task.id || 'task-1';
  task.persist = false;

  const result = engine.evaluate(task);

  return { result, task };
}

describe('policy-engine active effects', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(shadowEnforcer, 'isEngineEnabled').mockReturnValue(true);
    vi.spyOn(shadowEnforcer, 'isShadowOnly').mockReturnValue(false);
    vi.spyOn(shadowEnforcer, 'isBlockModeEnabled').mockReturnValue(true);
  });

  it('rewrites description by prepending text', () => {
    const task = { id: 'task-1', task_description: 'original task' };
    const { result, task: modifiedTask } = runEvaluateWithEffects(
      task,
      [{ type: 'rewrite_description', prepend: 'IMPORTANT: Use strict TypeScript.' }],
    );

    expect(modifiedTask.task_description).toBe('IMPORTANT: Use strict TypeScript.\n\noriginal task');
    expect(result.effects).toEqual([{ type: 'rewrite_description', applied: true }]);
  });

  it('rewrites description by appending text', () => {
    const task = { id: 'task-2', task_description: 'original task' };
    const { result, task: modifiedTask } = runEvaluateWithEffects(
      task,
      [{ type: 'rewrite_description', append: 'Run tsc --noEmit before marking complete.' }],
    );

    expect(modifiedTask.task_description).toBe('original task\n\nRun tsc --noEmit before marking complete.');
    expect(result.effects).toEqual([{ type: 'rewrite_description', applied: true }]);
  });

  it('rewrites description by prepending and appending text', () => {
    const task = { id: 'task-3', task_description: 'do the thing' };
    const { task: modifiedTask, result } = runEvaluateWithEffects(
      task,
      [{ type: 'rewrite_description', prepend: 'PREFIX', append: 'SUFFIX' }],
    );

    expect(modifiedTask.task_description).toBe('PREFIX\n\ndo the thing\n\nSUFFIX');
    expect(result.effects).toEqual([{ type: 'rewrite_description', applied: true }]);
  });

  it('stores _compress_output metadata when compress_output is requested', () => {
    const task = { id: 'task-4', output: 'a\nb\nc' };
    const { task: modifiedTask, result } = runEvaluateWithEffects(
      task,
      [{ type: 'compress_output', max_lines: 100, keep: 'last', summary_header: '[Output truncated]' }],
    );

    expect(modifiedTask).toHaveProperty('metadata._compress_output.max_lines', 100);
    expect(modifiedTask).toHaveProperty('metadata._compress_output.keep', 'last');
    expect(modifiedTask).toHaveProperty('metadata._compress_output.summary_header', '[Output truncated]');
    expect(result.effects).toEqual([{
      type: 'compress_output',
      applied: true,
      max_lines: 100,
    }]);
  });

  it('uses default compress_output settings when unset', () => {
    const task = { id: 'task-5', output: 'a\nb\nc' };
    const { task: modifiedTask, result } = runEvaluateWithEffects(
      task,
      [{ type: 'compress_output' }],
    );

    expect(modifiedTask).toHaveProperty('metadata._compress_output.max_lines', 500);
    expect(modifiedTask).toHaveProperty('metadata._compress_output.keep', 'last');
    expect(modifiedTask).toHaveProperty('metadata._compress_output.summary_header', '[Output truncated]');
    expect(result.effects).toEqual([{ type: 'compress_output', applied: true, max_lines: undefined }]);
  });

  it('stores trigger_tool configuration in result.toolTriggers', () => {
    const task = { id: 'task-6', working_directory: '/tmp' };
    const { result } = runEvaluateWithEffects(
      task,
      [{ type: 'trigger_tool', tool_name: 'scan_project', tool_args: { limit: 10 } }],
    );

    expect(result.toolTriggers).toHaveLength(1);
    expect(result.toolTriggers[0]).toEqual({
      tool_name: 'scan_project',
      tool_args: { limit: 10 },
      background: true,
      block_on_failure: false,
    });
    expect(result.effects).toEqual([{ type: 'trigger_tool', tool_name: 'scan_project', applied: true }]);
  });

  it('interpolates task template variables in trigger_tool args', () => {
    const task = { id: 'task-7', working_directory: '/tmp/project' };
    const { result } = runEvaluateWithEffects(
      task,
      [{ type: 'trigger_tool', tool_name: 'scan_project', tool_args: { path: '{{task.working_directory}}' } }],
    );

    expect(result.toolTriggers?.[0].tool_args).toEqual({ path: '/tmp/project' });
  });

  it('defaults trigger_tool background behavior to true', () => {
    const task = { id: 'task-8' };
    const { result } = runEvaluateWithEffects(
      task,
      [{ type: 'trigger_tool', tool_name: 'scan_project' }],
    );

    expect(result.toolTriggers?.[0].background).toBe(true);
  });

  it('applies multiple effects in sequence', () => {
    const task = { id: 'task-9', task_description: 'do the thing', output: 'a\nb\nc\nd' };
    const { task: modifiedTask, result } = runEvaluateWithEffects(
      task,
      [
        { type: 'rewrite_description', prepend: 'STRICT MODE' },
        { type: 'compress_output', max_lines: 1 },
        { type: 'rewrite_description', append: 'END' },
      ],
    );

    expect(modifiedTask.task_description).toBe('STRICT MODE\n\ndo the thing\n\nEND');
    expect(modifiedTask).toHaveProperty('metadata._compress_output.max_lines', 1);
    expect(result.effects).toEqual([
      { type: 'rewrite_description', applied: true },
      { type: 'compress_output', applied: true, max_lines: 1 },
      { type: 'rewrite_description', applied: true },
    ]);
  });

  it('ignores unknown effect types without throwing', () => {
    const task = { id: 'task-10', task_description: 'safe' };
    const evaluate = () => runEvaluateWithEffects(task, [{ type: 'not_a_real_effect' }]);

    expect(evaluate).not.toThrow();
    const { result } = evaluate();
    expect(result.effects).toHaveLength(0);
    expect(task.task_description).toBe('safe');
  });
});
