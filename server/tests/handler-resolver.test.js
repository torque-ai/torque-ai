'use strict';

const { describe, it, expect } = require('vitest');
const { resolveHandler } = require('../control/handler-resolver');

describe('resolveHandler', () => {
  it('parses "state.<path>" as a query', () => {
    const h = resolveHandler('state.user.name');
    expect(h.kind).toBe('query');
    expect(h.statePath).toBe('user.name');
  });

  it('parses "state.<path>.<reducer>" as a write with reducer', () => {
    const h = resolveHandler('state.roles.append');
    expect(h.kind).toBe('write');
    expect(h.statePath).toBe('roles');
    expect(h.reducer).toBe('append');
  });

  it('write reducers must be one of the known set', () => {
    const ok = resolveHandler('state.x.replace');
    expect(ok.reducer).toBe('replace');

    const bad = resolveHandler('state.x.bogus');
    expect(bad).toBeNull();
  });

  it('returns null for malformed handler strings', () => {
    expect(resolveHandler('')).toBeNull();
    expect(resolveHandler('not-a-handler')).toBeNull();
    expect(resolveHandler('state.')).toBeNull();
  });
});
