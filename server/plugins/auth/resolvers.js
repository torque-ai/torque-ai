'use strict';

function createResolvers({ keyManager, sseAuth, sessionManager }) {
  function resolveApiKey(value) {
    return keyManager?.validateKey?.(value) || null;
  }

  function resolveSseTicket(value) {
    if (!value || typeof value !== 'string') {
      return null;
    }

    if (value.startsWith('sse_tk_') && typeof sseAuth?.validateSseTicket === 'function') {
      const result = sseAuth.validateSseTicket(value);
      if (!result || result.valid !== true) {
        return null;
      }

      if (result.identity) {
        return result.identity;
      }

      if (typeof keyManager?.getKeyById === 'function') {
        return keyManager.getKeyById(result.apiKeyId) || null;
      }

      return result.apiKeyId ? { id: result.apiKeyId, type: 'api_key' } : null;
    }

    if (typeof sseAuth?.consumeLegacyTicket === 'function') {
      return sseAuth.consumeLegacyTicket(value);
    }

    return null;
  }

  function resolveSession(value) {
    return sessionManager?.getSession?.(value)?.identity || null;
  }

  return {
    resolve(credential) {
      if (!credential) return null;

      if (typeof credential === 'string') {
        return resolveApiKey(credential)
          || resolveSseTicket(credential)
          || resolveSession(credential);
      }

      if (typeof credential !== 'object') {
        return null;
      }

      switch (credential.type) {
        case 'api_key':
          return resolveApiKey(credential.value);
        case 'sse_ticket':
        case 'legacy_ticket':
        case 'ticket':
          return resolveSseTicket(credential.value);
        case 'session':
        case 'session_token':
          return resolveSession(credential.value);
        default:
          return credential.value
            ? resolveApiKey(credential.value)
              || resolveSseTicket(credential.value)
              || resolveSession(credential.value)
            : null;
      }
    },
  };
}

module.exports = { createResolvers };
