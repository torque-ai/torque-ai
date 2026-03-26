'use strict';

function getHeaderValue(headers, name) {
  if (!headers || typeof headers !== 'object') return null;
  if (headers[name] !== undefined) return headers[name];
  const lower = name.toLowerCase();
  if (headers[lower] !== undefined) return headers[lower];
  const title = name.toLowerCase().replace(/(^|-)([a-z])/g, (_, p1, p2) => `${p1}${p2.toUpperCase()}`);
  return headers[title] !== undefined ? headers[title] : null;
}

function parseCookie(cookieHeader, name) {
  if (!cookieHeader || typeof cookieHeader !== 'string') return null;
  const match = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((cookie) => cookie.startsWith(`${name}=`));
  return match ? match.substring(name.length + 1) : null;
}

function createAuthMiddleware({ keyManager, userManager, resolvers }) {
  function extractCredential(req) {
    const headers = req?.headers || {};

    const auth = getHeaderValue(headers, 'authorization');
    if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) {
      return { type: 'api_key', value: auth.slice(7).trim() };
    }

    const legacy = getHeaderValue(headers, 'x-torque-key');
    if (typeof legacy === 'string' && legacy.trim()) {
      return { type: 'api_key', value: legacy };
    }

    const sessionId = parseCookie(headers.cookie, 'torque_session');
    if (sessionId) {
      return { type: 'session', value: sessionId };
    }

    return null;
  }

  function isOpenMode() {
    return !keyManager.hasAnyKeys() && !userManager.hasAnyUsers();
  }

  function authenticate(req) {
    if (isOpenMode()) {
      return { id: 'open-mode', name: 'Open Mode', role: 'admin', type: 'open' };
    }

    const credential = extractCredential(req);
    if (!credential) return null;
    return resolvers.resolve(credential);
  }

  return {
    extractCredential,
    isOpenMode,
    authenticate,
  };
}

module.exports = { createAuthMiddleware };
