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

      expect(route.tool).toEqual(expect.stringMatching(/^[a-z_]+$/));
      expect(route.tool.length).toBeGreaterThan(0);

      if (route.mapParams !== undefined) {
        expect(Array.isArray(route.mapParams)).toBe(true);
        expect(route.mapParams.length).toBeGreaterThan(0);
        expect(route.mapParams.every((param) => typeof param === 'string' && param.length > 0)).toBe(true);
      }
    }
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
