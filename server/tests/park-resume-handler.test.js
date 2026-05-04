'use strict';
/* global describe, it, expect, beforeEach, vi */

const Database = require('better-sqlite3');
const { createTables: ensureSchema } = require('../db/schema/tables');
const { parkWorkItemForCodex } = require('../db/factory/intake');
const { createParkResumeHandler } = require('../factory/park-resume-handler');

const INSERT_PROJECT = `INSERT INTO factory_projects (id, name, path, brief, trust_level, status)
                       VALUES (?, ?, ?, ?, ?, ?)`;
const INSERT_ITEM = `INSERT INTO factory_work_items (project_id, source, title) VALUES (?, ?, ?)`;
const LOGGER_STUB_FACTORY = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });

function makeEventBus() {
  const subscribers = new Map();
  return {
    on(event, fn) {
      const arr = subscribers.get(event) || [];
      arr.push(fn);
      subscribers.set(event, arr);
    },
    emit(event, payload) {
      (subscribers.get(event) || []).forEach((fn) => fn(payload));
    },
  };
}

describe('park-resume-handler', () => {
  let db;
  let eventBus;
  let logger;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureSchema(db, { debug() {}, info() {}, warn() {}, error() {} });
    db.prepare(INSERT_PROJECT).run('p1', 'TestProj', '/tmp', 'brief', 'cautious', 'running');
    db.prepare(INSERT_ITEM).run('p1', 'scout', 'A');
    parkWorkItemForCodex({ db, workItemId: 1, reason: 'test' });
    eventBus = makeEventBus();
    logger = LOGGER_STUB_FACTORY();
  });

  it('subscribes to circuit:recovered and resumes parked items when codex recovers', () => {
    createParkResumeHandler({ db, eventBus, logger });
    eventBus.emit('circuit:recovered', { provider: 'codex', reason: 'canary_succeeded' });
    const row = db.prepare(`SELECT status FROM factory_work_items WHERE id = 1`).get();
    expect(row.status).toBe('pending');
  });

  it('ignores circuit:recovered for non-codex providers', () => {
    createParkResumeHandler({ db, eventBus, logger });
    eventBus.emit('circuit:recovered', { provider: 'groq' });
    const row = db.prepare(`SELECT status FROM factory_work_items WHERE id = 1`).get();
    expect(row.status).toBe('parked_codex_unavailable');
  });

  it('logs resume count on success', () => {
    createParkResumeHandler({ db, eventBus, logger });
    eventBus.emit('circuit:recovered', { provider: 'codex' });
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('park-resume'),
      expect.objectContaining({ resumed: 1 })
    );
  });

  it('throws no error and warns on resume failure', () => {
    const failingDb = {
      prepare: () => ({ run: () => { throw new Error('disk full'); } }),
    };
    createParkResumeHandler({ db: failingDb, eventBus, logger });
    expect(() => eventBus.emit('circuit:recovered', { provider: 'codex' })).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('park-resume failed'),
      expect.objectContaining({ error: 'disk full' })
    );
  });

  it('ignores empty payload', () => {
    createParkResumeHandler({ db, eventBus, logger });
    expect(() => eventBus.emit('circuit:recovered', null)).not.toThrow();
    expect(() => eventBus.emit('circuit:recovered', undefined)).not.toThrow();
    const row = db.prepare(`SELECT status FROM factory_work_items WHERE id = 1`).get();
    expect(row.status).toBe('parked_codex_unavailable');
  });
});
