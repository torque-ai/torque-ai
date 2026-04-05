import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createResolvers } = require('../plugins/auth/resolvers.js');

function buildResolvers(overrides = {}) {
  const keyManager = {
    validateKey: vi.fn(),
    getKeyById: vi.fn(),
    ...overrides.keyManager,
  };
  const sseAuth = {
    validateSseTicket: vi.fn(),
    consumeLegacyTicket: vi.fn(),
    ...overrides.sseAuth,
  };
  const sessionManager = {
    getSession: vi.fn(),
    ...overrides.sessionManager,
  };

  return {
    keyManager,
    sseAuth,
    sessionManager,
    resolvers: createResolvers({ keyManager, sseAuth, sessionManager }),
  };
}

describe('server/plugins/auth/resolvers', () => {
  it('tries API key resolution first for string credentials and returns the identity', () => {
    const identity = { id: 'api-key-1', type: 'api_key' };
    const { keyManager, sseAuth, sessionManager, resolvers } = buildResolvers();

    keyManager.validateKey.mockReturnValue(identity);

    expect(resolvers.resolve('api-key-1')).toEqual(identity);
    expect(keyManager.validateKey).toHaveBeenCalledWith('api-key-1');
    expect(sseAuth.validateSseTicket).not.toHaveBeenCalled();
    expect(sseAuth.consumeLegacyTicket).not.toHaveBeenCalled();
    expect(sessionManager.getSession).not.toHaveBeenCalled();
  });

  it('falls through to SSE ticket resolution when API key validation returns null', () => {
    const identity = { id: 'stream-user', type: 'api_key' };
    const { keyManager, sseAuth, sessionManager, resolvers } = buildResolvers();

    keyManager.validateKey.mockReturnValue(null);
    sseAuth.validateSseTicket.mockReturnValue({
      valid: true,
      identity,
    });

    expect(resolvers.resolve('sse_tk_123')).toEqual(identity);
    expect(keyManager.validateKey).toHaveBeenCalledWith('sse_tk_123');
    expect(sseAuth.validateSseTicket).toHaveBeenCalledWith('sse_tk_123');
    expect(keyManager.validateKey.mock.invocationCallOrder[0]).toBeLessThan(
      sseAuth.validateSseTicket.mock.invocationCallOrder[0]
    );
    expect(sessionManager.getSession).not.toHaveBeenCalled();
  });

  it('uses validateSseTicket for sse_ticket credentials with the SSE prefix', () => {
    const identity = { id: 'ticket-user', type: 'api_key' };
    const { keyManager, sseAuth, sessionManager, resolvers } = buildResolvers();

    sseAuth.validateSseTicket.mockReturnValue({
      valid: true,
      identity,
    });

    expect(
      resolvers.resolve({ type: 'sse_ticket', value: 'sse_tk_prefixed' })
    ).toEqual(identity);
    expect(sseAuth.validateSseTicket).toHaveBeenCalledWith('sse_tk_prefixed');
    expect(sseAuth.consumeLegacyTicket).not.toHaveBeenCalled();
    expect(keyManager.validateKey).not.toHaveBeenCalled();
    expect(sessionManager.getSession).not.toHaveBeenCalled();
  });

  it('uses sessionManager.getSession for session credentials', () => {
    const identity = { id: 'session-user', type: 'user' };
    const { keyManager, sseAuth, sessionManager, resolvers } = buildResolvers();

    sessionManager.getSession.mockReturnValue({ identity });

    expect(
      resolvers.resolve({ type: 'session', value: 'session-token-1' })
    ).toEqual(identity);
    expect(sessionManager.getSession).toHaveBeenCalledWith('session-token-1');
    expect(keyManager.validateKey).not.toHaveBeenCalled();
    expect(sseAuth.validateSseTicket).not.toHaveBeenCalled();
    expect(sseAuth.consumeLegacyTicket).not.toHaveBeenCalled();
  });

  it('returns null for null and non-object, non-string credentials', () => {
    const { keyManager, sseAuth, sessionManager, resolvers } = buildResolvers();

    expect(resolvers.resolve(null)).toBeNull();
    expect(resolvers.resolve(123)).toBeNull();
    expect(keyManager.validateKey).not.toHaveBeenCalled();
    expect(sseAuth.validateSseTicket).not.toHaveBeenCalled();
    expect(sseAuth.consumeLegacyTicket).not.toHaveBeenCalled();
    expect(sessionManager.getSession).not.toHaveBeenCalled();
  });
});
