'use strict';

const crypto = require('crypto');

const TICKET_PREFIX = 'sse_tk_';
const TICKET_TTL_MS = 60 * 1000;
const _tickets = new Map(); // ticket -> { apiKeyId, expiresAtMs }

function generateTicket(apiKeyId) {
  if (!apiKeyId || typeof apiKeyId !== 'string') {
    throw new Error('apiKeyId is required');
  }

  cleanupExpired();

  const expiresAtMs = Date.now() + TICKET_TTL_MS;
  const ticket = `${TICKET_PREFIX}${crypto.randomBytes(24).toString('hex')}`;

  _tickets.set(ticket, { apiKeyId, expiresAtMs });

  return {
    ticket,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

function validateTicket(ticket) {
  if (!ticket || typeof ticket !== 'string') {
    return { valid: false, reason: 'missing' };
  }

  const entry = _tickets.get(ticket);
  if (!entry) {
    return { valid: false, reason: 'unknown' };
  }

  _tickets.delete(ticket);

  if (entry.expiresAtMs <= Date.now()) {
    return { valid: false, reason: 'expired' };
  }

  return { valid: true, apiKeyId: entry.apiKeyId };
}

function cleanupExpired() {
  const now = Date.now();
  for (const [ticket, entry] of _tickets.entries()) {
    if (entry.expiresAtMs <= now) {
      _tickets.delete(ticket);
    }
  }
}

function _resetForTests() {
  _tickets.clear();
}

function _getTicketCount() {
  return _tickets.size;
}

module.exports = {
  TICKET_PREFIX,
  TICKET_TTL_MS,
  generateTicket,
  validateTicket,
  cleanupExpired,
  _resetForTests,
  _getTicketCount,
};
