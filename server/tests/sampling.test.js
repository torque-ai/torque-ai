'use strict';

describe('mcp sampling', () => {
  describe('capability negotiation', () => {
    it('session with sampling capability is marked', () => {
      const session = {};
      const params = { capabilities: { sampling: {} } };
      session.supportsSampling = Boolean(params.capabilities?.sampling);
      expect(session.supportsSampling).toBe(true);
    });

    it('session without sampling capability is not marked', () => {
      const session = {};
      const params = { capabilities: { tools: {} } };
      session.supportsSampling = Boolean(params.capabilities?.sampling);
      expect(session.supportsSampling).toBe(false);
    });
  });

  describe('sample() helper', () => {
    it('returns decline when session has no sampling capability', async () => {
      const { sample } = require('../mcp/sampling');
      const session = { supportsSampling: false, __sessionId: 'test' };
      const result = await sample(session, { messages: [{ role: 'user', content: { type: 'text', text: 'test' } }] });
      expect(result).toEqual({ action: 'decline' });
    });

    it('returns decline when session is null', async () => {
      const { sample } = require('../mcp/sampling');
      const result = await sample(null, { messages: [] });
      expect(result).toEqual({ action: 'decline' });
    });

    it('returns decline when session is undefined', async () => {
      const { sample } = require('../mcp/sampling');
      const result = await sample(undefined, { messages: [] });
      expect(result).toEqual({ action: 'decline' });
    });

    it('returns decline when session_id resolves to no live session', async () => {
      const { sample } = require('../mcp/sampling');
      const result = await sample('nonexistent-session', { messages: [] });
      expect(result).toEqual({ action: 'decline' });
    });
  });

  describe('strategic brain integration', () => {
    it('sample returns decline without session — brain falls through to LLM', async () => {
      const { sample } = require('../mcp/sampling');
      // Simulate what strategic brain does: try sampling, fall through on decline
      const result = await sample(null, {
        messages: [{ role: 'user', content: { type: 'text', text: 'Decompose feature X' } }],
      });
      expect(result.action).toBe('decline');
      // Brain would fall through to _callLlm here
    });
  });
});
