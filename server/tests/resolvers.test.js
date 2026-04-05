import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createResolvers } = require('../plugins/auth/resolvers.js');

describe('server/plugins/auth/resolvers', () => {
  it('resolve returns null for falsy credentials', () => {
    const { resolve } = createResolvers({});

    expect(resolve(null)).toBeNull();
    expect(resolve(undefined)).toBeNull();
    expect(resolve('')).toBeNull();
  });

  it('resolve with string credential tries apiKey first', () => {
    const identity = { id: 'key-1', type: 'api_key' };
    const calls = [];
    const { resolve } = createResolvers({
      keyManager: {
        validateKey(value) {
          calls.push(['validateKey', value]);
          return value === 'my-api-key' ? identity : null;
        },
      },
    });

    expect(resolve('my-api-key')).toEqual(identity);
    expect(calls).toEqual([['validateKey', 'my-api-key']]);
  });

  it('resolve with string credential falls through to sseTicket', () => {
    const key = { id: 'ak-1', name: 'Test' };
    const calls = [];
    const { resolve } = createResolvers({
      keyManager: {
        validateKey(value) {
          calls.push(['validateKey', value]);
          return null;
        },
        getKeyById(id) {
          calls.push(['getKeyById', id]);
          return id === 'ak-1' ? key : null;
        },
      },
      sseAuth: {
        validateSseTicket(value) {
          calls.push(['validateSseTicket', value]);
          return value === 'sse_tk_abc123'
            ? { valid: true, apiKeyId: 'ak-1' }
            : null;
        },
      },
    });

    expect(resolve('sse_tk_abc123')).toEqual(key);
    expect(calls).toEqual([
      ['validateKey', 'sse_tk_abc123'],
      ['validateSseTicket', 'sse_tk_abc123'],
      ['getKeyById', 'ak-1'],
    ]);
  });

  it('resolve with string credential falls through to session', () => {
    const identity = { id: 'sess-1' };
    const calls = [];
    const { resolve } = createResolvers({
      keyManager: {
        validateKey(value) {
          calls.push(['validateKey', value]);
          return null;
        },
      },
      sseAuth: {
        validateSseTicket(value) {
          calls.push(['validateSseTicket', value]);
          return null;
        },
        consumeLegacyTicket(value) {
          calls.push(['consumeLegacyTicket', value]);
          return null;
        },
      },
      sessionManager: {
        getSession(value) {
          calls.push(['getSession', value]);
          return value === 'sess-token' ? { identity } : null;
        },
      },
    });

    expect(resolve('sess-token')).toEqual(identity);
    expect(calls).toEqual([
      ['validateKey', 'sess-token'],
      ['consumeLegacyTicket', 'sess-token'],
      ['getSession', 'sess-token'],
    ]);
  });

  it('resolve with typed object credential routes by type', () => {
    const calls = [];
    const { resolve } = createResolvers({
      keyManager: {
        validateKey(value) {
          calls.push(['validateKey', value]);
          return { id: `api:${value}` };
        },
      },
      sseAuth: {
        validateSseTicket(value) {
          calls.push(['validateSseTicket', value]);
          return { valid: true, identity: { id: `sse:${value}` } };
        },
        consumeLegacyTicket(value) {
          calls.push(['consumeLegacyTicket', value]);
          return null;
        },
      },
      sessionManager: {
        getSession(value) {
          calls.push(['getSession', value]);
          return { identity: { id: `session:${value}` } };
        },
      },
    });

    expect(resolve({ type: 'api_key', value: 'k1' })).toEqual({ id: 'api:k1' });
    expect(calls).toEqual([['validateKey', 'k1']]);

    calls.length = 0;
    expect(resolve({ type: 'sse_ticket', value: 'sse_tk_x' })).toEqual({ id: 'sse:sse_tk_x' });
    expect(calls).toEqual([['validateSseTicket', 'sse_tk_x']]);

    calls.length = 0;
    expect(resolve({ type: 'session', value: 's1' })).toEqual({ id: 'session:s1' });
    expect(calls).toEqual([['getSession', 's1']]);
  });
});
