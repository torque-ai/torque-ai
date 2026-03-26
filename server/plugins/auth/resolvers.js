'use strict';

function createResolvers({ keyManager, sseAuth, sessionManager }) {
  return {
    resolve(credential) {
      if (!credential || !credential.type) return null;

      switch (credential.type) {
        case 'api_key':
          return keyManager.validateKey(credential.value);
        case 'legacy_ticket':
          return sseAuth.consumeLegacyTicket(credential.value);
        case 'session':
          return sessionManager.getSession(credential.value)?.identity;
        default:
          return null;
      }
    },
  };
}

module.exports = { createResolvers };
