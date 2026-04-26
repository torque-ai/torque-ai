'use strict';

const crypto = require('crypto');
const { safeJsonParse } = require('../utils/json');

let db;
let _packRegistryColumnInfoCache = null;

function setDb(dbInstance) {
  db = dbInstance;
  _packRegistryColumnInfoCache = null;
}


function getPackRegistryColumnInfo() {
  if (!db) return [];
  if (_packRegistryColumnInfoCache !== null) return _packRegistryColumnInfoCache;

  try {
    _packRegistryColumnInfoCache = db.prepare('PRAGMA table_info(pack_registry)').all();
    return _packRegistryColumnInfoCache;
  } catch {
    return [];
  }
}

function getPackRegistryColumns() {
  return new Set(getPackRegistryColumnInfo().map((column) => column.name));
}

function usesTextPrimaryKey(columnInfo = getPackRegistryColumnInfo()) {
  const idColumn = columnInfo.find((column) => column.name === 'id');
  if (!idColumn) return false;
  return String(idColumn.type || '').trim().toUpperCase() !== 'INTEGER';
}

function normalizeRegisterPackInput(nameOrPack, version, appType, author, signature) {
  if (nameOrPack && typeof nameOrPack === 'object' && !Array.isArray(nameOrPack)) {
    return {
      id: nameOrPack.id,
      name: nameOrPack.name,
      version: nameOrPack.version,
      app_type: nameOrPack.app_type ?? nameOrPack.appType ?? null,
      author: nameOrPack.author ?? null,
      signature: nameOrPack.signature,
      signature_verified: nameOrPack.signature_verified ?? nameOrPack.signatureVerified,
      description: nameOrPack.description,
      metadata: nameOrPack.metadata,
    };
  }

  return {
    name: nameOrPack,
    version,
    app_type: appType ?? null,
    author: author ?? null,
    signature,
  };
}

function normalizeSignature(signature) {
  return typeof signature === 'string' ? signature.trim() : '';
}

function mapPackRow(row) {
  if (!row) return null;
  return {
    ...row,
    deprecated: !!row.deprecated,
    signature_verified: !!row.signature_verified,
    metadata: safeJsonParse(row.metadata_json, null),
    version_history: safeJsonParse(row.version_history_json, []),
  };
}

function getPackRowById(id) {
  if (id === undefined || id === null || id === '') return null;
  return db.prepare('SELECT * FROM pack_registry WHERE id = ?').get(id) || null;
}

function getPackRowByName(name, version) {
  if (name === undefined || name === null || name === '') return null;

  if (version !== undefined && version !== null) {
    return db.prepare('SELECT * FROM pack_registry WHERE name = ? AND version = ?').get(name, version) || null;
  }

  return db.prepare(`
    SELECT *
    FROM pack_registry
    WHERE name = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(name) || null;
}

function registerPack(nameOrPack, version, appType, author, signature) {
  const input = normalizeRegisterPackInput(nameOrPack, version, appType, author, signature);
  const normalizedSignature = normalizeSignature(input.signature);
  if (!normalizedSignature) {
    throw new Error('Pack registration requires a signature');
  }

  const columnInfo = getPackRegistryColumnInfo();
  const columns = new Set(columnInfo.map((column) => column.name));
  const insertColumns = [];
  const values = [];

  if (usesTextPrimaryKey(columnInfo)) {
    insertColumns.push('id');
    values.push(input.id || crypto.randomUUID());
  }

  insertColumns.push('name', 'version', 'app_type', 'author', 'signature');
  values.push(input.name, input.version || '1.0.0', input.app_type ?? null, input.author ?? null, normalizedSignature);

  if (columns.has('signature_verified') && input.signature_verified !== undefined) {
    insertColumns.push('signature_verified');
    values.push(input.signature_verified ? 1 : 0);
  }

  if (columns.has('description') && Object.prototype.hasOwnProperty.call(input, 'description')) {
    insertColumns.push('description');
    values.push(input.description ?? null);
  }

  if (columns.has('metadata_json') && Object.prototype.hasOwnProperty.call(input, 'metadata')) {
    insertColumns.push('metadata_json');
    values.push(input.metadata == null ? null : JSON.stringify(input.metadata));
  }

  const placeholders = insertColumns.map(() => '?').join(', ');
  const result = db.prepare(`
    INSERT INTO pack_registry (${insertColumns.join(', ')})
    VALUES (${placeholders})
  `).run(...values);

  const createdId = insertColumns.includes('id')
    ? values[insertColumns.indexOf('id')]
    : result.lastInsertRowid;

  return mapPackRow(getPackRowById(createdId));
}

function getPack(nameOrId) {
  return mapPackRow(getPackRowById(nameOrId) || getPackRowByName(nameOrId));
}

function getPackByName(name, version) {
  return mapPackRow(getPackRowByName(name, version));
}

function listPacks(filters = {}) {
  const normalizedFilters = filters && typeof filters === 'object' ? filters : {};
  const columns = getPackRegistryColumns();
  let query = 'SELECT * FROM pack_registry WHERE 1=1';
  const values = [];

  const appType = normalizedFilters.app_type ?? normalizedFilters.appType;
  const signatureVerified = normalizedFilters.signature_verified ?? normalizedFilters.signatureVerified;

  if (appType !== undefined) {
    query += ' AND app_type = ?';
    values.push(appType);
  }
  if (normalizedFilters.deprecated !== undefined) {
    query += ' AND deprecated = ?';
    values.push(normalizedFilters.deprecated ? 1 : 0);
  }
  if (normalizedFilters.author !== undefined) {
    query += ' AND author = ?';
    values.push(normalizedFilters.author);
  }
  if (normalizedFilters.name !== undefined) {
    query += ' AND name = ?';
    values.push(normalizedFilters.name);
  }
  if (normalizedFilters.version !== undefined) {
    query += ' AND version = ?';
    values.push(normalizedFilters.version);
  }
  if (signatureVerified !== undefined && columns.has('signature_verified')) {
    query += ' AND signature_verified = ?';
    values.push(signatureVerified ? 1 : 0);
  }

  query += ' ORDER BY name ASC, version DESC, id ASC';
  return db.prepare(query).all(...values).map(mapPackRow);
}

function queryByAppType(appType) {
  return listPacks({ appType });
}

function deprecatePack(id, reason, successorPackId) {
  const pack = getPackRowById(id);
  if (!pack) return null;

  if (successorPackId !== undefined && successorPackId !== null) {
    const successor = getPackRowById(successorPackId);
    if (!successor) {
      throw new Error(`Successor pack '${successorPackId}' not found`);
    }
  }

  db.prepare(`
    UPDATE pack_registry
    SET deprecated = 1,
        deprecation_reason = ?,
        successor_pack_id = COALESCE(?, successor_pack_id),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(reason || null, successorPackId ?? null, id);

  return mapPackRow(getPackRowById(id));
}

function transferOwnership(id, newOwner) {
  const pack = getPackRowById(id);
  if (!pack) return null;

  db.prepare(`
    UPDATE pack_registry
    SET owner = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(newOwner ?? null, id);

  return mapPackRow(getPackRowById(id));
}

function setSunsetDate(id, sunsetDate) {
  const pack = getPackRowById(id);
  if (!pack) return null;

  db.prepare(`
    UPDATE pack_registry
    SET sunset_date = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(sunsetDate ?? null, id);

  return mapPackRow(getPackRowById(id));
}

function getPackVersionHistory(nameOrId) {
  const resolvedById = getPackRowById(nameOrId);
  let rows;

  if (resolvedById) {
    rows = db.prepare(`
      SELECT id, name, version, author, created_at AS registered_at, deprecated, deprecation_reason, sunset_date
      FROM pack_registry
      WHERE name = ?
        AND (
          created_at < ?
          OR (created_at = ? AND id <= ?)
        )
      ORDER BY created_at ASC, id ASC
    `).all(resolvedById.name, resolvedById.created_at, resolvedById.created_at, resolvedById.id);
  } else {
    rows = db.prepare(`
      SELECT id, name, version, author, created_at AS registered_at, deprecated, deprecation_reason, sunset_date
      FROM pack_registry
      WHERE name = ?
      ORDER BY created_at ASC, id ASC
    `).all(nameOrId);
  }

  return rows.map((row) => ({
    ...row,
    deprecated: !!row.deprecated,
  }));
}

function listDeprecatedPacks() {
  return db.prepare(`
    SELECT *
    FROM pack_registry
    WHERE deprecated = 1
    ORDER BY updated_at DESC, id DESC
  `).all().map(mapPackRow);
}

function setMaintainer(id, maintainer) {
  const pack = getPackRowById(id);
  if (!pack) return null;

  db.prepare(`
    UPDATE pack_registry
    SET maintainer = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(maintainer ?? null, id);

  return mapPackRow(getPackRowById(id));
}

function setSuccessorPack(id, successorPackId) {
  const pack = getPackRowById(id);
  if (!pack) return null;

  const successor = getPackRowById(successorPackId);
  if (!successor) {
    throw new Error(`Successor pack '${successorPackId}' not found`);
  }

  db.prepare(`
    UPDATE pack_registry
    SET successor_pack_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(successorPackId, id);

  return mapPackRow(getPackRowById(id));
}

function recordVersionHistory(id) {
  const pack = getPack(id);
  if (!pack) return null;

  const history = Array.isArray(pack.version_history)
    ? [...pack.version_history]
    : safeJsonParse(pack.version_history_json, []);

  history.push({
    version: pack.version,
    recorded_at: new Date().toISOString(),
    deprecated: pack.deprecated,
  });

  db.prepare(`
    UPDATE pack_registry
    SET version_history_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(JSON.stringify(history), id);

  return mapPackRow(getPackRowById(id));
}

function deletePack(id) {
  const pack = getPackRowById(id);
  if (!pack) return false;

  db.prepare('DELETE FROM pack_registry WHERE id = ?').run(id);
  return true;
}

function createPackRegistry({ db: dbInst }) {
  setDb(dbInst);
  return {
    safeJsonParse,
    mapPackRow,
    registerPack,
    getPack,
    getPackByName,
    listPacks,
    queryByAppType,
    deprecatePack,
    transferOwnership,
    setSunsetDate,
    getPackVersionHistory,
    listDeprecatedPacks,
    setMaintainer,
    setSuccessorPack,
    recordVersionHistory,
    deletePack,
  };
}

module.exports = {
  setDb,
  getPackRegistryColumnInfo,
  createPackRegistry,
  safeJsonParse,
  mapPackRow,
  registerPack,
  getPack,
  getPackByName,
  listPacks,
  queryByAppType,
  deprecatePack,
  transferOwnership,
  setSunsetDate,
  getPackVersionHistory,
  listDeprecatedPacks,
  setMaintainer,
  setSuccessorPack,
  recordVersionHistory,
  deletePack,
};
