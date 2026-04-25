'use strict';

const { setupTestDbOnly, teardownTestDb, rawDb, resetTables } = require('./vitest-setup');
const { createAssetStore } = require('../assets/asset-store');
const { createAssetChecks } = require('../assets/asset-checks');

describe('assetChecks', () => {
  let db;
  let store;
  let checks;

  beforeAll(() => {
    setupTestDbOnly('asset-checks');
    db = rawDb();
  });

  beforeEach(() => {
    resetTables(['asset_checks', 'asset_materializations', 'asset_dependencies', 'assets']);
    store = createAssetStore({ db });
    checks = createAssetChecks({ db });
    store.declareAsset({ assetKey: 'code:foo.js', kind: 'code' });
  });

  afterAll(() => {
    teardownTestDb();
  });

  it('record stores a check verdict', () => {
    checks.record({ assetKey: 'code:foo.js', checkName: 'lint', passed: true, severity: 'error' });
    const latest = checks.latestForAsset('code:foo.js');
    expect(latest.lint.passed).toBe(true);
  });

  it('latestForAsset returns most recent of each check_name', () => {
    checks.record({ assetKey: 'code:foo.js', checkName: 'lint', passed: false });
    checks.record({ assetKey: 'code:foo.js', checkName: 'lint', passed: true });
    checks.record({ assetKey: 'code:foo.js', checkName: 'tsc', passed: true });
    const latest = checks.latestForAsset('code:foo.js');
    expect(latest.lint.passed).toBe(true);
    expect(latest.tsc.passed).toBe(true);
  });

  it('isHealthy returns false when any error-severity check fails', () => {
    checks.record({ assetKey: 'code:foo.js', checkName: 'lint', passed: false, severity: 'error' });
    expect(checks.isHealthy('code:foo.js')).toBe(false);

    checks.record({ assetKey: 'code:foo.js', checkName: 'lint', passed: true, severity: 'error' });
    checks.record({ assetKey: 'code:foo.js', checkName: 'cosmetic', passed: false, severity: 'warn' });
    expect(checks.isHealthy('code:foo.js')).toBe(true);
  });
});
