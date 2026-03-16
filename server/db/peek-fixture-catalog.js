'use strict';

const crypto = require('crypto');
const {
  ELECTRON_FIXTURE,
  QT_FIXTURE,
  WIN32_FIXTURE,
  WINFORMS_FIXTURE,
  WPF_FIXTURE,
} = require('../contracts/peek-fixtures');

let db;

const DEFAULT_FIXTURES = Object.freeze([
  Object.freeze({
    name: 'wpf',
    app_type: 'wpf',
    fixture_data: WPF_FIXTURE,
  }),
  Object.freeze({
    name: 'win32',
    app_type: 'win32',
    fixture_data: WIN32_FIXTURE,
  }),
  Object.freeze({
    name: 'electron',
    app_type: 'electron_webview',
    fixture_data: ELECTRON_FIXTURE,
  }),
  Object.freeze({
    name: 'winforms',
    app_type: 'winforms',
    fixture_data: WINFORMS_FIXTURE,
  }),
  Object.freeze({
    name: 'qt',
    app_type: 'qt',
    fixture_data: QT_FIXTURE,
  }),
]);

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function cloneValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneValue(entry));
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)]),
    );
  }

  return value;
}

function setDb(dbInstance) {
  db = dbInstance;
}

function requireDb() {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('peek fixture catalog database is not set');
  }
}

function computeChecksum(fixtureData) {
  const json = typeof fixtureData === 'string' ? fixtureData : JSON.stringify(fixtureData);
  return crypto.createHash('sha256').update(json).digest('hex');
}

function safeJsonParse(value, defaultValue) {
  if (value === null || value === undefined) return defaultValue;
  try {
    return JSON.parse(value);
  } catch {
    return defaultValue;
  }
}

function mapFixtureRow(row) {
  if (!row) return null;

  return {
    ...row,
    frozen: !!row.frozen,
    fixture_data: safeJsonParse(row.fixture_data, null),
  };
}

function hasCatalogTable() {
  if (!db || typeof db.prepare !== 'function') return false;

  try {
    return !!db.prepare(`
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table' AND name = 'peek_fixture_catalog'
    `).get();
  } catch {
    return false;
  }
}

function deepMerge(base, overlay) {
  if (overlay === undefined) {
    return cloneValue(base);
  }

  if (Array.isArray(overlay)) {
    return overlay.map((entry) => cloneValue(entry));
  }

  if (isPlainObject(base) && isPlainObject(overlay)) {
    const merged = cloneValue(base);
    for (const [key, value] of Object.entries(overlay)) {
      merged[key] = key in base ? deepMerge(base[key], value) : cloneValue(value);
    }
    return merged;
  }

  if (isPlainObject(overlay)) {
    return cloneValue(overlay);
  }

  return overlay;
}

function normalizeFixtureData(fixtureData) {
  if (fixtureData === undefined) {
    throw new Error('fixtureData is required');
  }

  if (typeof fixtureData === 'string') {
    const parsed = safeJsonParse(fixtureData, undefined);
    if (parsed === undefined) {
      throw new Error('fixtureData must be valid JSON when provided as a string');
    }

    return {
      json: fixtureData,
      value: parsed,
    };
  }

  return {
    json: JSON.stringify(fixtureData),
    value: cloneValue(fixtureData),
  };
}

function normalizeRegisterInput(nameOrOptions, appType, fixtureData) {
  if (isPlainObject(nameOrOptions)) {
    return {
      name: nameOrOptions.name,
      app_type: nameOrOptions.app_type || nameOrOptions.appType,
      fixture_data: nameOrOptions.fixture_data !== undefined
        ? nameOrOptions.fixture_data
        : nameOrOptions.fixtureData,
      frozen: nameOrOptions.frozen === undefined ? false : !!nameOrOptions.frozen,
      parent_fixture_id: nameOrOptions.parent_fixture_id ?? nameOrOptions.parentFixtureId ?? null,
      version: nameOrOptions.version === undefined ? 1 : nameOrOptions.version,
    };
  }

  return {
    name: nameOrOptions,
    app_type: appType,
    fixture_data: fixtureData,
    frozen: false,
    parent_fixture_id: null,
    version: 1,
  };
}

function normalizeUpdateInput(updates = {}) {
  return {
    name: updates.name,
    app_type: updates.app_type !== undefined ? updates.app_type : updates.appType,
    fixture_data: updates.fixture_data !== undefined ? updates.fixture_data : updates.fixtureData,
    frozen: updates.frozen,
    parent_fixture_id: updates.parent_fixture_id !== undefined
      ? updates.parent_fixture_id
      : updates.parentFixtureId,
    version: updates.version,
  };
}

function selectFixtureByField(field, value) {
  const row = db.prepare(`SELECT * FROM peek_fixture_catalog WHERE ${field} = ?`).get(value);
  return mapFixtureRow(row);
}

function getFixtureRecord(nameOrId) {
  requireDb();

  if (nameOrId === null || nameOrId === undefined) {
    return null;
  }

  if (typeof nameOrId === 'number' && Number.isInteger(nameOrId)) {
    return selectFixtureByField('id', nameOrId);
  }

  if (typeof nameOrId === 'string') {
    const trimmed = nameOrId.trim();
    if (/^\d+$/.test(trimmed)) {
      const byId = selectFixtureByField('id', Number(trimmed));
      if (byId) return byId;
    }

    return selectFixtureByField('name', trimmed);
  }

  return null;
}

function resolveInheritedFixtureData(fixture, depth = 0, visited = new Set()) {
  if (!fixture) return null;

  if (!fixture.parent_fixture_id) {
    return cloneValue(fixture.fixture_data);
  }

  if (depth >= 3) {
    throw new Error(`Fixture inheritance depth limit exceeded at '${fixture.id}'`);
  }

  if (visited.has(fixture.id)) {
    throw new Error(`Fixture inheritance cycle detected at '${fixture.id}'`);
  }

  visited.add(fixture.id);
  try {
    const parent = getFixtureRecord(fixture.parent_fixture_id);
    if (!parent) {
      return cloneValue(fixture.fixture_data);
    }

    return deepMerge(
      resolveInheritedFixtureData(parent, depth + 1, visited),
      fixture.fixture_data,
    );
  } finally {
    visited.delete(fixture.id);
  }
}

function getNextVersion(version) {
  const numericVersion = Number(version);
  return Number.isInteger(numericVersion) && numericVersion >= 0
    ? numericVersion + 1
    : 1;
}

function registerFixture(nameOrOptions, appType, fixtureData) {
  requireDb();

  const normalized = normalizeRegisterInput(nameOrOptions, appType, fixtureData);
  const name = typeof normalized.name === 'string' ? normalized.name.trim() : '';
  const appTypeValue = typeof normalized.app_type === 'string' ? normalized.app_type.trim() : '';

  if (!name) {
    throw new Error('Fixture name is required');
  }

  if (!appTypeValue) {
    throw new Error('Fixture appType is required');
  }

  const normalizedFixtureData = normalizeFixtureData(normalized.fixture_data);

  const result = db.prepare(`
    INSERT INTO peek_fixture_catalog (
      name,
      app_type,
      fixture_data,
      frozen,
      parent_fixture_id,
      version
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    name,
    appTypeValue,
    normalizedFixtureData.json,
    normalized.frozen ? 1 : 0,
    normalized.parent_fixture_id,
    normalized.version,
  );

  return getFixture(Number(result.lastInsertRowid));
}

function getFixture(nameOrId) {
  const fixture = getFixtureRecord(nameOrId);
  if (!fixture) return null;

  if (!fixture.parent_fixture_id) {
    return fixture;
  }

  return {
    ...fixture,
    fixture_data: resolveInheritedFixtureData(fixture),
  };
}

function getFixtureByName(name) {
  return getFixture(name);
}

function listFixtures(filters = {}) {
  requireDb();

  const normalizedFilters = filters || {};
  let query = 'SELECT * FROM peek_fixture_catalog WHERE 1 = 1';
  const values = [];

  if (normalizedFilters.name) {
    query += ' AND name = ?';
    values.push(normalizedFilters.name);
  }

  const appType = normalizedFilters.app_type !== undefined
    ? normalizedFilters.app_type
    : normalizedFilters.appType;
  if (appType) {
    query += ' AND app_type = ?';
    values.push(appType);
  }

  if (normalizedFilters.frozen !== undefined) {
    query += ' AND frozen = ?';
    values.push(normalizedFilters.frozen ? 1 : 0);
  }

  const parentFixtureId = normalizedFilters.parent_fixture_id !== undefined
    ? normalizedFilters.parent_fixture_id
    : normalizedFilters.parentFixtureId;
  if (parentFixtureId !== undefined) {
    if (parentFixtureId === null) {
      query += ' AND parent_fixture_id IS NULL';
    } else {
      query += ' AND parent_fixture_id = ?';
      values.push(parentFixtureId);
    }
  }

  query += ' ORDER BY name ASC, id ASC';

  return db.prepare(query).all(...values).map(mapFixtureRow);
}

function resolveFixtureWithInheritance(nameOrId, _visited = new Set()) {
  const fixture = getFixture(nameOrId);
  if (!fixture) return null;

  return {
    ...fixture,
    checksum: computeChecksum(fixture.fixture_data),
    _resolved: true,
  };
}

function updateFixture(id, updates = {}) {
  requireDb();

  const existing = getFixtureRecord(id);
  if (!existing) return null;
  if (existing.frozen) {
    throw new Error(`Fixture '${existing.id}' is frozen and cannot be modified`);
  }

  const normalized = normalizeUpdateInput(updates);
  const fields = [];
  const values = [];

  if (normalized.name !== undefined) {
    const name = typeof normalized.name === 'string' ? normalized.name.trim() : '';
    if (!name) {
      throw new Error('Fixture name is required');
    }
    fields.push('name = ?');
    values.push(name);
  }

  if (normalized.app_type !== undefined) {
    const appType = typeof normalized.app_type === 'string' ? normalized.app_type.trim() : '';
    if (!appType) {
      throw new Error('Fixture appType is required');
    }
    fields.push('app_type = ?');
    values.push(appType);
  }

  if (normalized.fixture_data !== undefined) {
    const normalizedFixtureData = normalizeFixtureData(normalized.fixture_data);
    fields.push('fixture_data = ?');
    values.push(normalizedFixtureData.json);
  }

  if (normalized.parent_fixture_id !== undefined) {
    fields.push('parent_fixture_id = ?');
    values.push(normalized.parent_fixture_id);
  }

  if (normalized.frozen !== undefined) {
    fields.push('frozen = ?');
    values.push(normalized.frozen ? 1 : 0);
  }

  if (fields.length === 0) {
    return getFixture(existing.id);
  }

  fields.push('version = ?');
  values.push(getNextVersion(existing.version));
  fields.push('updated_at = CURRENT_TIMESTAMP');
  values.push(existing.id);

  db.prepare(`
    UPDATE peek_fixture_catalog
    SET ${fields.join(', ')}
    WHERE id = ?
  `).run(...values);

  return getFixture(existing.id);
}

function freezeFixture(id) {
  requireDb();

  const existing = getFixtureRecord(id);
  if (!existing) return null;
  if (existing.frozen) return existing;

  db.prepare(`
    UPDATE peek_fixture_catalog
    SET frozen = 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(existing.id);

  return getFixture(existing.id);
}

function deleteFixture(id) {
  requireDb();

  const existing = getFixtureRecord(id);
  if (!existing) return false;
  if (existing.frozen) {
    throw new Error(`Fixture '${existing.id}' is frozen and cannot be deleted`);
  }

  return db.prepare('DELETE FROM peek_fixture_catalog WHERE id = ?').run(existing.id).changes > 0;
}

function createNewVersion(id, updates = {}) {
  const existing = getFixtureRecord(id);
  if (!existing) return null;

  const normalized = normalizeUpdateInput(updates);
  const hasFieldUpdates = normalized.name !== undefined
    || normalized.app_type !== undefined
    || normalized.fixture_data !== undefined
    || normalized.parent_fixture_id !== undefined
    || normalized.frozen !== undefined;

  if (hasFieldUpdates) {
    return updateFixture(existing.id, updates);
  }

  if (existing.frozen) {
    throw new Error(`Fixture '${existing.id}' is frozen and cannot be modified`);
  }

  db.prepare(`
    UPDATE peek_fixture_catalog
    SET version = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(getNextVersion(existing.version), existing.id);

  return getFixture(existing.id);
}

function seedDefaultFixtures() {
  if (!hasCatalogTable()) return [];

  return DEFAULT_FIXTURES.map((fixture) => {
    const existing = getFixtureByName(fixture.name);
    if (existing) return existing;

    return registerFixture({
      ...fixture,
      frozen: true,
    });
  });
}

module.exports = {
  isPlainObject,
  cloneValue,
  setDb,
  computeChecksum,
  safeJsonParse,
  mapFixtureRow,
  hasCatalogTable,
  deepMerge,
  registerFixture,
  getFixture,
  getFixtureByName,
  listFixtures,
  resolveFixtureWithInheritance,
  createNewVersion,
  updateFixture,
  freezeFixture,
  deleteFixture,
  seedDefaultFixtures,
};
