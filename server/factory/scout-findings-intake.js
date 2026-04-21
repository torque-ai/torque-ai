'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { guardIntakeItem } = require('./meta-intake-guard');
const logger = require('../logger').child({ component: 'scout-findings-intake' });

const DEFAULT_FILE_FILTER = /-scan\.md$/i;
const VARIANT_PATTERN = /^\*\*Variant:\*\*\s*([^\n]+)$/m;
const FINDING_BLOCK_PATTERN = /^###\s+\[(CRITICAL|HIGH|MEDIUM|LOW)\]\s+(.+?)\s*$/gim;
const FILE_PATTERN = /^-\s+\*\*File:\*\*\s*([^\n]+)$/m;
const DESCRIPTION_PATTERN = /^-\s+\*\*Description:\*\*\s*([^\n]+(?:\n(?!-\s+\*\*)[^\n]+)*)/m;
const SUGGESTED_FIX_PATTERN = /^-\s+\*\*Suggested fix:\*\*\s*([^\n]+(?:\n(?!-\s+\*\*)[^\n]+)*)/m;

const SEVERITY_PRIORITY = {
  CRITICAL: 'high',
  HIGH: 'medium',
  MEDIUM: 'default',
  LOW: 'low',
};

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function parseVariant(content) {
  const match = content.match(VARIANT_PATTERN);
  return match ? match[1].trim() : null;
}

function firstGroup(block, pattern) {
  const match = block.match(pattern);
  return match ? match[1].trim() : null;
}

// Splits the findings body into blocks starting at "### [SEVERITY] Title".
// Uses matchAll so we get deterministic iteration without mutating a shared
// RegExp lastIndex across calls.
function parseFindings(content) {
  const matches = Array.from(content.matchAll(FINDING_BLOCK_PATTERN)).map((m) => ({
    index: m.index,
    severity: m[1].toUpperCase(),
    title: m[2].trim(),
  }));

  const findings = [];
  for (let i = 0; i < matches.length; i += 1) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : content.length;
    const block = content.slice(start, end);
    findings.push({
      severity: matches[i].severity,
      title: matches[i].title,
      file: firstGroup(block, FILE_PATTERN),
      description: firstGroup(block, DESCRIPTION_PATTERN),
      suggested_fix: firstGroup(block, SUGGESTED_FIX_PATTERN),
    });
  }
  return findings;
}

// Hash on the stable identity (severity|title|file) rather than the whole block.
// This keeps the work item the same across minor description/suggested-fix edits,
// which scouts commonly produce between runs.
function findingHash(finding) {
  return sha256([
    finding.severity || '',
    finding.title || '',
    finding.file || '',
  ].join('|'));
}

function createScoutFindingsIntake({ db, factoryIntake }) {
  if (!db) throw new Error('db is required');
  if (!factoryIntake || typeof factoryIntake.createWorkItem !== 'function') {
    throw new Error('factoryIntake with createWorkItem is required');
  }

  function findPrevious(project_id, scan_path, finding_hash) {
    return db.prepare(`
      SELECT finding_hash, work_item_id FROM factory_scout_findings_intake
      WHERE project_id = ? AND scan_path = ? AND finding_hash = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(project_id, scan_path, finding_hash);
  }

  function recordIngest({ project_id, scan_path, finding_hash, work_item_id }) {
    // ON CONFLICT DO NOTHING mirrors plan-file-intake: the scan loop already
    // checks findPrevious, but if a concurrent scan raced the check we prefer
    // a no-op over a crash.
    db.prepare(`
      INSERT INTO factory_scout_findings_intake (project_id, scan_path, finding_hash, work_item_id, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_id, scan_path, finding_hash) DO NOTHING
    `).run(project_id, scan_path, finding_hash, work_item_id, new Date().toISOString());
  }

  async function scan({ project_id, findings_dir, filter = DEFAULT_FILE_FILTER }) {
    if (!project_id) throw new Error('project_id required');

    const created = [];
    const skipped = [];

    if (!findings_dir || !fs.existsSync(findings_dir)) {
      return { created, skipped, scanned: 0 };
    }

    let files = [];
    try {
      files = fs.readdirSync(findings_dir)
        .filter((name) => filter.test(name))
        .map((name) => path.join(findings_dir, name));
    } catch (err) {
      logger.warn({ err, findings_dir }, 'readdir failed');
      return { created, skipped, scanned: 0 };
    }

    for (const filePath of files) {
      let content;
      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch (err) {
        skipped.push({ scan_path: filePath, reason: 'read_error', error: err.message });
        continue;
      }

      if (!content.trim()) {
        skipped.push({ scan_path: filePath, reason: 'empty_file' });
        continue;
      }

      const findings = parseFindings(content);
      if (findings.length === 0) {
        skipped.push({ scan_path: filePath, reason: 'no_findings' });
        continue;
      }

      const variant = parseVariant(content);

      for (const finding of findings) {
        const hash = findingHash(finding);
        const previous = findPrevious(project_id, filePath, hash);

        if (previous && previous.work_item_id) {
          // A prior work item exists for this stable identity. If it still
          // points at a row in factory_work_items, skip re-ingest regardless
          // of status: re-ingesting while active causes duplicates, and
          // re-ingesting a closed item re-opens work the user already shipped
          // or rejected. Users who want a completed finding rechecked can
          // delete the intake row manually.
          let priorItem = null;
          if (typeof factoryIntake.getWorkItem === 'function') {
            priorItem = factoryIntake.getWorkItem(previous.work_item_id);
          }
          if (priorItem) {
            skipped.push({
              scan_path: filePath,
              reason: 'duplicate',
              work_item_id: previous.work_item_id,
              finding_title: finding.title,
            });
            continue;
          }
        }

        const guard = await guardIntakeItem({ title: finding.title });
        if (!guard.ok) {
          skipped.push({
            scan_path: filePath,
            reason: 'meta_task_no_code_output',
            finding_title: finding.title,
          });
          continue;
        }

        let item;
        try {
          item = factoryIntake.createWorkItem({
            project_id,
            source: 'scout',
            title: finding.title,
            description: finding.description || finding.title,
            priority: SEVERITY_PRIORITY[finding.severity] || 'default',
            requestor: 'scout-findings-intake',
            origin: {
              scan_path: filePath,
              finding_hash: hash,
              severity: finding.severity,
              target_file: finding.file,
              variant,
              suggested_fix: finding.suggested_fix,
            },
          });
        } catch (err) {
          logger.warn({ err, scan_path: filePath, finding_title: finding.title }, 'createWorkItem failed');
          const reason = err?.reason === 'meta_task_no_code_output'
            ? 'meta_task_no_code_output'
            : 'create_failed';
          skipped.push({
            scan_path: filePath,
            reason,
            error: err.message,
            finding_title: finding.title,
          });
          continue;
        }

        recordIngest({
          project_id,
          scan_path: filePath,
          finding_hash: hash,
          work_item_id: item.id,
        });
        created.push(item);
        logger.info(`ingested finding: [${finding.severity}] ${finding.title} -> work_item ${item.id}`);
      }
    }

    return { created, skipped, scanned: files.length };
  }

  return { scan };
}

module.exports = {
  createScoutFindingsIntake,
  parseFindings,
  parseVariant,
  findingHash,
  SEVERITY_PRIORITY,
};
