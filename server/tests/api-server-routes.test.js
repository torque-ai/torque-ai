import { describe, expect, it } from 'vitest';

const { FACTORY_V2_ROUTES } = require('../api/routes/factory-routes');
const { PII_SCAN_ROUTE } = require('../api/routes/special-routes');

const VALID_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);

describe('api/routes/factory-routes', () => {
  it('exports a well-formed factory v2 route definition array', () => {
    expect(Array.isArray(FACTORY_V2_ROUTES)).toBe(true);
    expect(FACTORY_V2_ROUTES.length).toBeGreaterThanOrEqual(30);

    for (const route of FACTORY_V2_ROUTES) {
      expect(VALID_METHODS.has(route.method)).toBe(true);

      if (typeof route.path === 'string') {
        expect(route.path.startsWith('/api/v2/factory/')).toBe(true);
      } else {
        expect(route.path).toBeInstanceOf(RegExp);
        expect(route.path.source).toContain('factory');
      }

      // Routes either go through the MCP tool dispatcher (route.tool) or use a
      // custom handler bound directly (route.handler / route.handlerName). They
      // must not have neither.
      const hasTool = typeof route.tool === 'string' && /^[a-z_]+$/.test(route.tool);
      const hasHandler = typeof route.handler === 'function'
        || (typeof route.handlerName === 'string' && route.handlerName.length > 0);
      expect(hasTool || hasHandler).toBe(true);

      if (route.mapParams !== undefined) {
        expect(Array.isArray(route.mapParams)).toBe(true);
        expect(route.mapParams.length).toBeGreaterThan(0);
        expect(route.mapParams.every((param) => typeof param === 'string' && param.length > 0)).toBe(true);
      }
    }
  });

  it('maps resume_project request bodies so operator pause clearing is explicit', () => {
    const resumeRoute = FACTORY_V2_ROUTES.find((route) => (
      route.method === 'POST'
      && route.tool === 'resume_project'
      && route.path instanceof RegExp
      && route.path.test('/api/v2/factory/projects/project-1/resume')
    ));

    expect(resumeRoute).toMatchObject({
      mapParams: ['project'],
      mapBody: true,
    });
  });

  it('exposes automation readiness planning and scheduler arming routes', () => {
    const globalPlanRoute = FACTORY_V2_ROUTES.find((route) => (
      route.method === 'GET'
      && route.path === '/api/v2/factory/automation-plan'
      && route.tool === 'factory_automation_plan'
    ));
    const projectPlanRoute = FACTORY_V2_ROUTES.find((route) => (
      route.method === 'GET'
      && route.tool === 'factory_automation_plan'
      && route.path instanceof RegExp
      && route.path.test('/api/v2/factory/projects/project-1/automation-plan')
    ));
    const armTickRoute = FACTORY_V2_ROUTES.find((route) => (
      route.method === 'POST'
      && route.tool === 'arm_factory_tick'
      && route.path instanceof RegExp
      && route.path.test('/api/v2/factory/projects/project-1/tick/arm')
    ));
    const globalApplyRoute = FACTORY_V2_ROUTES.find((route) => (
      route.method === 'POST'
      && route.path === '/api/v2/factory/automation-plan/apply'
      && route.tool === 'apply_factory_automation_plan'
    ));
    const projectApplyRoute = FACTORY_V2_ROUTES.find((route) => (
      route.method === 'POST'
      && route.tool === 'apply_factory_automation_plan'
      && route.path instanceof RegExp
      && route.path.test('/api/v2/factory/projects/project-1/automation-plan/apply')
    ));

    expect(globalPlanRoute).toMatchObject({
      mapQuery: true,
    });
    expect(projectPlanRoute).toMatchObject({
      mapParams: ['project'],
      mapQuery: true,
    });
    expect(armTickRoute).toMatchObject({
      mapParams: ['project'],
      mapBody: true,
    });
    expect(globalApplyRoute).toMatchObject({
      mapBody: true,
    });
    expect(projectApplyRoute).toMatchObject({
      mapParams: ['project'],
      mapBody: true,
    });
  });
});

describe('api/routes/special-routes', () => {
  it('exports the pii scan route with the expected handler binding', () => {
    expect(PII_SCAN_ROUTE).toMatchObject({
      method: 'POST',
      path: '/api/pii-scan',
      handlerName: 'handlePiiScan',
    });
  });
});

describe('api/routes/index', () => {
  it('re-exports route symbols by identity', () => {
    const barrel = require('../api/routes/index');
    const factoryRoutesModule = require('../api/routes/factory-routes');
    const specialRoutesModule = require('../api/routes/special-routes');

    expect(barrel.FACTORY_V2_ROUTES).toBe(factoryRoutesModule.FACTORY_V2_ROUTES);
    expect(barrel.PII_SCAN_ROUTE).toBe(specialRoutesModule.PII_SCAN_ROUTE);
  });
});
