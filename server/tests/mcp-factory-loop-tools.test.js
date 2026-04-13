'use strict';

const assert = require('assert/strict');

const { CORE_TOOL_NAMES, EXTENDED_TOOL_NAMES } = require('../core-tools');
const mcpProtocol = require('../mcp-protocol');
const { OVERRIDES, getAnnotations } = require('../tool-annotations');
const { TOOLS, handleToolCall, routeMap } = require('../tools');

const FACTORY_LOOP_TOOLS = [
  {
    name: 'start_factory_loop',
    handlerName: 'handleStartFactoryLoop',
    required: ['project'],
    properties: {
      project: { type: 'string' },
    },
  },
  {
    name: 'advance_factory_loop',
    handlerName: 'handleAdvanceFactoryLoop',
    required: ['project'],
    properties: {
      project: { type: 'string' },
    },
  },
  {
    name: 'approve_factory_gate',
    handlerName: 'handleApproveFactoryGate',
    required: ['project', 'stage'],
    properties: {
      project: { type: 'string' },
      stage: { type: 'string', enum: ['PRIORITIZE', 'PLAN', 'VERIFY', 'LEARN'] },
    },
  },
  {
    name: 'factory_loop_status',
    handlerName: 'handleFactoryLoopStatus',
    required: ['project'],
    properties: {
      project: { type: 'string' },
    },
  },
];

describe('factory loop MCP tools', () => {
  it('registers tool defs, tier exposure, route handlers, and explicit annotations', () => {
    for (const expected of FACTORY_LOOP_TOOLS) {
      const tool = TOOLS.find((entry) => entry.name === expected.name);

      assert.ok(tool, `${expected.name} should be present in TOOLS`);
      assert.ok(EXTENDED_TOOL_NAMES.includes(expected.name), `${expected.name} should be in EXTENDED_TOOL_NAMES`);
      assert.ok(!CORE_TOOL_NAMES.includes(expected.name), `${expected.name} should not be in CORE_TOOL_NAMES`);
      assert.ok(routeMap.has(expected.name), `${expected.name} should be routed`);
      assert.equal(routeMap.get(expected.name).name, expected.handlerName);
      assert.ok(Object.prototype.hasOwnProperty.call(OVERRIDES, expected.name), `${expected.name} should have an explicit annotation override`);
      assert.deepStrictEqual(tool.annotations, getAnnotations(expected.name));
      assert.deepStrictEqual(tool.annotations, OVERRIDES[expected.name]);

      assert.ok(tool.inputSchema, `${expected.name} should expose an inputSchema`);
      assert.equal(tool.inputSchema.type, 'object');
      assert.deepStrictEqual(tool.inputSchema.required, expected.required);
      assert.deepStrictEqual(
        Object.keys(tool.inputSchema.properties).sort(),
        Object.keys(expected.properties).sort(),
      );

      for (const [propertyName, propertyExpectation] of Object.entries(expected.properties)) {
        const propertySchema = tool.inputSchema.properties[propertyName];
        assert.ok(propertySchema, `${expected.name}.${propertyName} should be defined`);
        assert.equal(propertySchema.type, propertyExpectation.type);

        if (propertyExpectation.enum) {
          assert.deepStrictEqual(propertySchema.enum, propertyExpectation.enum);
        }
      }
    }
  });

  it('returns the factory loop tools from tools/list after unlock_all_tools', async () => {
    mcpProtocol.init({
      tools: TOOLS,
      coreToolNames: CORE_TOOL_NAMES,
      extendedToolNames: EXTENDED_TOOL_NAMES,
      handleToolCall,
    });

    const session = { toolMode: 'core', authenticated: true };
    const unlockResult = await mcpProtocol.handleRequest({
      method: 'tools/call',
      params: {
        name: 'unlock_all_tools',
        arguments: {},
      },
    }, session);

    assert.equal(session.toolMode, 'full');
    assert.equal(unlockResult.content[0].text, 'All TORQUE tools are now unlocked (Tier 3). The tools list has been refreshed.');

    const listResult = await mcpProtocol.handleRequest({ method: 'tools/list' }, session);
    const toolNames = listResult.tools.map((tool) => tool.name);

    assert.deepStrictEqual(
      FACTORY_LOOP_TOOLS.map((tool) => tool.name).filter((name) => toolNames.includes(name)),
      FACTORY_LOOP_TOOLS.map((tool) => tool.name),
    );
  });
});
