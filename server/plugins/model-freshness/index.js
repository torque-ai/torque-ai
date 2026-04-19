'use strict';

const toolDefs = require('./tool-defs');
const { createWatchlistStore, WATCHLIST_SCHEMA } = require('./watchlist-store');
const { createEventsStore, EVENTS_SCHEMA } = require('./events-store');
const { fetchRemoteDigest } = require('./registry-client');
const { createScanner } = require('./scanner');
const { createAutoSeed } = require('./auto-seed');
const { createHandlers } = require('./handlers');

const PLUGIN_NAME = 'model-freshness';
const PLUGIN_VERSION = '1.0.0';

function getContainerService(container, name) {
  if (!container || typeof container.get !== 'function') return null;
  try { return container.get(name); } catch { return null; }
}

function resolveRawDb(dbService) {
  const raw = dbService && typeof dbService.getDbInstance === 'function'
    ? dbService.getDbInstance()
    : (dbService && typeof dbService.getDb === 'function' ? dbService.getDb() : dbService);
  if (!raw || typeof raw.prepare !== 'function') {
    throw new Error('model-freshness requires db service with prepare()');
  }
  return raw;
}

function ensureSchema(rawDb) {
  rawDb.prepare(WATCHLIST_SCHEMA).run();
  rawDb.prepare(EVENTS_SCHEMA).run();
}

async function fetchTagsFromHost(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 5000);
  try {
    const resp = await fetch(`${url.replace(/\/$/, '')}/api/tags`, { signal: controller.signal });
    if (!resp.ok) return [];
    const data = await resp.json();
    return Array.isArray(data && data.models) ? data.models.map(m => m.name).filter(Boolean) : [];
  } finally {
    clearTimeout(t);
  }
}

async function fetchLocalDigestFromHost(family, tag, host) {
  try {
    const url = String(host.url || '').replace(/\/$/, '');
    if (!url) return null;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5000);
    try {
      const resp = await fetch(`${url}/api/tags`, { signal: controller.signal });
      if (!resp.ok) return null;
      const data = await resp.json();
      const match = (data && data.models || []).find(m => m.name === `${family}:${tag}`);
      return (match && match.digest) || null;
    } finally {
      clearTimeout(t);
    }
  } catch {
    return null;
  }
}

function createPlugin() {
  let handlers = null;
  let installed = false;

  function install(container) {
    let dbService = getContainerService(container, 'db');
    if (!dbService) {
      try { dbService = require('../../database'); } catch { /* no db */ }
    }
    const rawDb = resolveRawDb(dbService);
    ensureSchema(rawDb);

    const watchlist = createWatchlistStore(rawDb);
    const events = createEventsStore(rawDb);

    let listHosts;
    try {
      const hostMgmt = require('../../db/host-management');
      listHosts = () => hostMgmt.listOllamaHosts({ enabled: true }) || [];
    } catch {
      listHosts = () => [];
    }

    const notifier = getContainerService(container, 'notifier');
    const notify = notifier && typeof notifier.push === 'function'
      ? (evt) => notifier.push(evt)
      : () => {};

    const scanner = createScanner({
      watchlist, events,
      fetchLocalDigest: fetchLocalDigestFromHost,
      fetchRemoteDigest,
      listHosts,
      notify,
    });

    const autoSeed = createAutoSeed({
      watchlist, listHosts, fetchTags: fetchTagsFromHost,
    });

    // Best-effort initial seed
    autoSeed.seedFromHosts().catch(() => {});

    handlers = createHandlers({ watchlist, events, scanner });
    installed = true;
  }

  function uninstall() { installed = false; handlers = null; }

  function middleware() { return []; }

  function mcpTools() {
    // Return tool defs with handlers when installed; bare defs otherwise
    // (the plugin-contract test validates shape without installing).
    if (!installed || !handlers) return toolDefs.slice();
    return toolDefs.map((def) => ({ ...def, handler: handlers[def.name] }));
  }

  function eventHandlers() { return {}; }

  function configSchema() {
    return {
      type: 'object',
      properties: {
        scan_hour_local: { type: 'integer', minimum: 0, maximum: 23, default: 3 },
      },
    };
  }

  return {
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    install, uninstall, middleware, mcpTools, eventHandlers, configSchema,
  };
}

module.exports = { createPlugin };
