'use strict';

const Database = require('better-sqlite3');
const packRegistry = require('../db/pack-registry');
const { createTables } = require('../db/schema/tables');

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('db/pack-registry', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createTables(db, createLogger());
    packRegistry.setDb(db);
  });

  afterEach(() => {
    packRegistry.setDb(null);
    db.close();
  });

  it('registerPack stores signed packs', () => {
    const created = packRegistry.registerPack('ledger-pack', '1.2.3', 'wpf', 'ops', 'sig-123');

    expect(created).toMatchObject({
      name: 'ledger-pack',
      version: '1.2.3',
      app_type: 'wpf',
      author: 'ops',
      signature: 'sig-123',
      signature_verified: false,
      deprecated: false,
    });
    expect(created.id).toEqual(expect.any(Number));
  });

  it('registerPack rejects null, empty, and whitespace signatures', () => {
    expect(() => packRegistry.registerPack('unsigned-pack', '1.0.0', 'win32', 'ops', null))
      .toThrow('Pack registration requires a signature');
    expect(() => packRegistry.registerPack('unsigned-pack', '1.0.0', 'win32', 'ops', ''))
      .toThrow('Pack registration requires a signature');
    expect(() => packRegistry.registerPack({
      name: 'unsigned-pack',
      version: '1.0.0',
      app_type: 'win32',
      author: 'ops',
      signature: '   ',
    })).toThrow('Pack registration requires a signature');
  });

  it('getPack retrieves by id or name', () => {
    const created = packRegistry.registerPack('ops-dashboard', '2.0.0', 'electron', 'platform', 'sig-dashboard');

    expect(packRegistry.getPack(created.id)).toEqual(created);
    expect(packRegistry.getPack('ops-dashboard')).toEqual(created);
    expect(packRegistry.getPackByName('ops-dashboard', '2.0.0')).toEqual(created);
  });

  it('listPacks, queryByAppType, and deprecatePack work together', () => {
    const alpha = packRegistry.registerPack('alpha', '1.0.0', 'wpf', 'ops', 'sig-alpha');
    const beta = packRegistry.registerPack('beta', '1.0.0', 'wpf', 'ops', 'sig-beta');
    const gamma = packRegistry.registerPack('gamma', '1.0.0', 'win32', 'ops', 'sig-gamma');

    const deprecated = packRegistry.deprecatePack(beta.id, 'Replaced by newer pack');

    expect(packRegistry.listPacks().map((pack) => pack.name)).toEqual(['alpha', 'beta', 'gamma']);
    expect(packRegistry.queryByAppType('wpf').map((pack) => pack.name)).toEqual(['alpha', 'beta']);
    expect(packRegistry.listPacks({ deprecated: false }).map((pack) => pack.id)).toEqual([alpha.id, gamma.id]);
    expect(packRegistry.listPacks({ deprecated: true })).toEqual([
      expect.objectContaining({
        id: beta.id,
        name: 'beta',
        deprecated: true,
        deprecation_reason: 'Replaced by newer pack',
      }),
    ]);
    expect(deprecated).toMatchObject({
      id: beta.id,
      deprecated: true,
      deprecation_reason: 'Replaced by newer pack',
    });
  });

  it('signature enforcement carries through list and app type queries', () => {
    const created = packRegistry.registerPack({
      name: 'signed-pack',
      version: '1.0.0',
      app_type: 'wpf',
      author: 'ops',
      signature: 'sig-signed',
      metadata: { channels: ['stable'] },
    });

    expect(created.signature).toBe('sig-signed');
    expect(created.metadata).toEqual({ channels: ['stable'] });
    expect(packRegistry.listPacks().every((pack) => typeof pack.signature === 'string' && pack.signature.length > 0)).toBe(true);
    expect(packRegistry.queryByAppType('wpf')).toEqual([created]);
  });
});

module.exports = {
  createLogger,
};
