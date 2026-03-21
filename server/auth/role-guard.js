'use strict';

const ROLE_HIERARCHY = ['viewer', 'operator', 'manager', 'admin'];

function requireRole(identity, minRole, projectId = null) {
  if (!identity) return false;
  const identityLevel = ROLE_HIERARCHY.indexOf(identity.role);
  const requiredLevel = ROLE_HIERARCHY.indexOf(minRole);
  if (identityLevel === -1 || requiredLevel === -1) return false;
  return identityLevel >= requiredLevel;
}

module.exports = { requireRole, ROLE_HIERARCHY };
