'use strict';

const Database = require('better-sqlite3');
const packRegistry = require('../db/pack-registry');
const { createTables } = require('../db/schema-tables');

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createPack(overrides = {}) {
  return packRegistry.registerPack({
    name: overrides.name || `pack-${Math.random().toString(36).slice(2, 8)}`,
    version: overrides.version || '1.0.0',
    app_type: overrides.app_type || 'wpf',
    author: overrides.author || 'ops',
    signature: overrides.signature || `sig-${Math.random().toString(36).slice(2, 8)}`,
    description: overrides.description,
    metadata: overrides.metadata,
  });
}

describe('db/pack-registry stewardship', () => {
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

  it('transferOwnership updates owner field', () => {
    const created = createPack({ name: 'ownership-pack', signature: 'sig-owner' });

    const updated = packRegistry.transferOwnership(created.id, 'platform-team');

    expect(updated).toMatchObject({
      id: created.id,
      owner: 'platform-team',
    });
    expect(packRegistry.getPack(created.id).owner).toBe('platform-team');
  });

  it('setSunsetDate persists sunset dates for deprecated pack queries', () => {
    const created = createPack({ name: 'sunset-pack', signature: 'sig-sunset' });
    packRegistry.deprecatePack(created.id, 'Scheduled for retirement');

    const updated = packRegistry.setSunsetDate(created.id, '2026-12-31');

    expect(updated).toMatchObject({
      id: created.id,
      sunset_date: '2026-12-31',
    });
    expect(packRegistry.listDeprecatedPacks()).toEqual([
      expect.objectContaining({
        id: created.id,
        sunset_date: '2026-12-31',
        deprecated: true,
      }),
    ]);
  });

  it('getPackVersionHistory tracks registrations across versions of the same pack', () => {
    const first = createPack({
      name: 'history-pack',
      version: '1.0.0',
      author: 'ops-a',
      signature: 'sig-history-1',
    });
    const second = createPack({
      name: 'history-pack',
      version: '2.0.0',
      author: 'ops-b',
      signature: 'sig-history-2',
    });

    expect(packRegistry.getPackVersionHistory(first.id)).toEqual([
      expect.objectContaining({
        version: '1.0.0',
        author: 'ops-a',
        registered_at: expect.any(String),
      }),
    ]);

    expect(packRegistry.getPackVersionHistory(second.id)).toEqual([
      expect.objectContaining({
        version: '1.0.0',
        author: 'ops-a',
        registered_at: expect.any(String),
      }),
      expect.objectContaining({
        version: '2.0.0',
        author: 'ops-b',
        registered_at: expect.any(String),
      }),
    ]);
  });

  it('listDeprecatedPacks includes deprecated packs with their successors', () => {
    const successor = createPack({ name: 'successor-pack', version: '2.0.0', signature: 'sig-successor-pack' });
    const legacy = createPack({
      name: 'legacy-pack',
      version: '1.0.0',
      signature: 'sig-legacy-pack',
      metadata: { channels: ['legacy'] },
    });

    const deprecated = packRegistry.deprecatePack(legacy.id, 'Superseded by successor-pack', successor.id);

    expect(deprecated).toMatchObject({
      id: legacy.id,
      deprecated: true,
      successor_pack_id: successor.id,
      deprecation_reason: 'Superseded by successor-pack',
    });
    expect(packRegistry.listDeprecatedPacks()).toEqual([
      expect.objectContaining({
        id: legacy.id,
        name: 'legacy-pack',
        deprecated: true,
        successor_pack_id: successor.id,
        metadata: { channels: ['legacy'] },
      }),
    ]);
  });
});
