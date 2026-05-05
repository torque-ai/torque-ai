#!/usr/bin/env node
'use strict';

// One-shot backfill: rescue tasks whose top-level `project` column is null
// because they were cloned by the startup-task-reconciler before
// 3e625b29 (createClone now preserves original.project). The
// `project:<name>` tag survived the clone but the column went null,
// which makes the dashboard kanban card hide the project chip.
//
// Logic: for every row where project IS NULL AND tags include
// `project:<name>`, parse the tag and write `project = <name>`.
//
// Defaults to dry-run. Pass --apply to actually write.
//
// Examples:
//   node scripts/backfill-task-project-from-tags.js
//   node scripts/backfill-task-project-from-tags.js --apply
//   node scripts/backfill-task-project-from-tags.js --apply --limit=50
//   node scripts/backfill-task-project-from-tags.js --verbose
//
// Safety:
// - Dry-run by default — prints the SET clause for each row but doesn't write.
// - --limit caps how many rows it touches in one run (default: unlimited).
// - Skips rows whose project tag would extract empty / 'unassigned' / starts with `factory-` (those are batch_ids, not projects).
// - Wraps the whole batch in a transaction so partial failures roll back.

const path = require('path');
const Database = require(path.join(__dirname, '..', 'server', 'node_modules', 'better-sqlite3'));
const { getDataDir } = require(path.join(__dirname, '..', 'server', 'data-dir'));

// Built-in alias map: pre-canonicalize legacy/short project names so the
// backfill produces the same value the dashboard kanban filter expects.
// `torque` was the original name for the torque-public project before
// the repo got renamed; one row (a7839664, cwd=...\torque-public) still
// carries the old tag. Pass --alias from=to to add or override entries.
const DEFAULT_ALIASES = Object.freeze({
  torque: 'torque-public',
});

function parseArgs(argv) {
  const args = { apply: false, limit: 0, verbose: false, aliases: { ...DEFAULT_ALIASES } };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--apply') { args.apply = true; continue; }
    if (a === '--verbose' || a === '-v') { args.verbose = true; continue; }
    if (a === '--no-alias') { args.aliases = {}; continue; }
    if (a === '--limit') { args.limit = parseInt(rest[++i] || '0', 10) || 0; continue; }
    if (a.startsWith('--limit=')) { args.limit = parseInt(a.split('=')[1] || '0', 10) || 0; continue; }
    if (a === '--alias') { applyAliasArg(args.aliases, rest[++i] || ''); continue; }
    if (a.startsWith('--alias=')) { applyAliasArg(args.aliases, a.split('=').slice(1).join('=')); continue; }
  }
  return args;
}

function applyAliasArg(target, raw) {
  if (typeof raw !== 'string' || !raw.includes('=')) return;
  const [from, to] = raw.split('=').map((s) => s.trim());
  if (!from || !to) return;
  target[from] = to;
}

function canonicalizeProject(name, aliases) {
  if (!name) return name;
  if (aliases && Object.prototype.hasOwnProperty.call(aliases, name)) return aliases[name];
  return name;
}

function parseTags(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try { const parsed = JSON.parse(trimmed); if (Array.isArray(parsed)) return parsed; } catch { /* fall through */ }
  }
  return trimmed.split(',').map((t) => t.trim()).filter(Boolean);
}

function extractProjectFromTags(tags) {
  for (const tag of tags) {
    if (typeof tag !== 'string') continue;
    if (!tag.startsWith('project:')) continue;
    const name = tag.slice('project:'.length).trim();
    if (!name) continue;
    if (name === 'unassigned') continue;
    // factory-<uuid> entries are batch IDs that landed in tags as
    // `project:factory-<uuid>` from older code paths — those are not
    // human-meaningful project names, skip them.
    if (name.startsWith('factory-')) continue;
    return name;
  }
  return null;
}

function main() {
  const args = parseArgs(process.argv);
  const dataDir = getDataDir();
  // DB_PATH is `<data-dir>/tasks.db` per server/database.js. `torque.db`
  // exists in the same dir as a 0-byte legacy placeholder, so opening
  // that name silently returns no rows.
  const dbPath = path.join(dataDir, 'tasks.db');

  console.log(`backfill-task-project-from-tags`);
  console.log(`  data dir : ${dataDir}`);
  console.log(`  db path  : ${dbPath}`);
  console.log(`  mode     : ${args.apply ? 'APPLY (writes)' : 'DRY-RUN (no writes)'}`);
  if (args.limit > 0) console.log(`  limit    : ${args.limit} row(s)`);
  const aliasEntries = Object.entries(args.aliases || {});
  if (aliasEntries.length > 0) {
    console.log(`  aliases  : ${aliasEntries.map(([f, t]) => `${f} → ${t}`).join(', ')}`);
  }
  console.log('');

  const db = new Database(dbPath, { fileMustExist: true });
  // We only ever write `project = <text>` here — no schema or row deletions.
  // Keep journal mode untouched and let TORQUE's WAL stay live.

  const rows = db.prepare(`
    SELECT id, tags, status, working_directory
    FROM tasks
    WHERE (project IS NULL OR project = '')
      AND tags IS NOT NULL
      AND tags != ''
      AND tags LIKE '%"project:%'
  `).all();

  const candidates = [];
  const skipped = { no_project_tag: 0, batch_id_tag: 0 };
  let aliased = 0;
  for (const row of rows) {
    const tags = parseTags(row.tags);
    const rawProject = extractProjectFromTags(tags);
    const project = canonicalizeProject(rawProject, args.aliases);
    if (rawProject && project !== rawProject) aliased += 1;
    if (!project) {
      // Tag value was empty, 'unassigned', or factory-<uuid>. Track
      // separately so the operator can tell the difference between
      // "nothing to do" and "found something but rejected it".
      const hadProjectTag = tags.some((t) => typeof t === 'string' && t.startsWith('project:'));
      if (hadProjectTag) skipped.batch_id_tag += 1; else skipped.no_project_tag += 1;
      continue;
    }
    candidates.push({ id: row.id, project, status: row.status, working_directory: row.working_directory });
    if (args.limit > 0 && candidates.length >= args.limit) break;
  }

  console.log(`found ${rows.length} task row(s) with null project + project-style tag`);
  console.log(`  candidates  : ${candidates.length}`);
  console.log(`  skipped:`);
  console.log(`    no project tag  : ${skipped.no_project_tag}`);
  console.log(`    batch-id tag    : ${skipped.batch_id_tag}`);
  if (aliased > 0) console.log(`  aliased (raw → canonical): ${aliased}`);
  console.log('');

  if (candidates.length === 0) {
    console.log('nothing to backfill.');
    return;
  }

  // Show a per-project tally so the operator can spot wrong-project
  // assignments before approving the apply step.
  const byProject = candidates.reduce((acc, c) => { acc[c.project] = (acc[c.project] || 0) + 1; return acc; }, {});
  console.log('per-project tally:');
  for (const [name, count] of Object.entries(byProject).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${name.padEnd(20)} ${count}`);
  }
  console.log('');

  if (args.verbose) {
    console.log('first 20 candidates:');
    for (const c of candidates.slice(0, 20)) {
      console.log(`  ${c.id.slice(0, 8)} ${(c.status || '?').padEnd(10)} project=${c.project}  cwd=${c.working_directory || ''}`);
    }
    console.log('');
  }

  if (!args.apply) {
    console.log('DRY-RUN complete. Re-run with --apply to write the project column.');
    return;
  }

  const update = db.prepare('UPDATE tasks SET project = ? WHERE id = ? AND (project IS NULL OR project = \'\')');
  const tx = db.transaction((items) => {
    let touched = 0;
    for (const item of items) {
      const result = update.run(item.project, item.id);
      if (result.changes > 0) touched += 1;
    }
    return touched;
  });

  const touched = tx(candidates);
  console.log(`applied: ${touched} row(s) updated.`);
  if (touched < candidates.length) {
    console.log(`  ${candidates.length - touched} row(s) raced (project column was already non-null at write time)`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`ERROR: ${err && err.message ? err.message : String(err)}`);
    process.exit(1);
  }
}

module.exports = {
  parseTags,
  extractProjectFromTags,
  canonicalizeProject,
  DEFAULT_ALIASES,
};
