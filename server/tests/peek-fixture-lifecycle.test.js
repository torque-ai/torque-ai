'use strict';

const Database = require('better-sqlite3');
const fixtureCatalog = require('../db/peek/fixture-catalog');
const { createTables } = require('../db/schema-tables');
const {
  FIXTURE_CATALOG,
  QT_FIXTURE,
  WINFORMS_FIXTURE,
} = require('../contracts/peek-fixtures');

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('peek fixture lifecycle', () => {
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

  it('increments the fixture version when updateFixture changes a mutable fixture', () => {
    const created = fixtureCatalog.registerFixture({
      app_type: 'winforms',
      name: 'warehouse-base',
      fixture_data: {
        status: 'draft',
      },
    });

    const updated = fixtureCatalog.updateFixture(created.id, {
      fixture_data: {
        status: 'ready',
      },
    });

    expect(updated).toMatchObject({
      id: created.id,
      version: 2,
      fixture_data: {
        status: 'ready',
      },
    });
    expect(fixtureCatalog.getFixture(created.id)?.version).toBe(2);
  });

  it('rejects updates after a fixture is frozen', () => {
    const created = fixtureCatalog.registerFixture({
      app_type: 'qt',
      name: 'signal-monitor-draft',
      fixture_data: {
        mode: 'draft',
      },
    });

    fixtureCatalog.freezeFixture(created.id);

    expect(() => fixtureCatalog.updateFixture(created.id, {
      fixture_data: {
        mode: 'published',
      },
    })).toThrow(`Fixture '${created.id}' is frozen and cannot be modified`);
    expect(fixtureCatalog.getFixture(created.id)).toMatchObject({
      id: created.id,
      version: 1,
      frozen: true,
      fixture_data: {
        mode: 'draft',
      },
    });
  });

  it('getFixture deep-merges parent and child data with child precedence', () => {
    const parent = fixtureCatalog.registerFixture({
      app_type: 'winforms',
      name: 'warehouse-base',
      fixture_data: {
        title: 'Inventory Tracker - Warehouse A',
        settings: {
          theme: 'light',
          panes: ['summary', 'stock'],
          nested: {
            refresh: 30,
            dense: false,
          },
        },
        columns: ['sku', 'description', 'on_hand'],
        flags: {
          archived: false,
        },
      },
    });
    const child = fixtureCatalog.registerFixture({
      app_type: 'winforms',
      name: 'warehouse-alerts',
      parent_fixture_id: parent.id,
      fixture_data: {
        settings: {
          panes: ['alerts'],
          nested: {
            dense: true,
          },
        },
        columns: ['sku'],
        flags: {
          archived: true,
        },
        status: 'attention',
      },
    });

    expect(fixtureCatalog.getFixture(child.id)).toMatchObject({
      id: child.id,
      fixture_data: {
        title: 'Inventory Tracker - Warehouse A',
        settings: {
          theme: 'light',
          panes: ['alerts'],
          nested: {
            refresh: 30,
            dense: true,
          },
        },
        columns: ['sku'],
        flags: {
          archived: true,
        },
        status: 'attention',
      },
    });
  });

  it('deepMerge replaces arrays instead of concatenating them', () => {
    const merged = fixtureCatalog.deepMerge(
      {
        nodes: ['window', 'grid'],
        metadata: {
          tags: ['alpha', 'beta'],
          density: 'comfortable',
        },
      },
      {
        nodes: ['toolbar'],
        metadata: {
          tags: ['gamma'],
        },
      },
    );

    expect(merged).toEqual({
      nodes: ['toolbar'],
      metadata: {
        tags: ['gamma'],
        density: 'comfortable',
      },
    });
  });

  it('seeds all five default fixtures, including WinForms and Qt', () => {
    expect(Object.keys(FIXTURE_CATALOG)).toEqual(['wpf', 'win32', 'electron', 'winforms', 'qt']);
    expect(WINFORMS_FIXTURE.component_model).toBeTruthy();
    expect(QT_FIXTURE.qt_object_tree).toBeTruthy();

    expect(fixtureCatalog.seedDefaultFixtures().map((fixture) => fixture.name)).toEqual([
      'wpf',
      'win32',
      'electron',
      'winforms',
      'qt',
    ]);
    expect(fixtureCatalog.listFixtures({ frozen: true }).map((fixture) => fixture.name)).toEqual([
      'electron',
      'qt',
      'win32',
      'winforms',
      'wpf',
    ]);
    expect(fixtureCatalog.listFixtures({ frozen: true })).toHaveLength(5);
    expect(fixtureCatalog.getFixtureByName('winforms')).toMatchObject({
      app_type: 'winforms',
      frozen: true,
    });
    expect(fixtureCatalog.getFixtureByName('qt')).toMatchObject({
      app_type: 'qt',
      frozen: true,
    });
  });
});
