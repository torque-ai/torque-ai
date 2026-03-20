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

// Role check: does identity have the required role?
function requireRole(identity, requiredRole) {
  if (!identity) return false;
  if (identity.role === 'admin') return true; // admin can do everything
  return identity.role === requiredRole;
}

// Check if a specific endpoint requires admin role
const ADMIN_PATTERNS = [
  '/api/auth/keys',
  '/api/providers/configure',
  '/api/v2/providers',
  '/api/v2/hosts',
  // Add more as needed
];

function isAdminEndpoint(url) {
  return ADMIN_PATTERNS.some(p => url.startsWith(p));
}

module.exports = { authenticate, extractCredential, requireRole, isAdminEndpoint, parseCookie };
