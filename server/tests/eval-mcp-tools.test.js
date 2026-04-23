'use strict';

const assert = require('assert/strict');

const { EXTENDED_TOOL_NAMES } = require('../core-tools');
const { TOOLS, handleToolCall } = require('../tools');

function parseJsonResponse(result) {
  return JSON.parse(result.content[0].text);
}

function uniqueEvalName(prefix) {
  return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe('eval MCP tools', () => {
  it('registers eval tools in the catalog and extended tier', () => {
    const createTool = TOOLS.find((tool) => tool.name === 'create_eval_task');
    const runTool = TOOLS.find((tool) => tool.name === 'run_eval_task');
    const policyTool = TOOLS.find((tool) => tool.name === 'set_approval_policy');

    assert.ok(createTool, 'create_eval_task should be present in TOOLS');
    assert.ok(runTool, 'run_eval_task should be present in TOOLS');
    assert.ok(policyTool, 'set_approval_policy should be present in TOOLS');
    assert.deepStrictEqual(createTool.inputSchema.required, ['name', 'dataset', 'solver', 'scorer']);
    assert.deepStrictEqual(runTool.inputSchema.required, ['name']);
    assert.deepStrictEqual(policyTool.inputSchema.required, ['name', 'rules']);
    assert.ok(EXTENDED_TOOL_NAMES.includes('create_eval_task'));
    assert.ok(EXTENDED_TOOL_NAMES.includes('run_eval_task'));
    assert.ok(EXTENDED_TOOL_NAMES.includes('set_approval_policy'));
  });

  it('creates and runs a simple match-scored eval task', async () => {
    const name = uniqueEvalName('eval-match');
    parseJsonResponse(await handleToolCall('create_eval_task', {
      name,
      dataset: [
        { input: 'a', expected: 'a' },
        { input: 'b', expected: 'b' },
        { input: 'c', expected: 'c' },
      ],
      solver: {
        run_js: 'return { output: sample.input };',
      },
      scorer: {
        kind: 'match',
        target_js: 'sample.expected',
      },
      tags: ['safety'],
    }));

    const result = parseJsonResponse(await handleToolCall('run_eval_task', { name }));

    assert.equal(result.task, name);
    assert.equal(result.samples.length, 3);
    assert.equal(result.aggregate.executed, 3);
    assert.equal(result.aggregate.completed, 3);
    assert.equal(result.aggregate.blocked, 0);
    assert.equal(result.aggregate.mean_value, 1);
    assert.deepStrictEqual(result.samples.map((entry) => entry.score.value), [1, 1, 1]);
  });

  it('replaces approval policy and blocks a solver tool call before dispatch', async () => {
    const name = uniqueEvalName('eval-blocked');
    parseJsonResponse(await handleToolCall('create_eval_task', {
      name,
      dataset: [{ cmd: 'rm -rf /' }],
      solver: {
        run_js: 'return await ctx.callTool("shell", { cmd: sample.cmd });',
      },
      scorer: {
        kind: 'match',
        target_js: '"unused"',
      },
    }));

    parseJsonResponse(await handleToolCall('set_approval_policy', {
      name,
      rules: [{ match: { tool: 'shell' }, action: 'reject' }],
    }));

    const result = parseJsonResponse(await handleToolCall('run_eval_task', { name }));

    assert.equal(result.samples.length, 1);
    assert.equal(result.samples[0].status, 'blocked');
    assert.equal(result.samples[0].approval.action, 'reject');
    assert.equal(result.aggregate.blocked, 1);
    assert.equal(result.aggregate.mean_value, 0);
  });
});
