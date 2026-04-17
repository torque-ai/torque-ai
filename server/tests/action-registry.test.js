'use strict';

const { createActionRegistry } = require('../dispatch/action-registry');

describe('actionRegistry', () => {
  it('register + getSurface stores schema + handlers', () => {
    const reg = createActionRegistry();
    reg.register({
      surface: 'workflow',
      schema: {
        oneOf: [
          {
            type: 'object',
            required: ['actionName', 'workflowId'],
            properties: {
              actionName: { const: 'cancel' },
              workflowId: { type: 'string' },
            },
          },
          {
            type: 'object',
            required: ['actionName', 'workflowId'],
            properties: {
              actionName: { const: 'resume' },
              workflowId: { type: 'string' },
            },
          },
        ],
      },
      handlers: {
        cancel: async (action) => ({ cancelled: action.workflowId }),
        resume: async (action) => ({ resumed: action.workflowId }),
      },
    });
    const s = reg.getSurface('workflow');
    expect(s.handlers.cancel).toBeInstanceOf(Function);
  });

  it('listActionNames returns all known actionName constants', () => {
    const reg = createActionRegistry();
    reg.register({
      surface: 'workflow',
      schema: {
        oneOf: [
          { properties: { actionName: { const: 'a' } } },
          { properties: { actionName: { const: 'b' } } },
        ],
      },
      handlers: { a: () => {}, b: () => {} },
    });
    expect(reg.listActionNames('workflow').sort()).toEqual(['a', 'b']);
  });

  it('throws on duplicate surface registration', () => {
    const reg = createActionRegistry();
    reg.register({ surface: 'ops', schema: {}, handlers: {} });
    expect(() => reg.register({ surface: 'ops', schema: {}, handlers: {} })).toThrow(/already registered/i);
  });
});
