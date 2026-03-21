'use strict';

const { randomUUID } = require('crypto');

describe('elicitation — protocol layer', () => {
  describe('handleClientResponse', () => {
    // We test the protocol logic in isolation by simulating the response routing

    it('resolves pending request when matching response arrives', () => {
      // Simulate the pending request Map
      const pendingRequests = new Map();
      let resolvedValue = null;

      const requestId = `elicit-${randomUUID()}`;
      const promise = new Promise((resolve) => {
        pendingRequests.set(requestId, { resolve, reject: () => {}, timeout: null });
      });
      promise.then(v => { resolvedValue = v; });

      // Simulate response arriving
      const response = { jsonrpc: '2.0', id: requestId, result: { action: 'accept', content: { decision: 'approve' } } };
      const pending = pendingRequests.get(response.id);
      if (pending) {
        clearTimeout(pending.timeout);
        pendingRequests.delete(response.id);
        pending.resolve(response.result);
      }

      return promise.then(() => {
        expect(resolvedValue).toEqual({ action: 'accept', content: { decision: 'approve' } });
        expect(pendingRequests.has(requestId)).toBe(false);
      });
    });

    it('ignores responses with no matching pending request', () => {
      const pendingRequests = new Map();
      const response = { jsonrpc: '2.0', id: 'unknown-id-xyz', result: { action: 'accept' } };
      const pending = pendingRequests.get(response.id);
      expect(pending).toBeUndefined();
      // No crash, no error
    });
  });

  describe('response vs request discrimination', () => {
    it('message with method field is a request', () => {
      const msg = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} };
      expect(typeof msg.method).toBe('string');
    });

    it('message without method field but with result is a response', () => {
      const msg = { jsonrpc: '2.0', id: 'elicit-123', result: { action: 'accept' } };
      expect(msg.method).toBeUndefined();
      expect(msg.result).toBeDefined();
    });

    it('message without method field but with error is an error response', () => {
      const msg = { jsonrpc: '2.0', id: 'elicit-123', error: { code: -1, message: 'fail' } };
      expect(msg.method).toBeUndefined();
      expect(msg.error).toBeDefined();
    });
  });

  describe('capability negotiation', () => {
    it('session with elicitation capability is marked', () => {
      const session = {};
      const params = { capabilities: { elicitation: {} } };
      session.clientCapabilities = params.capabilities || {};
      session.supportsElicitation = Boolean(params.capabilities?.elicitation);
      expect(session.supportsElicitation).toBe(true);
    });

    it('session without elicitation capability is not marked', () => {
      const session = {};
      const params = { capabilities: { tools: {} } };
      session.clientCapabilities = params.capabilities || {};
      session.supportsElicitation = Boolean(params.capabilities?.elicitation);
      expect(session.supportsElicitation).toBe(false);
    });

    it('session with no capabilities defaults to false', () => {
      const session = {};
      const params = {};
      session.clientCapabilities = params.capabilities || {};
      session.supportsElicitation = Boolean(params.capabilities?.elicitation);
      expect(session.supportsElicitation).toBe(false);
    });
  });

  describe('timeout and cleanup', () => {
    it('pending request resolves with cancel on timeout', async () => {
      const pendingRequests = new Map();
      const requestId = `elicit-timeout-test`;

      const promise = new Promise((resolve) => {
        const timeout = setTimeout(() => {
          pendingRequests.delete(requestId);
          resolve({ action: 'cancel' });
        }, 50); // 50ms for testing
        pendingRequests.set(requestId, { resolve, reject: () => {}, timeout });
      });

      const result = await promise;
      expect(result).toEqual({ action: 'cancel' });
      expect(pendingRequests.has(requestId)).toBe(false);
    });

    it('session disconnect resolves pending requests with cancel', () => {
      const pendingRequests = new Map();
      const results = [];

      // Add two pending requests
      const p1 = new Promise(resolve => {
        pendingRequests.set('req-1', { resolve, reject: () => {}, timeout: null });
      });
      p1.then(v => results.push(v));

      const p2 = new Promise(resolve => {
        pendingRequests.set('req-2', { resolve, reject: () => {}, timeout: null });
      });
      p2.then(v => results.push(v));

      // Simulate disconnect cleanup
      for (const [id, pending] of pendingRequests) {
        clearTimeout(pending.timeout);
        pending.resolve({ action: 'cancel' });
      }
      pendingRequests.clear();

      return Promise.all([p1, p2]).then(() => {
        expect(results).toEqual([{ action: 'cancel' }, { action: 'cancel' }]);
        expect(pendingRequests.size).toBe(0);
      });
    });
  });
});

describe('elicitation — elicit() helper', () => {
  it('returns decline when session has no elicitation capability', async () => {
    const { elicit } = require('../mcp/elicitation');
    const session = { supportsElicitation: false, __sessionId: 'test-1' };
    const result = await elicit(session, { message: 'test', requestedSchema: { type: 'object', properties: {}, required: [] } });
    expect(result).toEqual({ action: 'decline' });
  });

  it('returns decline when session is null', async () => {
    const { elicit } = require('../mcp/elicitation');
    const result = await elicit(null, { message: 'test', requestedSchema: { type: 'object', properties: {}, required: [] } });
    expect(result).toEqual({ action: 'decline' });
  });

  it('returns decline when session is undefined', async () => {
    const { elicit } = require('../mcp/elicitation');
    const result = await elicit(undefined, { message: 'test', requestedSchema: { type: 'object', properties: {}, required: [] } });
    expect(result).toEqual({ action: 'decline' });
  });

  it('returns decline when session_id string resolves to no live session', async () => {
    const { elicit } = require('../mcp/elicitation');
    const result = await elicit('nonexistent-session-id', { message: 'test', requestedSchema: { type: 'object', properties: {}, required: [] } });
    expect(result).toEqual({ action: 'decline' });
  });
});

describe('elicitation — session linkage', () => {
  it('session ID is stored as mcp_session_id in metadata', () => {
    const metadata = {};
    const sessionId = 'sess-abc123';
    if (sessionId) {
      metadata.mcp_session_id = sessionId;
    }
    expect(metadata.mcp_session_id).toBe('sess-abc123');
  });

  it('no session means no mcp_session_id', () => {
    const metadata = {};
    const sessionId = null;
    if (sessionId) {
      metadata.mcp_session_id = sessionId;
    }
    expect(metadata.mcp_session_id).toBeUndefined();
  });

  it('mcp_session_id survives JSON round-trip in task metadata', () => {
    const metadata = {
      smart_routing: true,
      mcp_session_id: 'sess-round-trip-test',
    };
    const serialized = JSON.stringify(metadata);
    const deserialized = JSON.parse(serialized);
    expect(deserialized.mcp_session_id).toBe('sess-round-trip-test');
  });

  it('undefined mcp_session_id is omitted from JSON serialization', () => {
    const metadata = {
      smart_routing: true,
      mcp_session_id: undefined,
    };
    const serialized = JSON.stringify(metadata);
    const deserialized = JSON.parse(serialized);
    expect(deserialized.mcp_session_id).toBeUndefined();
    expect('mcp_session_id' in deserialized).toBe(false);
  });
});
