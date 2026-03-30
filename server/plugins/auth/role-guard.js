'use strict';

const ROLE_HIERARCHY = ['viewer', 'operator', 'manager', 'admin'];

function requireRole(identity, minRole) {
  if (!identity || typeof identity.role !== 'string') {
    throw new Error('Authentication required');
  }

  const identityLevel = ROLE_HIERARCHY.indexOf(identity.role);
  if (identityLevel === -1) {
    throw new Error(`Unknown role: ${identity.role}`);
  }

  const requiredLevel = ROLE_HIERARCHY.indexOf(minRole);
  if (requiredLevel === -1) {
    throw new Error(`Unknown role: ${minRole}`);
  }

  if (identityLevel < requiredLevel) {
    throw new Error(`Role ${identity.role} does not satisfy required role ${minRole}`);
  }

  return true;
}

function createRoleGuard() {
  return { requireRole };
}

module.exports = { createRoleGuard, ROLE_HIERARCHY, requireRole };
