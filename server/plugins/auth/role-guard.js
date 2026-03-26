'use strict';

const ROLE_HIERARCHY = ['viewer', 'operator', 'manager', 'admin'];

function createRoleGuard() {
  function requireRole(identity, minRole) {
    if (!identity) return false;
    const identityLevel = ROLE_HIERARCHY.indexOf(identity.role);
    const requiredLevel = ROLE_HIERARCHY.indexOf(minRole);
    if (identityLevel === -1 || requiredLevel === -1) return false;
    return identityLevel >= requiredLevel;
  }

  return { requireRole };
}

module.exports = { createRoleGuard, ROLE_HIERARCHY };
