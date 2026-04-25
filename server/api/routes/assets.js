'use strict';

const { defaultContainer } = require('../../container');
const { createAssetStore } = require('../../assets/asset-store');
const { createAssetChecks } = require('../../assets/asset-checks');
const { sendJson } = require('../middleware');

function unwrapDb(dbService) {
  if (dbService && typeof dbService.getDbInstance === 'function') {
    return dbService.getDbInstance();
  }

  if (dbService && typeof dbService.getDb === 'function') {
    return dbService.getDb();
  }

  return dbService;
}

function getDb(...contexts) {
  for (const context of contexts) {
    const db = unwrapDb(context?.db);
    if (db && typeof db.prepare === 'function') {
      return db;
    }
  }

  return unwrapDb(defaultContainer.get('db'));
}

function getAssetStore(db) {
  try {
    if (defaultContainer.has('assetStore')) {
      return defaultContainer.get('assetStore');
    }
  } catch {
    // Fall back to a request-local store when the container is not booted in tests.
  }

  return createAssetStore({ db });
}

function getAssetChecks(db) {
  try {
    if (defaultContainer.has('assetChecks')) {
      return defaultContainer.get('assetChecks');
    }
  } catch {
    // Fall back to a request-local checker when the container is not booted in tests.
  }

  return createAssetChecks({ db });
}

function decodeAssetKey(rawKey, req, res) {
  try {
    const key = decodeURIComponent(String(rawKey || ''));
    if (!key) {
      sendJson(res, { error: 'asset key is required' }, 400, req);
      return null;
    }
    return key;
  } catch (err) {
    if (err instanceof URIError) {
      sendJson(res, { error: 'invalid asset key encoding' }, 400, req);
      return null;
    }
    throw err;
  }
}

function sendServerError(req, res, err) {
  sendJson(res, { error: err?.message || 'asset route failed' }, 500, req);
}

function handleListAssets(req, res, contextOrQuery, maybeContext) {
  try {
    const rows = getDb(contextOrQuery, maybeContext)
      .prepare('SELECT * FROM assets ORDER BY asset_key')
      .all();
    sendJson(res, { assets: rows }, 200, req);
  } catch (err) {
    sendServerError(req, res, err);
  }
}

function handleGetAsset(req, res, contextOrQuery, rawKey, maybeContext) {
  try {
    const key = decodeAssetKey(rawKey, req, res);
    if (key === null) return;

    const db = getDb(contextOrQuery, maybeContext);
    const asset = db
      .prepare('SELECT * FROM assets WHERE asset_key = ?')
      .get(key);

    if (!asset) {
      sendJson(res, { error: 'unknown asset' }, 404, req);
      return;
    }

    const store = getAssetStore(db);
    const checks = getAssetChecks(db);
    sendJson(res, {
      asset,
      latest_materialization: store.getLatestMaterialization(key),
      upstream: store.getUpstream(key),
      downstream: store.getDownstream(key),
      checks: checks.latestForAsset(key),
      healthy: checks.isHealthy(key),
    }, 200, req);
  } catch (err) {
    sendServerError(req, res, err);
  }
}

function handleListAssetMaterializations(req, res, contextOrQuery, rawKey, maybeContext) {
  try {
    const key = decodeAssetKey(rawKey, req, res);
    if (key === null) return;

    const rows = getDb(contextOrQuery, maybeContext)
      .prepare(`
        SELECT *
        FROM asset_materializations
        WHERE asset_key = ?
        ORDER BY julianday(produced_at) DESC, rowid DESC
        LIMIT 100
      `)
      .all(key);

    sendJson(res, { asset_key: key, materializations: rows }, 200, req);
  } catch (err) {
    sendServerError(req, res, err);
  }
}

const ASSET_ROUTES = [
  { method: 'GET', path: '/api/assets', handler: handleListAssets },
  {
    method: 'GET',
    path: /^\/api\/assets\/([^/]+)\/materializations$/,
    handler: handleListAssetMaterializations,
    mapParams: ['asset_key'],
  },
  {
    method: 'GET',
    path: /^\/api\/assets\/([^/]+)$/,
    handler: handleGetAsset,
    mapParams: ['asset_key'],
  },
];

module.exports = {
  ASSET_ROUTES,
  handleListAssets,
  handleGetAsset,
  handleListAssetMaterializations,
};
