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

  function recordIngest({ project_id, plan_path, content_hash, work_item_id }) {
    db.prepare(`
      INSERT INTO factory_plan_file_intake (project_id, plan_path, content_hash, work_item_id, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(project_id, plan_path, content_hash, work_item_id, new Date().toISOString());
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
        skipped.push({ plan_path: filePath, reason: 'duplicate', work_item_id: previous.work_item_id });
        continue;
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
