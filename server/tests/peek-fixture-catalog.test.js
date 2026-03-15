'use strict';

const Database = require('better-sqlite3');
const fixtureCatalog = require('../db/peek-fixture-catalog');
const { createTables } = require('../db/schema-tables');

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('db/peek-fixture-catalog', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createTables(db, createLogger());
    fixtureCatalog.setDb(db);
  });

  afterEach(() => {
    fixtureCatalog.setDb(null);
    db.close();
  });

  it('seeds the default frozen fixtures during table creation', () => {
    expect(fixtureCatalog.listFixtures({ frozen: true }).map((fixture) => fixture.name)).toEqual([
      'electron',
      'qt',
      'win32',
      'winforms',
      'wpf',
    ]);
    expect(fixtureCatalog.seedDefaultFixtures().map((fixture) => fixture.name)).toEqual([
      'wpf',
      'win32',
      'electron',
      'winforms',
      'qt',
    ]);
    expect(fixtureCatalog.listFixtures({ frozen: true })).toHaveLength(5);
  });

  it('registerFixture creates a fixture and returns it', () => {
    const created = fixtureCatalog.registerFixture(
      'custom-wpf',
      'wpf',
      { title: 'Quarter Close', controls: 3 },
    );

    expect(created).toMatchObject({
      name: 'custom-wpf',
      app_type: 'wpf',
      version: 1,
      frozen: false,
      fixture_data: { title: 'Quarter Close', controls: 3 },
      parent_fixture_id: null,
    });
    expect(created.id).toEqual(expect.any(Number));
  });

  it('getFixture retrieves a fixture by id or by name', () => {
    const created = fixtureCatalog.registerFixture(
      'printer-queue',
      'win32',
      { hwnd: 42 },
    );

    expect(fixtureCatalog.getFixture(created.id)).toEqual(created);
    expect(fixtureCatalog.getFixture(created.name)).toEqual(created);
  });

  it('listFixtures filters fixtures by app_type and frozen state', () => {
    fixtureCatalog.registerFixture('ledgerpro', 'wpf', { kind: 'desktop' });
    fixtureCatalog.registerFixture('spooler', 'win32', { kind: 'queue' });

    expect(fixtureCatalog.listFixtures({ frozen: false }).map((fixture) => fixture.name)).toEqual([
      'ledgerpro',
      'spooler',
    ]);
    expect(fixtureCatalog.listFixtures({ app_type: 'wpf', frozen: false }).map((fixture) => fixture.name)).toEqual([
      'ledgerpro',
    ]);
  });

  it('freezeFixture marks a mutable fixture as frozen', () => {
    const created = fixtureCatalog.registerFixture(
      'mutable-fixture',
      'wpf',
      { stage: 'draft' },
    );

    const frozen = fixtureCatalog.freezeFixture(created.id);

    expect(frozen).toMatchObject({
      id: created.id,
      frozen: true,
    });
    expect(fixtureCatalog.getFixture(created.id)?.frozen).toBe(true);
  });

  it('updateFixture rejects changes when the fixture is frozen', () => {
    const created = fixtureCatalog.registerFixture(
      'freezable-fixture',
      'win32',
      { status: 'draft' },
    );

    fixtureCatalog.freezeFixture(created.id);

    expect(() => fixtureCatalog.updateFixture(created.id, { name: 'mutated-fixture' }))
      .toThrow(`Fixture '${created.id}' is frozen and cannot be modified`);
    expect(fixtureCatalog.getFixture(created.id)?.name).toBe('freezable-fixture');
  });
});

module.exports = { createLogger };
