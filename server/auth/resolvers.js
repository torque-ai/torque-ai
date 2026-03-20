'use strict';
const keyManager = require('./key-manager');
const ticketManager = require('./ticket-manager');
const sessionManager = require('./session-manager');

function resolve(credential) {
  if (!credential || !credential.type) return null;
  switch (credential.type) {
    case 'api_key': return keyManager.validateKey(credential.value);
    case 'ticket': return ticketManager.consumeTicket(credential.value);
    case 'session': {
      const session = sessionManager.getSession(credential.value);
      return session ? session.identity : null;
    }
    default: return null;
  }
}

module.exports = { resolve };
