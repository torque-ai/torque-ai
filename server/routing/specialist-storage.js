'use strict';

const VALID_ROLES = new Set(['user', 'assistant', 'system', 'tool']);
const DEFAULT_SPECIALIST_LIMIT = 100;
const DEFAULT_GLOBAL_LIMIT = 200;

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return value.trim();
}

function requireRole(role) {
  if (typeof role !== 'string' || !VALID_ROLES.has(role)) {
    throw new Error('role must be one of: user, assistant, system, tool');
  }
  return role;
}

function requireContent(content) {
  if (typeof content !== 'string') {
    throw new Error('content must be a string');
  }
  return content;
}

function normalizeLimit(limit, fallback) {
  const numeric = Number(limit);
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  return Math.trunc(numeric);
}

function ensureSpecialistHistorySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS specialist_chat_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_spec_history_session
    ON specialist_chat_history(user_id, session_id, created_at)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_spec_history_agent
    ON specialist_chat_history(user_id, session_id, agent_id, created_at)
  `);
}

function createSpecialistStorage({ db, now = Date.now } = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('db with prepare() is required');
  }
  if (typeof now !== 'function') {
    throw new Error('now must be a function');
  }

  ensureSpecialistHistorySchema(db);

  const appendStmt = db.prepare(`
    INSERT INTO specialist_chat_history (user_id, session_id, agent_id, role, content, created_at)
    VALUES (?,?,?,?,?,?)
  `);

  const readSpecialistStmt = db.prepare(`
    SELECT *
    FROM specialist_chat_history
    WHERE user_id = ? AND session_id = ? AND agent_id = ?
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `);

  const readGlobalStmt = db.prepare(`
    SELECT *
    FROM specialist_chat_history
    WHERE user_id = ? AND session_id = ?
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `);

  return {
    append({ user_id, session_id, agent_id, role, content }) {
      const createdAt = Number(now());
      if (!Number.isFinite(createdAt)) {
        throw new Error('now() must return a finite number');
      }

      return appendStmt.run(
        requireNonEmptyString(user_id, 'user_id'),
        requireNonEmptyString(session_id, 'session_id'),
        requireNonEmptyString(agent_id, 'agent_id'),
        requireRole(role),
        requireContent(content),
        Math.trunc(createdAt),
      );
    },

    readSpecialist({ user_id, session_id, agent_id, limit = DEFAULT_SPECIALIST_LIMIT }) {
      return readSpecialistStmt.all(
        requireNonEmptyString(user_id, 'user_id'),
        requireNonEmptyString(session_id, 'session_id'),
        requireNonEmptyString(agent_id, 'agent_id'),
        normalizeLimit(limit, DEFAULT_SPECIALIST_LIMIT),
      );
    },

    readGlobal({ user_id, session_id, limit = DEFAULT_GLOBAL_LIMIT }) {
      return readGlobalStmt.all(
        requireNonEmptyString(user_id, 'user_id'),
        requireNonEmptyString(session_id, 'session_id'),
        normalizeLimit(limit, DEFAULT_GLOBAL_LIMIT),
      );
    },
  };
}

module.exports = { createSpecialistStorage };
