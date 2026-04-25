'use strict';

const { setupTestDbOnly, teardownTestDb, rawDb, resetTables } = require('./vitest-setup');
const { createAssetStore } = require('../assets/asset-store');

describe('assetStore', () => {
  let db;
  let store;

  beforeAll(() => {
    setupTestDbOnly('asset-store');
    db = rawDb();
  });

  beforeEach(() => {
    resetTables(['asset_checks', 'asset_materializations', 'asset_dependencies', 'assets']);
    store = createAssetStore({ db });
  });

  afterAll(() => {
    teardownTestDb();
  });

  it('declareAsset is idempotent', () => {
    store.declareAsset({ assetKey: 'code:foo.js', kind: 'code' });
    store.declareAsset({ assetKey: 'code:foo.js', kind: 'code' });

    const row = db.prepare('SELECT COUNT(*) AS n FROM assets WHERE asset_key = ?').get('code:foo.js');
    expect(row.n).toBe(1);
  });

  it('recordMaterialization stores task + hash and is queryable as latest', () => {
    store.declareAsset({ assetKey: 'code:foo.js', kind: 'code' });
    store.recordMaterialization({ assetKey: 'code:foo.js', taskId: 't1', contentHash: 'abc' });
    store.recordMaterialization({ assetKey: 'code:foo.js', taskId: 't2', contentHash: 'def' });

    const latest = store.getLatestMaterialization('code:foo.js');
    expect(latest.task_id).toBe('t2');
    expect(latest.content_hash).toBe('def');
  });

  it('isFresh returns true if materialized after a given timestamp', () => {
    store.declareAsset({ assetKey: 'code:foo.js', kind: 'code' });
    const before = new Date().toISOString();
    store.recordMaterialization({ assetKey: 'code:foo.js', taskId: 't1' });
    expect(store.isFresh('code:foo.js', before)).toBe(true);

    const future = new Date(Date.now() + 60_000).toISOString();
    expect(store.isFresh('code:foo.js', future)).toBe(false);
  });

  it('declareDependency records edges in asset_dependencies', () => {
    store.declareAsset({ assetKey: 'test:foo.test.js', kind: 'test' });
    store.declareAsset({ assetKey: 'code:foo.js', kind: 'code' });
    store.declareDependency('test:foo.test.js', 'code:foo.js');

    const upstream = store.getUpstream('test:foo.test.js');
    expect(upstream).toEqual(['code:foo.js']);
  });

  it('recordCheck stores validation results for an asset', () => {
    store.declareAsset({ assetKey: 'report:lint', kind: 'report' });
    const checkId = store.recordCheck({
      assetKey: 'report:lint',
      checkName: 'lint',
      passed: true,
      severity: 'info',
      taskId: 't1',
    });

    expect(checkId).toMatch(/^chk_/);
    const checks = store.listChecks('report:lint');
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      asset_key: 'report:lint',
      check_name: 'lint',
      passed: 1,
      severity: 'info',
      task_id: 't1',
    });
  });
});
