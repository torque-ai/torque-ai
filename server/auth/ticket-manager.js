'use strict';
const crypto = require('crypto');

const _tickets = new Map(); // ticket → { identity, createdAt }
const MAX_TICKETS = 100;
const TICKET_TTL_MS = 30000; // 30 seconds

function createTicket(identity) {
  // Reject if at cap
  if (_tickets.size >= MAX_TICKETS) throw new Error('Ticket cap reached (max 100)');
  const ticket = crypto.randomUUID();
  _tickets.set(ticket, { identity, createdAt: Date.now() });
  return ticket;
}

function consumeTicket(ticket) {
  const entry = _tickets.get(ticket);
  if (!entry) return null;
  _tickets.delete(ticket); // single-use — delete BEFORE checking TTL
  if (Date.now() - entry.createdAt > TICKET_TTL_MS) return null; // expired
  return entry.identity;
}

// Periodic cleanup of expired tickets (call from a timer)
function cleanupExpiredTickets() {
  const now = Date.now();
  for (const [ticket, entry] of _tickets) {
    if (now - entry.createdAt > TICKET_TTL_MS) _tickets.delete(ticket);
  }
}

function getTicketCount() { return _tickets.size; }

// For testing
function _reset() { _tickets.clear(); }

module.exports = { createTicket, consumeTicket, cleanupExpiredTickets, getTicketCount, _reset };
