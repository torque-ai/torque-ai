'use strict';

const { createSseAuth, SSE_TICKET_PREFIX } = require('../sse-auth');
const { createResolvers } = require('../resolvers');
const { createAuthMiddleware } = require('../middleware');

function createMiddlewareMocks() {
  return {
    keyManager: {
      hasAnyKeys: vi.fn(() => true),
    },
    userManager: {
      hasAnyUsers: vi.fn(() => false),
    },
    resolvers: {
      resolve: vi.fn(() => null),
    },
  };
}

describe('createSseAuth', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates, consumes, and expires legacy tickets', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-29T12:00:00.000Z'));

    const auth = createSseAuth({ legacyTtlMs: 1000 });
    const identity = { id: 'user-1', role: 'admin', type: 'api_key' };

    const liveTicket = auth.createLegacyTicket(identity);
    expect(liveTicket).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(auth.consumeLegacyTicket(liveTicket)).toEqual(identity);

    const expiredTicket = auth.createLegacyTicket({ id: 'user-2' });
    vi.setSystemTime(new Date('2026-03-29T12:00:01.001Z'));

    expect(auth.consumeLegacyTicket(expiredTicket)).toBeNull();
  });

  it('generates, validates, and expires SSE tickets', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-29T12:00:00.000Z'));

    const auth = createSseAuth({ sseTtlMs: 1000 });

    const validTicket = auth.generateSseTicket('api-key-1');
    expect(validTicket.ticket).toMatch(new RegExp(`^${SSE_TICKET_PREFIX}[0-9a-f]{48}$`));
    expect(auth.validateSseTicket(validTicket.ticket)).toEqual({
      valid: true,
      apiKeyId: 'api-key-1',
    });

    const expiredTicket = auth.generateSseTicket('api-key-2');
    vi.setSystemTime(new Date('2026-03-29T12:00:01.001Z'));

    expect(auth.validateSseTicket(expiredTicket.ticket)).toEqual({
      valid: false,
      reason: 'expired',
    });
  });

  it('enforces single-use tickets', () => {
    const auth = createSseAuth();

    const legacyTicket = auth.createLegacyTicket({ id: 'legacy-user' });
    expect(auth.consumeLegacyTicket(legacyTicket)).toEqual({ id: 'legacy-user' });
    expect(auth.consumeLegacyTicket(legacyTicket)).toBeNull();

    const sseTicket = auth.generateSseTicket('api-key-single').ticket;
    expect(auth.validateSseTicket(sseTicket)).toEqual({
      valid: true,
      apiKeyId: 'api-key-single',
    });
    expect(auth.validateSseTicket(sseTicket)).toEqual({
      valid: false,
      reason: 'unknown',
    });
  });
});

describe('createAuthMiddleware', () => {
  it('extracts credential from Bearer headers', () => {
    const { keyManager, userManager, resolvers } = createMiddlewareMocks();
    const middleware = createAuthMiddleware({ keyManager, userManager, resolvers });

    expect(middleware.extractCredential({
      headers: {
        authorization: 'Bearer bearer-key',
        'x-api-key': 'header-key',
      },
    })).toEqual({ type: 'api_key', value: 'bearer-key' });
  });

  it('extracts credential from x-api-key headers', () => {
    const { keyManager, userManager, resolvers } = createMiddlewareMocks();
    const middleware = createAuthMiddleware({ keyManager, userManager, resolvers });

    expect(middleware.extractCredential({
      headers: {
        'x-api-key': 'header-key',
      },
    })).toEqual({ type: 'api_key', value: 'header-key' });
  });

  it('authenticates with a valid key', () => {
    const identity = { id: 'api-user', role: 'admin', type: 'api_key' };
    const { keyManager, userManager, resolvers } = createMiddlewareMocks();
    resolvers.resolve.mockReturnValue(identity);

    const middleware = createAuthMiddleware({ keyManager, userManager, resolvers });
    const req = {
      headers: {
        authorization: 'Bearer valid-key',
      },
    };

    expect(middleware.authenticate(req)).toEqual(identity);
    expect(resolvers.resolve).toHaveBeenCalledWith({ type: 'api_key', value: 'valid-key' });
  });

  it('throws for an invalid key', () => {
    const { keyManager, userManager, resolvers } = createMiddlewareMocks();
    const middleware = createAuthMiddleware({ keyManager, userManager, resolvers });
    const req = {
      headers: {
        authorization: 'Bearer invalid-key',
      },
    };

    expect(() => middleware.authenticate(req)).toThrow('Unauthorized');
    expect(req._authChallenge).toBe('Bearer realm="Torque API", error="invalid_token"');
  });
});

describe('createResolvers', () => {
  it('resolves API key credentials', () => {
    const keyIdentity = { id: 'api-key-1', role: 'admin', type: 'api_key' };
    const keyManager = {
      validateKey: vi.fn(() => keyIdentity),
    };
    const resolvers = createResolvers({
      keyManager,
      sseAuth: {},
      sessionManager: {},
    });

    expect(resolvers.resolve({ type: 'api_key', value: 'torque_sk_valid' })).toEqual(keyIdentity);
    expect(keyManager.validateKey).toHaveBeenCalledWith('torque_sk_valid');
  });

  it('resolves ticket credentials', () => {
    const ticketIdentity = { id: 'api-key-2', role: 'operator', type: 'api_key' };
    const keyManager = {
      validateKey: vi.fn(() => null),
      getKeyById: vi.fn(() => ticketIdentity),
    };
    const sseAuth = {
      validateSseTicket: vi.fn(() => ({ valid: true, apiKeyId: 'api-key-2' })),
      consumeLegacyTicket: vi.fn(() => null),
    };
    const resolvers = createResolvers({
      keyManager,
      sseAuth,
      sessionManager: {},
    });

    expect(resolvers.resolve({ type: 'sse_ticket', value: `${SSE_TICKET_PREFIX}abc123` })).toEqual(ticketIdentity);
    expect(sseAuth.validateSseTicket).toHaveBeenCalledWith(`${SSE_TICKET_PREFIX}abc123`);
    expect(keyManager.getKeyById).toHaveBeenCalledWith('api-key-2');
  });

  it('returns a session identity and null for unknown credentials', () => {
    const sessionIdentity = { id: 'session-user', role: 'viewer', type: 'user' };
    const keyManager = {
      validateKey: vi.fn(() => null),
    };
    const sseAuth = {
      validateSseTicket: vi.fn(() => ({ valid: false, reason: 'unknown' })),
      consumeLegacyTicket: vi.fn(() => null),
    };
    const sessionManager = {
      getSession: vi.fn((token) => (token === 'session-1' ? { identity: sessionIdentity } : null)),
    };
    const resolvers = createResolvers({ keyManager, sseAuth, sessionManager });

    expect(resolvers.resolve({ type: 'session', value: 'session-1' })).toEqual(sessionIdentity);
    expect(resolvers.resolve({ type: 'unknown', value: 'nope' })).toBeNull();
  });
});
