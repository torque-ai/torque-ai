'use strict';
const keyManager = require('./key-manager');
const userManager = require('./user-manager');
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

// Check if the server is in open mode (no keys AND no users)
function isOpenMode() {
  try {
    return !keyManager.hasAnyKeys() && !userManager.hasAnyUsers();
  } catch {
    return false; // If either module isn't initialized, auth is required
  }
}

// Main auth function: returns identity or null
function authenticate(req) {
  // Open mode: no keys AND no users = everyone is admin
  if (isOpenMode()) {
    return { id: 'open-mode', name: 'Open Mode', role: 'admin', type: 'open' };
  }
  const credential = extractCredential(req);
  if (!credential) return null;
  return resolve(credential);
}

module.exports = { authenticate, extractCredential, parseCookie, isOpenMode };
