'use strict';

const { requireRole, ROLE_HIERARCHY } = require('../auth/role-guard');

describe('role-guard', () => {
  it('returns false for null identity', () => {
    expect(requireRole(null, 'viewer')).toBe(false);
    expect(requireRole(undefined, 'operator')).toBe(false);
  });

  it('admin passes all role checks', () => {
    const admin = { id: 'a', name: 'Admin', role: 'admin' };
    expect(requireRole(admin, 'viewer')).toBe(true);
    expect(requireRole(admin, 'operator')).toBe(true);
    expect(requireRole(admin, 'manager')).toBe(true);
    expect(requireRole(admin, 'admin')).toBe(true);
  });

  it('manager passes viewer/operator/manager, fails admin', () => {
    const manager = { id: 'm', name: 'Manager', role: 'manager' };
    expect(requireRole(manager, 'viewer')).toBe(true);
    expect(requireRole(manager, 'operator')).toBe(true);
    expect(requireRole(manager, 'manager')).toBe(true);
    expect(requireRole(manager, 'admin')).toBe(false);
  });

  it('operator passes viewer/operator, fails manager/admin', () => {
    const operator = { id: 'o', name: 'Operator', role: 'operator' };
    expect(requireRole(operator, 'viewer')).toBe(true);
    expect(requireRole(operator, 'operator')).toBe(true);
    expect(requireRole(operator, 'manager')).toBe(false);
    expect(requireRole(operator, 'admin')).toBe(false);
  });

  it('viewer passes only viewer, fails operator/manager/admin', () => {
    const viewer = { id: 'v', name: 'Viewer', role: 'viewer' };
    expect(requireRole(viewer, 'viewer')).toBe(true);
    expect(requireRole(viewer, 'operator')).toBe(false);
    expect(requireRole(viewer, 'manager')).toBe(false);
    expect(requireRole(viewer, 'admin')).toBe(false);
  });

  it('unknown role on identity returns false', () => {
    const unknown = { id: 'u', name: 'Unknown', role: 'superuser' };
    expect(requireRole(unknown, 'viewer')).toBe(false);
    expect(requireRole(unknown, 'admin')).toBe(false);
  });

  it('unknown required role returns false', () => {
    const admin = { id: 'a', name: 'Admin', role: 'admin' };
    expect(requireRole(admin, 'superuser')).toBe(false);
    expect(requireRole(admin, 'root')).toBe(false);
  });

  it('exports ROLE_HIERARCHY with correct order', () => {
    expect(ROLE_HIERARCHY).toEqual(['viewer', 'operator', 'manager', 'admin']);
  });
});
