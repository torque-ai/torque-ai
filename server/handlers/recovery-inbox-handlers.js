'use strict';

const factoryIntake = require('../db/factory-intake');
const factoryDecisions = require('../db/factory-decisions');
const decisionLog = require('../factory/decision-log');
const { defaultContainer } = require('../container');

const DECISION_STAGE = 'learn';
const DECISION_ACTOR = 'human';

let _testDb = null;

// Tests inject db directly (the DI container isn't booted in unit tests).
// Production resolves db via the container at call time.
function setDbForTests(db) { _testDb = db; }

function getDb() {
  if (_testDb) return _testDb;
  return defaultContainer.get('db');
}

function deriveWhyWeGaveUp(historyJson) {
  let arr = [];
  try {
    arr = JSON.parse(historyJson || '[]');
    if (!Array.isArray(arr)) arr = [];
  } catch { arr = []; }
  if (arr.length === 0) return 'no recovery attempts recorded';
  const last = arr[arr.length - 1];
  return `last attempt #${last.attempt}: strategy "${last.strategy}" -> ${last.outcome}${last.reason ? ` (${last.reason})` : ''}`;
}

async function listRecoveryInbox({ project_id = null } = {}) {
  const db = getDb();
  const params = ['needs_review'];
  let projectClause = '';
  if (project_id) {
    projectClause = ' AND project_id = ?';
    params.push(project_id);
  }
  const rows = db.prepare(`
    SELECT id, project_id, title, reject_reason, recovery_attempts, last_recovery_at, recovery_history_json, updated_at
    FROM factory_work_items
    WHERE status = ?${projectClause}
    ORDER BY recovery_attempts DESC, updated_at DESC
  `).all(...params);
  return {
    items: rows.map((r) => ({
      id: r.id,
      project_id: r.project_id,
      status: 'needs_review',
      title: r.title,
      original_reject_reason: r.reject_reason,
      recovery_attempts: r.recovery_attempts,
      last_recovery_at: r.last_recovery_at,
      why_we_gave_up: deriveWhyWeGaveUp(r.recovery_history_json),
    })),
  };
}

async function inspectRecoveryItem({ id }) {
  const db = getDb();
  factoryIntake.setDb(db);
  const item = factoryIntake.getWorkItem(id);
  if (!item) throw new Error(`recovery inbox item ${id} not found`);
  let history = [];
  try {
    history = JSON.parse(item.recovery_history_json || '[]');
    if (!Array.isArray(history)) history = [];
  } catch (_e) {
    void _e;
    history = [];
  }
  const decisions = db.prepare(`
    SELECT id, stage, actor, action, reasoning, inputs_json, outcome_json, created_at
    FROM factory_decisions
    WHERE batch_id = ?
    ORDER BY created_at ASC
  `).all(`replan-recovery:${id}`);
  return { item, history, decisions };
}

async function reviveRecoveryItem({ id, mode, updates = null, children = null }) {
  const db = getDb();
  factoryIntake.setDb(db);
  factoryDecisions.setDb(db);
  const item = factoryIntake.getWorkItem(id);
  if (!item) throw new Error(`recovery inbox item ${id} not found`);
  if (item.status !== 'needs_review') {
    throw new Error(`item ${id} is not in needs_review (status: ${item.status})`);
  }

  const now = new Date().toISOString();

  if (mode === 'retry') {
    db.prepare(`
      UPDATE factory_work_items
      SET status = 'pending',
          reject_reason = NULL,
          recovery_attempts = 0,
          claimed_by_instance_id = NULL,
          updated_at = ?
      WHERE id = ?
    `).run(now, id);
  } else if (mode === 'edit') {
    if (!updates || typeof updates !== 'object') throw new Error('mode=edit requires updates object');
    const title = updates.title != null ? updates.title : item.title;
    const description = updates.description != null ? updates.description : item.description;
    const constraintsJson = updates.constraints != null ? JSON.stringify(updates.constraints) : item.constraints_json;
    db.prepare(`
      UPDATE factory_work_items
      SET status = 'pending',
          title = ?,
          description = ?,
          constraints_json = ?,
          reject_reason = NULL,
          recovery_attempts = 0,
          claimed_by_instance_id = NULL,
          updated_at = ?
      WHERE id = ?
    `).run(title, description, constraintsJson, now, id);
  } else if (mode === 'split') {
    if (!Array.isArray(children) || children.length < 2) {
      throw new Error('mode=split requires children array of length >= 2');
    }
    const tx = db.transaction(() => {
      const linkChildStmt = db.prepare('UPDATE factory_work_items SET linked_item_id = ?, depth = ? WHERE id = ?');
      for (const child of children) {
        const created = factoryIntake.createWorkItem({
          project_id: item.project_id,
          source: 'recovery_split',
          title: child.title,
          description: child.description,
          priority: Math.max(0, Number(item.priority || 50) - 1),
        });
        linkChildStmt.run(item.id, Number(item.depth || 0) + 1, created.id);
      }
      db.prepare(`
        UPDATE factory_work_items
        SET status = 'superseded',
            reject_reason = 'split_into_recovery_children',
            updated_at = ?
        WHERE id = ?
      `).run(now, id);
    });
    tx();
  } else {
    throw new Error(`unknown mode: ${mode}`);
  }

  decisionLog.logDecision({
    project_id: item.project_id,
    stage: DECISION_STAGE,
    actor: DECISION_ACTOR,
    action: 'recovery_inbox_revived',
    reasoning: `Item ${id} revived from inbox via mode "${mode}".`,
    inputs: { work_item_id: id, mode, updates_summary: updates ? Object.keys(updates) : null, child_count: children?.length || 0 },
    outcome: { mode },
    confidence: 1,
    batch_id: `replan-recovery:${id}`,
  });

  return { ok: true, mode };
}

async function dismissRecoveryItem({ id, reason }) {
  const db = getDb();
  factoryIntake.setDb(db);
  factoryDecisions.setDb(db);
  const item = factoryIntake.getWorkItem(id);
  if (!item) throw new Error(`recovery inbox item ${id} not found`);
  if (item.status !== 'needs_review') {
    throw new Error(`item ${id} is not in needs_review (status: ${item.status})`);
  }
  const safeReason = String(reason || 'unspecified').replace(/[\n\r]/g, ' ').slice(0, 200);
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE factory_work_items
    SET status = 'unactionable',
        reject_reason = ?,
        updated_at = ?
    WHERE id = ?
  `).run(`dismissed_from_inbox: ${safeReason}`, now, id);

  decisionLog.logDecision({
    project_id: item.project_id,
    stage: DECISION_STAGE,
    actor: DECISION_ACTOR,
    action: 'recovery_inbox_dismissed',
    reasoning: `Item ${id} dismissed from inbox: ${safeReason}`,
    inputs: { work_item_id: id, reason: safeReason },
    outcome: { status: 'unactionable' },
    confidence: 1,
    batch_id: `replan-recovery:${id}`,
  });

  return { ok: true, reason: safeReason };
}

module.exports = {
  listRecoveryInbox,
  inspectRecoveryItem,
  reviveRecoveryItem,
  dismissRecoveryItem,
  setDbForTests,
  // handleX aliases so the auto-router in tools.js registers them as MCP tools
  handleListRecoveryInbox: listRecoveryInbox,
  handleInspectRecoveryItem: inspectRecoveryItem,
  handleReviveRecoveryItem: reviveRecoveryItem,
  handleDismissRecoveryItem: dismissRecoveryItem,
};
