'use strict';
const keyManager = require('./key-manager');
const { resolve } = require('./resolvers');

// Parse a specific cookie from the Cookie header
function parseCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const match = cookieHeader.split(';').find(c => c.trim().startsWith(name + '='));
  return match ? match.split('=')[1]?.trim() : null;
}

// Extract credential from an HTTP request
function extractCredential(req) {
  // 1. Authorization: Bearer <key>
  const auth = req.headers?.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    return { type: 'api_key', value: auth.slice(7).trim() };
  }
  // 2. Legacy X-Torque-Key header (deprecated)
  const legacy = req.headers?.['x-torque-key'];
  if (legacy) {
    return { type: 'api_key', value: legacy };
  }
  // 3. Cookie session
  const sessionId = parseCookie(req.headers?.cookie, 'torque_session');
  if (sessionId) {
    return { type: 'session', value: sessionId };
  }
  return null;
}

// Main auth function: returns identity or null
function authenticate(req) {
  // Open mode: no keys = everyone is admin
  if (!keyManager.hasAnyKeys()) {
    return { id: 'open-mode', name: 'Open Mode', role: 'admin' };
  }
  const credential = extractCredential(req);
  if (!credential) return null;
  return resolve(credential);
}

module.exports = { authenticate, extractCredential, parseCookie };
