'use strict';

const crypto = require('crypto');

const SSE_TICKET_PREFIX = 'sse_tk_';
const DEFAULT_MAX_LEGACY_TICKETS = 100;
const DEFAULT_LEGACY_TTL_MS = 30000;
const DEFAULT_SSE_TTL_MS = 60000;

function createSseAuth(options = {}) {
  const maxLegacyTickets = Number.isFinite(options.maxLegacyTickets) ? Math.max(1, Math.floor(options.maxLegacyTickets)) : DEFAULT_MAX_LEGACY_TICKETS;
  const legacyTtlMs = Number.isFinite(options.legacyTtlMs) ? Math.max(1, Math.floor(options.legacyTtlMs)) : DEFAULT_LEGACY_TTL_MS;
  const sseTtlMs = Number.isFinite(options.sseTtlMs) ? Math.max(1, Math.floor(options.sseTtlMs)) : DEFAULT_SSE_TTL_MS;

  const legacyTickets = new Map(); // ticket -> { identity, createdAt }
  const sseTickets = new Map(); // ticket -> { apiKeyId, expiresAtMs }

  function createLegacyTicket(identity) {
    if (legacyTickets.size >= maxLegacyTickets) {
      throw new Error(`Ticket cap reached (max ${maxLegacyTickets})`);
    }
    const ticket = crypto.randomUUID();
    legacyTickets.set(ticket, { identity, createdAt: Date.now() });
    return ticket;
  }

  function consumeLegacyTicket(ticket) {
    const entry = legacyTickets.get(ticket);
    if (!entry) return null;
    legacyTickets.delete(ticket); // single-use

    if (Date.now() - entry.createdAt > legacyTtlMs) return null;
    return entry.identity;
  }

  function generateSseTicket(apiKeyId) {
    if (!apiKeyId || typeof apiKeyId !== 'string') {
      throw new Error('apiKeyId is required');
    }

    cleanup();

    const expiresAtMs = Date.now() + sseTtlMs;
    const ticket = `${SSE_TICKET_PREFIX}${crypto.randomBytes(24).toString('hex')}`;
    sseTickets.set(ticket, { apiKeyId, expiresAtMs });
    return { ticket, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  function validateSseTicket(ticket) {
    if (!ticket || typeof ticket !== 'string') {
      return { valid: false, reason: 'missing' };
    }

    const entry = sseTickets.get(ticket);
    if (!entry) {
      return { valid: false, reason: 'unknown' };
    }

    sseTickets.delete(ticket); // single-use

    if (entry.expiresAtMs <= Date.now()) {
      return { valid: false, reason: 'expired' };
    }

    return { valid: true, apiKeyId: entry.apiKeyId };
  }

  function cleanup() {
    const now = Date.now();
    for (const [ticket, entry] of legacyTickets) {
      if (now - entry.createdAt > legacyTtlMs) {
        legacyTickets.delete(ticket);
      }
    }

    for (const [ticket, entry] of sseTickets) {
      if (entry.expiresAtMs <= now) {
        sseTickets.delete(ticket);
      }
    }
  }

  function getTicketCount() {
    return legacyTickets.size + sseTickets.size;
  }

  return {
    createLegacyTicket,
    consumeLegacyTicket,
    generateSseTicket,
    validateSseTicket,
    cleanup,
    getTicketCount,
  };
}

module.exports = {
  createSseAuth,
  SSE_TICKET_PREFIX,
};
