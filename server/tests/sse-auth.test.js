import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  createSseAuth,
  SSE_TICKET_PREFIX,
} = require('../plugins/auth/sse-auth.js');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('server/plugins/auth/sse-auth', () => {
  it('createLegacyTicket and consumeLegacyTicket return the original identity', () => {
    const auth = createSseAuth();
    const identity = { id: 'user-1', role: 'admin', type: 'user' };

    const ticket = auth.createLegacyTicket(identity);

    expect(auth.consumeLegacyTicket(ticket)).toEqual(identity);
  });

  it('consumeLegacyTicket returns null for unknown and expired tickets', async () => {
    const auth = createSseAuth({ legacyTtlMs: 1 });
    const ticket = auth.createLegacyTicket({ id: 'expired-user' });

    expect(auth.consumeLegacyTicket('missing-ticket')).toBeNull();

    await delay(10);

    expect(auth.consumeLegacyTicket(ticket)).toBeNull();
  });

  it('generateSseTicket uses the SSE prefix and throws without an apiKeyId', () => {
    const auth = createSseAuth();
    const result = auth.generateSseTicket('api-key-123');

    expect(result.ticket.startsWith(SSE_TICKET_PREFIX)).toBe(true);
    expect(() => auth.generateSseTicket()).toThrow('apiKeyId is required');
  });

  it('validateSseTicket accepts the first use and rejects the second use', () => {
    const auth = createSseAuth();
    const { ticket } = auth.generateSseTicket('api-key-123');

    expect(auth.validateSseTicket(ticket)).toEqual({
      valid: true,
      apiKeyId: 'api-key-123',
    });
    expect(auth.validateSseTicket(ticket)).toEqual({
      valid: false,
      reason: 'unknown',
    });
  });

  it('enforces the legacy ticket cap', () => {
    const auth = createSseAuth({ maxLegacyTickets: 2 });

    auth.createLegacyTicket({ id: 'user-1' });
    auth.createLegacyTicket({ id: 'user-2' });

    expect(() => auth.createLegacyTicket({ id: 'user-3' })).toThrow(
      'Ticket cap reached (max 2)'
    );
  });
});
