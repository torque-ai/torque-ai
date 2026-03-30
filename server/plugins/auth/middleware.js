'use strict';

function normalizeHeaderValue(value) {
  if (!Array.isArray(value)) {
    return value;
  }

  return value.find((entry) => typeof entry === 'string' && entry.trim()) || value[0] || null;
}

function getHeaderValue(headers, name) {
  if (!headers || typeof headers !== 'object') return null;

  if (headers[name] !== undefined) {
    return normalizeHeaderValue(headers[name]);
  }

  const lower = name.toLowerCase();
  if (headers[lower] !== undefined) {
    return normalizeHeaderValue(headers[lower]);
  }

  const title = name.toLowerCase().replace(/(^|-)([a-z])/g, (_, p1, p2) => `${p1}${p2.toUpperCase()}`);
  return headers[title] !== undefined ? normalizeHeaderValue(headers[title]) : null;
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
      const value = auth.slice(7).trim();
      if (value) {
        return { type: 'api_key', value };
      }
    }

    const apiKey = getHeaderValue(headers, 'x-api-key');
    if (typeof apiKey === 'string' && apiKey.trim()) {
      return { type: 'api_key', value: apiKey.trim() };
    }

    const legacyApiKey = getHeaderValue(headers, 'x-torque-key');
    if (typeof legacyApiKey === 'string' && legacyApiKey.trim()) {
      return { type: 'api_key', value: legacyApiKey.trim() };
    }

    const sessionId = parseCookie(getHeaderValue(headers, 'cookie'), 'torque_session');
    if (sessionId) {
      return { type: 'session', value: sessionId };
    }

    return null;
  }

  function isOpenMode() {
    return !keyManager?.hasAnyKeys?.() && !userManager?.hasAnyUsers?.();
  }

  function authenticate(req) {
    if (isOpenMode()) {
      return { id: 'open-mode', name: 'Open Mode', role: 'admin', type: 'open' };
    }

    const credential = extractCredential(req);
    const identity = resolvers?.resolve?.(credential) || null;
    if (identity) {
      return identity;
    }

    if (req && typeof req === 'object') {
      req._authChallenge = 'Bearer realm="Torque API", error="invalid_token"';
    }

    const error = new Error('Unauthorized');
    error.statusCode = 401;
    error.code = 'unauthorized';
    throw error;
  }

  return {
    extractCredential,
    isOpenMode,
    authenticate,
  };
}

module.exports = {
  createAuthMiddleware,
  getHeaderValue,
  parseCookie,
};
