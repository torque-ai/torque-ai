'use strict';

const { getModule } = require('../../container');
const { createActivityStore } = require('../../db/activity-store');
const { sendJson } = require('../middleware');

function unwrapDbHandle(dbService) {
  if (!dbService) {
    return null;
  }

  const db = typeof dbService.getDbInstance === 'function'
    ? dbService.getDbInstance()
    : (typeof dbService.getDb === 'function' ? dbService.getDb() : dbService);

  return db && typeof db.prepare === 'function' ? db : null;
}

function resolveActivityDb() {
  const containerDb = unwrapDbHandle(getModule('db'));
  if (containerDb) {
    return containerDb;
  }

  return unwrapDbHandle(require('../../database'));
}

function resolveActivityStore() {
  const store = getModule('activityStore');
  if (store) {
    return store;
  }

  const db = resolveActivityDb();
  return db ? createActivityStore({ db }) : null;
}

function decodeActivityId(rawId) {
  try {
    return decodeURIComponent(String(rawId || '')).trim();
  } catch {
    return null;
  }
}

function handleListActivities(req, res) {
  const db = resolveActivityDb();
  if (!db) {
    sendJson(res, { error: 'activity database unavailable' }, 500, req);
    return;
  }

  const status = typeof req.query?.status === 'string' ? req.query.status.trim() : '';
  const kind = typeof req.query?.kind === 'string' ? req.query.kind.trim() : '';
  const taskId = typeof req.query?.task_id === 'string' ? req.query.task_id.trim() : '';
  const filters = [];
  const params = [];

  if (status) {
    filters.push('status = ?');
    params.push(status);
  }
  if (kind) {
    filters.push('kind = ?');
    params.push(kind);
  }
  if (taskId) {
    filters.push('task_id = ?');
    params.push(taskId);
  }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT activity_id, workflow_id, task_id, kind, name, status, attempt, max_attempts, started_at, completed_at
    FROM activities ${where}
    ORDER BY created_at DESC
    LIMIT 200
  `).all(...params);

  sendJson(res, { activities: rows }, 200, req);
}

function handleGetActivity(req, res) {
  const activityId = decodeActivityId(req.params?.id);
  if (!activityId) {
    sendJson(res, { error: 'invalid activity id' }, 400, req);
    return;
  }

  const store = resolveActivityStore();
  if (!store || typeof store.get !== 'function') {
    sendJson(res, { error: 'activity store unavailable' }, 500, req);
    return;
  }

  const activity = store.get(activityId);
  if (!activity) {
    sendJson(res, { error: 'not found' }, 404, req);
    return;
  }

  sendJson(res, activity, 200, req);
}

const ACTIVITY_ROUTES = [
  {
    method: 'GET',
    path: '/api/activities',
    handlerName: 'handleListActivities',
    handler: handleListActivities,
  },
  {
    method: 'GET',
    path: /^\/api\/activities\/([^/]+)$/,
    handlerName: 'handleGetActivity',
    handler: handleGetActivity,
    mapParams: ['id'],
  },
];

module.exports = {
  ACTIVITY_ROUTES,
  handleListActivities,
  handleGetActivity,
};
