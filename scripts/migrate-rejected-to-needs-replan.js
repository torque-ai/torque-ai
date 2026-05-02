#!/usr/bin/env node
'use strict';

// Phase X6 (2026-05-01): one-time migration to rescue work items that
// were terminally 'rejected' under the pre-X3/X4 reject-and-forget
// model. Items whose reject_reason matches a pattern that the
// post-X4 routing now sends to 'needs_replan' get their status flipped
// so they can re-enter PRIORITIZE → architect-with-feedback (X2)
// and try to evolve toward an acceptable plan.
//
// Defaults to dry-run. Pass --apply to actually update the database.
// Pass --base-url to point at a different TORQUE instance.
//
// Examples:
//   node scripts/migrate-rejected-to-needs-replan.js
//   node scripts/migrate-rejected-to-needs-replan.js --apply
//   node scripts/migrate-rejected-to-needs-replan.js --apply --project-id=<uuid>

const http = require('http');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const PROJECT_FILTER = (args.find((a) => a.startsWith('--project-id=')) || '').split('=')[1] || null;
const BASE_URL = (args.find((a) => a.startsWith('--base-url=')) || '').split('=')[1]
  || process.env.TORQUE_API_BASE_URL
  || 'http://127.0.0.1:3457';

// reject_reason patterns that the post-Phase-X4 routing would now send
// to needs_replan instead of rejected. These are the ones safe to
// rescue. Patterns NOT in this list (operator manual rejection,
// branch_stale_*, security/policy violations, scout-proven impossibility,
// 'cannot_generate_plan: no description' which has no replan possible)
// stay rejected — they are legitimately terminal.
const MIGRATABLE_REASON_PATTERNS = [
  /^plan_quality_gate_rejected_after_2_attempts$/,
  /^plan_quality_exhausted_after_\d+_attempts$/,
  /^replan_generation_failed$/,
  /^empty_branch_after_execute$/,
  // cannot_generate_plan: <error message> — but NOT 'no description'
  /^cannot_generate_plan:\s+(?!no description\b)/,
];

// JSON-encoded reasons from the legacy plan-description-quality path
// (the X3-converted code used to write status:'rejected' with a
// JSON.stringify(rejectPayload) reason).
function isJsonPlanQualityReason(reason) {
  if (!reason || typeof reason !== 'string') return false;
  if (reason[0] !== '{') return false;
  try {
    const parsed = JSON.parse(reason);
    return parsed && parsed.code === 'plan_description_quality_below_threshold';
  } catch {
    return false;
  }
}

function isMigratable(reason) {
  if (!reason || typeof reason !== 'string') return false;
  if (MIGRATABLE_REASON_PATTERNS.some((re) => re.test(reason))) return true;
  if (isJsonPlanQualityReason(reason)) return true;
  return false;
}

function httpRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL + path);
    const opts = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + (url.search || ''),
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    };
    const req = http.request(opts, (res) => {
      let chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(text)); } catch { resolve(text); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

async function listProjects() {
  const res = await httpRequest('GET', '/api/v2/factory/projects');
  return res?.data?.projects || [];
}

async function listRejectedItems(projectId) {
  // intake endpoint accepts ?status=rejected
  const res = await httpRequest('GET', `/api/v2/factory/projects/${projectId}/intake?status=rejected&limit=500`);
  return res?.data?.items || res?.data || [];
}

async function migrateOne(item) {
  // Build origin update marking the migration so future readers can
  // distinguish "X6-rescued" from "fresh needs_replan."
  const existingOrigin = (typeof item.origin === 'object' && item.origin)
    ? item.origin
    : (typeof item.origin_json === 'string' ? safeJsonParse(item.origin_json) : {});
  const origin = {
    ...(existingOrigin || {}),
    migrated_from_rejected: {
      original_reject_reason: item.reject_reason,
      migrated_at: new Date().toISOString(),
      migration: 'phase_x6',
    },
  };

  return httpRequest('PUT', `/api/v2/factory/intake/${item.id}`, {
    status: 'needs_replan',
    origin_json: origin,
  });
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

function shortReason(r) {
  if (!r) return '';
  if (r.length <= 60) return r;
  return r.slice(0, 57) + '...';
}

async function main() {
  console.log(`# Phase X6 — migrate rejected → needs_replan`);
  console.log(`# mode: ${APPLY ? 'APPLY (will update DB)' : 'DRY-RUN (no changes)'}`);
  console.log(`# base url: ${BASE_URL}`);
  if (PROJECT_FILTER) console.log(`# project filter: ${PROJECT_FILTER}`);
  console.log('');

  const projects = await listProjects();
  const targets = PROJECT_FILTER ? projects.filter((p) => p.id === PROJECT_FILTER) : projects;
  if (targets.length === 0) {
    console.log('No projects matched the filter.');
    process.exit(0);
  }

  let totalRejected = 0;
  let totalMigratable = 0;
  let totalMigrated = 0;
  let totalSkipped = 0;
  const errors = [];

  for (const project of targets) {
    const rejected = await listRejectedItems(project.id);
    if (rejected.length === 0) continue;
    totalRejected += rejected.length;

    const migratable = rejected.filter((w) => isMigratable(w.reject_reason));
    const skipped = rejected.filter((w) => !isMigratable(w.reject_reason));
    totalMigratable += migratable.length;
    totalSkipped += skipped.length;

    if (migratable.length === 0 && skipped.length === 0) continue;

    console.log(`## ${project.name} (${project.id})`);
    console.log(`   rejected total: ${rejected.length}  migratable: ${migratable.length}  skipped: ${skipped.length}`);

    for (const item of migratable) {
      const action = APPLY ? 'MIGRATE' : 'WOULD MIGRATE';
      console.log(`   [${action}] #${item.id} "${shortReason(item.title || '')}" — reason: ${shortReason(item.reject_reason)}`);
      if (APPLY) {
        try {
          await migrateOne(item);
          totalMigrated += 1;
        } catch (err) {
          errors.push({ id: item.id, project: project.name, err: err.message });
          console.log(`   [ERROR] #${item.id}: ${err.message}`);
        }
      }
    }
    for (const item of skipped) {
      console.log(`   [SKIP]    #${item.id} "${shortReason(item.title || '')}" — reason: ${shortReason(item.reject_reason)}`);
    }
    console.log('');
  }

  console.log('# Summary');
  console.log(`   projects with rejected items: ${targets.filter((p) => true).length}`);
  console.log(`   total rejected items inspected: ${totalRejected}`);
  console.log(`   migratable (matched X3/X4 patterns): ${totalMigratable}`);
  console.log(`   left as rejected (operator/policy/no-description): ${totalSkipped}`);
  if (APPLY) {
    console.log(`   actually migrated: ${totalMigrated}`);
    if (errors.length > 0) {
      console.log(`   ERRORS: ${errors.length}`);
      for (const e of errors) console.log(`     #${e.id} (${e.project}): ${e.err}`);
      process.exit(1);
    }
  } else {
    console.log('   (dry-run — pass --apply to execute)');
  }
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  process.exit(2);
});
