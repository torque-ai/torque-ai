'use strict';

const { createSseAuth, SSE_TICKET_PREFIX } = require('../sse-auth');
const { createResolvers } = require('../resolvers');
const { createAuthMiddleware } = require('../middleware');

describe('createSseAuth', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('supports legacy ticket create, consume, and one-time use', () => {
    const auth = createSseAuth({ maxLegacyTickets: 3, legacyTtlMs: 30000 });
    const identity = { id: 'user-1', name: 'User' };
    const ticket = auth.createLegacyTicket(identity);

    expect(ticket).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(auth.consumeLegacyTicket(ticket)).toEqual(identity);
    expect(auth.consumeLegacyTicket(ticket)).toBeNull();
  });

  it('expires legacy tickets', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-21T12:00:00.000Z'));

    const auth = createSseAuth({ maxLegacyTickets: 3, legacyTtlMs: 1000 });
    const ticket = auth.createLegacyTicket({ id: 'user-2' });

    vi.setSystemTime(new Date(Date.now() + 1001));
    expect(auth.consumeLegacyTicket(ticket)).toBeNull();
  });

  it('enforces legacy ticket cap', () => {
    const auth = createSseAuth({ maxLegacyTickets: 2, legacyTtlMs: 30000 });
    auth.createLegacyTicket({ id: 'user-a' });
    auth.createLegacyTicket({ id: 'user-b' });

    expect(() => auth.createLegacyTicket({ id: 'user-c' }))
      .toThrow('Ticket cap reached (max 2)');
  });

  it('supports SSE ticket generate and validate', () => {
    const auth = createSseAuth({ sseTtlMs: 60000 });
    const result = auth.generateSseTicket('api-key-1');

    expect(result.ticket).toMatch(new RegExp(`^${SSE_TICKET_PREFIX}[0-9a-f]{48}$`));
    expect(auth.validateSseTicket(result.ticket)).toEqual({
      valid: true,
      apiKeyId: 'api-key-1',
    });
  });

  it('computes SSE ticket expiration TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-21T12:00:00.000Z'));

    const auth = createSseAuth({ sseTtlMs: 60000 });
    const result = auth.generateSseTicket('api-key-ttl');

    expect(new Date(result.expiresAt).getTime() - Date.now()).toBe(60000);
  });

  it('expires SSE tickets', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-21T12:00:00.000Z'));

    const auth = createSseAuth({ sseTtlMs: 60000 });
    const result = auth.generateSseTicket('api-key-expire');
    vi.setSystemTime(new Date('2026-03-21T12:01:00.001Z'));

    expect(auth.validateSseTicket(result.ticket)).toEqual({
      valid: false,
      reason: 'expired',
    });
  });

  it('enforces SSE single-use', () => {
    const auth = createSseAuth({ sseTtlMs: 60000 });
    const result = auth.generateSseTicket('api-key-single');

    expect(auth.validateSseTicket(result.ticket)).toEqual({
      valid: true,
      apiKeyId: 'api-key-single',
    });
    expect(auth.validateSseTicket(result.ticket)).toEqual({
      valid: false,
      reason: 'unknown',
    });
  });
});

describe('createResolvers', () => {
  it('resolves api_key, legacy_ticket, and session credentials', () => {
    const keyIdentity = { id: 'api-user', name: 'Api', type: 'api_key' };
    const ticketIdentity = { id: 'ticket-user', name: 'Ticket', type: 'api_key' };
    const sessionIdentity = { id: 'session-user', name: 'Session', type: 'user' };

    const keyManager = { validateKey: vi.fn(() => keyIdentity) };
    const sseAuth = { consumeLegacyTicket: vi.fn(() => ticketIdentity) };
    const sessionManager = { getSession: vi.fn(() => ({ identity: sessionIdentity })) };
    const resolvers = createResolvers({ keyManager, sseAuth, sessionManager });

    expect(resolvers.resolve({ type: 'api_key', value: 'api-1' })).toEqual(keyIdentity);
    expect(keyManager.validateKey).toHaveBeenCalledWith('api-1');

    expect(resolvers.resolve({ type: 'legacy_ticket', value: 'legacy-1' })).toEqual(ticketIdentity);
    expect(sseAuth.consumeLegacyTicket).toHaveBeenCalledWith('legacy-1');

    expect(resolvers.resolve({ type: 'session', value: 'session-1' })).toEqual(sessionIdentity);
    expect(sessionManager.getSession).toHaveBeenCalledWith('session-1');

    expect(resolvers.resolve({ type: 'unknown', value: 'x' })).toBeNull();
    expect(resolvers.resolve(null)).toBeNull();
  });
});

describe('createAuthMiddleware', () => {
  function createMocks() {
    return {
      keyManager: {
        hasAnyKeys: vi.fn(() => true),
      },
      userManager: {
        hasAnyUsers: vi.fn(() => false),
      },
      resolvers: {
        resolve: vi.fn(),
      },
    };
  }

  it('extractCredential uses Bearer header first', () => {
    const { keyManager, userManager, resolvers } = createMocks();
    const middleware = createAuthMiddleware({ keyManager, userManager, resolvers });

    const credential = middleware.extractCredential({
      headers: {
        authorization: 'Bearer from-bearer',
        'x-torque-key': 'from-header',
        cookie: 'torque_session=from-cookie',
      },
    });

    expect(credential).toEqual({ type: 'api_key', value: 'from-bearer' });
  });

  it('extractCredential falls back to X-Torque-Key header', () => {
    const { keyManager, userManager, resolvers } = createMocks();
    const middleware = createAuthMiddleware({ keyManager, userManager, resolvers });

    const credential = middleware.extractCredential({
      headers: {
        'x-torque-key': 'from-header',
        cookie: 'torque_session=from-cookie',
      },
    });

    expect(credential).toEqual({ type: 'api_key', value: 'from-header' });
  });

  it('extractCredential falls back to cookie session id', () => {
    const { keyManager, userManager, resolvers } = createMocks();
    const middleware = createAuthMiddleware({ keyManager, userManager, resolvers });

    const credential = middleware.extractCredential({
      headers: { cookie: 'foo=bar; torque_session=from-cookie' },
    });

    expect(credential).toEqual({ type: 'session', value: 'from-cookie' });
  });

  it('authenticates with a valid key', () => {
    const keyManager = {
      hasAnyKeys: vi.fn(() => true),
      hasAnyUsers: vi.fn(() => false),
    };
    const userManager = {
      hasAnyUsers: vi.fn(() => false),
    };
    const validIdentity = { id: 'api-user', role: 'admin', type: 'api_key' };
    const resolvers = {
      resolve: vi.fn(() => validIdentity),
    };
    const middleware = createAuthMiddleware({ keyManager, userManager, resolvers });

    const identity = middleware.authenticate({
      headers: { authorization: 'Bearer abc' },
    });

    expect(identity).toEqual(validIdentity);
    expect(resolvers.resolve).toHaveBeenCalledWith({ type: 'api_key', value: 'abc' });
  });

  it('returns null for an invalid key', () => {
    const keyManager = {
      hasAnyKeys: vi.fn(() => true),
      hasAnyUsers: vi.fn(() => false),
    };
    const userManager = {
      hasAnyUsers: vi.fn(() => false),
    };
    const resolvers = {
      resolve: vi.fn(() => null),
    };
    const middleware = createAuthMiddleware({ keyManager, userManager, resolvers });

    const identity = middleware.authenticate({
      headers: { authorization: 'Bearer bad-key' },
    });

    expect(identity).toBeNull();
    expect(resolvers.resolve).toHaveBeenCalledWith({ type: 'api_key', value: 'bad-key' });
  });

  it('returns open-mode identity when open mode', () => {
    const keyManager = {
      hasAnyKeys: vi.fn(() => false),
      hasAnyUsers: vi.fn(() => false),
    };
    const userManager = {
      hasAnyUsers: vi.fn(() => false),
    };
    const resolvers = {
      resolve: vi.fn(),
    };
    const middleware = createAuthMiddleware({ keyManager, userManager, resolvers });

    const identity = middleware.authenticate({
      headers: {},
    });

    expect(identity).toEqual({ id: 'open-mode', name: 'Open Mode', role: 'admin', type: 'open' });
    expect(resolvers.resolve).not.toHaveBeenCalled();
  });
});

