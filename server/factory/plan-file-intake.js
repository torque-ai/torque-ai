'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../logger').child({ component: 'plan-file-intake' });

function parsePlan(content) {
  const lines = content.split('\n');
  const title = (lines.find((line) => /^#\s+/.test(line)) || '').replace(/^#\s+/, '').trim();
  const goalMatch = content.match(/\*\*Goal:\*\*\s*([^\n]+)/);
  const techMatch = content.match(/\*\*Tech Stack:\*\*\s*([^\n]+)/);
  const tasks = (content.match(/^##\s+Task\s+/gm) || []).length;
  const steps = (content.match(/^\s*-\s*\[\s*\]/gm) || []).length;

  return {
    title: title || 'Untitled Plan',
    goal: goalMatch ? goalMatch[1].trim() : null,
    tech_stack: techMatch ? techMatch[1].trim() : null,
    task_count: tasks,
    step_count: steps,
  };
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function createPlanFileIntake({ db, factoryIntake, shippedDetector }) {
  function findPrevious(project_id, plan_path) {
    return db.prepare(`
      SELECT content_hash, work_item_id FROM factory_plan_file_intake
      WHERE project_id = ? AND plan_path = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(project_id, plan_path);
  }

  function findByContentHash(project_id, plan_path, content_hash) {
    // The UNIQUE index is on (project_id, plan_path, content_hash), but
    // findPrevious only returns the most recent row. If a plan file is
    // edited then reverted, the "latest" hash differs from today's hash
    // even though today's hash is already in history — so INSERT would
    // collide. Check the full history here so the scan is idempotent
    // across revert cycles.
    return db.prepare(`
      SELECT content_hash, work_item_id FROM factory_plan_file_intake
      WHERE project_id = ? AND plan_path = ? AND content_hash = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(project_id, plan_path, content_hash);
  }

  function recordIngest({ project_id, plan_path, content_hash, work_item_id }) {
    // ON CONFLICT DO NOTHING: defense-in-depth. The scan loop already
    // checks findByContentHash before calling this, but if a concurrent
    // scan raced the check, we'd rather no-op than crash SENSE.
    db.prepare(`
      INSERT INTO factory_plan_file_intake (project_id, plan_path, content_hash, work_item_id, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_id, plan_path, content_hash) DO NOTHING
    `).run(project_id, plan_path, content_hash, work_item_id, new Date().toISOString());
  }

  function repairActivePlanFileWorkItem({ project_id, plan_path, content_hash, parsed, work_item_id, reason, skipped }) {
    if (!work_item_id || typeof factoryIntake.getWorkItem !== 'function' || typeof factoryIntake.updateWorkItem !== 'function') {
      return false;
    }

    const item = factoryIntake.getWorkItem(work_item_id);
    if (!item || item.project_id !== project_id || item.source !== 'plan_file') {
      return false;
    }

    const CLOSED = factoryIntake.CLOSED_STATUSES || new Set(['completed', 'rejected', 'shipped']);
    if (item.status && CLOSED.has(item.status)) {
      return false;
    }

    const origin = item.origin && typeof item.origin === 'object'
      ? item.origin
      : (item.origin_json ? JSON.parse(item.origin_json) : {});
    const needsRepair = origin.plan_path !== plan_path
      || origin.content_hash !== content_hash
      || origin.task_count !== parsed.task_count
      || origin.step_count !== parsed.step_count;
    if (!needsRepair) {
      return false;
    }

    factoryIntake.updateWorkItem(item.id, {
      origin_json: {
        ...origin,
        plan_path,
        content_hash,
        task_count: parsed.task_count,
        step_count: parsed.step_count,
        goal: parsed.goal,
        tech_stack: parsed.tech_stack,
      },
    });
    skipped.push({ plan_path, reason, work_item_id: item.id, repaired: true });
    return true;
  }

  function scan({ project_id, plans_dir, filter = /\.md$/i }) {
    if (!project_id) throw new Error('project_id required');
    if (!fs.existsSync(plans_dir)) throw new Error(`plans_dir not found: ${plans_dir}`);

    const created = [];
    const skipped = [];
    let shipped_count = 0;
    const files = fs.readdirSync(plans_dir)
      .filter((name) => filter.test(name))
      .map((name) => path.join(plans_dir, name));

    for (const filePath of files) {
      const content = fs.readFileSync(filePath, 'utf8');
      if (!content.trim()) {
        skipped.push({ plan_path: filePath, reason: 'empty_file' });
        continue;
      }

      const parsed = parsePlan(content);
      if (parsed.step_count === 0) {
        skipped.push({ plan_path: filePath, reason: 'no_tasks' });
        continue;
      }

      const hash = sha256(content);
      const previous = findPrevious(project_id, filePath);
      if (previous && previous.content_hash === hash) {
        if (repairActivePlanFileWorkItem({
          project_id,
          plan_path: filePath,
          content_hash: hash,
          parsed,
          work_item_id: previous.work_item_id,
          reason: 'duplicate_repaired_origin',
          skipped,
        })) {
          continue;
        }
        skipped.push({ plan_path: filePath, reason: 'duplicate', work_item_id: previous.work_item_id });
        continue;
      }

      // Latest row doesn't match, but this exact (project, path, hash)
      // triple may still exist in history (e.g. plan was edited then
      // reverted). Short-circuit to avoid a UNIQUE collision in SENSE.
      const reverted = findByContentHash(project_id, filePath, hash);
      if (reverted) {
        if (repairActivePlanFileWorkItem({
          project_id,
          plan_path: filePath,
          content_hash: hash,
          parsed,
          work_item_id: reverted.work_item_id,
          reason: 'reverted_to_prior_hash_repaired_origin',
          skipped,
        })) {
          continue;
        }
        skipped.push({ plan_path: filePath, reason: 'reverted_to_prior_hash', work_item_id: reverted.work_item_id });
        continue;
      }

      // If the most recent work item for this plan_path is still active
      // (pending, in_progress, verifying, etc.), the hash change is almost
      // always self-induced — EXECUTE stage ticks plan checkboxes, which
      // rewrites the file and changes the sha. Re-ingesting here would
      // produce a duplicate work item for the same plan while the factory
      // is still processing the original. Skip. Once the original item
      // reaches a closed state (shipped/completed/rejected), the next
      // hash change is treated as legitimate new work from the user.
      if (previous && previous.work_item_id && typeof factoryIntake.getWorkItem === 'function') {
        const prevItem = factoryIntake.getWorkItem(previous.work_item_id);
        const CLOSED = factoryIntake.CLOSED_STATUSES || new Set(['completed', 'rejected', 'shipped']);
        if (prevItem && prevItem.status && !CLOSED.has(prevItem.status)) {
          skipped.push({
            plan_path: filePath,
            reason: 'prior_item_still_active',
            work_item_id: previous.work_item_id,
            prior_status: prevItem.status,
          });
          continue;
        }
      }

      let item = factoryIntake.createWorkItem({
        project_id,
        source: 'plan_file',
        title: parsed.title,
        description: [parsed.goal, parsed.tech_stack].filter(Boolean).join('\n\n') || parsed.title,
        priority: 'default',
        requestor: 'plan-file-intake',
        origin: {
          plan_path: filePath,
          content_hash: hash,
          previous_hash: previous ? previous.content_hash : null,
          task_count: parsed.task_count,
          step_count: parsed.step_count,
          goal: parsed.goal,
          tech_stack: parsed.tech_stack,
        },
      });

      if (shippedDetector && typeof shippedDetector.detectShipped === 'function') {
        try {
          const detection = shippedDetector.detectShipped({ content, title: parsed.title });
          if (detection && detection.shipped === true) {
            const nextOrigin = {
              ...(item.origin || {}),
              shipped_signals: detection.signals,
            };
            item = factoryIntake.updateWorkItem(item.id, { status: 'shipped' });
            item = factoryIntake.updateWorkItem(item.id, { origin_json: nextOrigin });
            item.shipped = true;
            item.confidence = detection.confidence;
            shipped_count += 1;
          }
        } catch (err) {
          logger.warn({ err, plan_path: filePath }, 'shipped detection failed');
        }
      }

      recordIngest({
        project_id,
        plan_path: filePath,
        content_hash: hash,
        work_item_id: item.id,
      });
      created.push(item);
      logger.info(`ingested plan: ${path.basename(filePath)} -> work_item ${item.id}`);
    }

    return { created, skipped, scanned: files.length, shipped_count };
  }

  return { scan };
}

module.exports = { createPlanFileIntake, parsePlan };
