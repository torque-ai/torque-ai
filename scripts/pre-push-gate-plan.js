#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PLAN_VERSION = 1;
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;
const REPO_ROOT = path.resolve(__dirname, '..');

const ROOT_DOC_FILES = new Set([
  'README.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'CLAUDE.md',
  'AGENTS.md',
]);

const FULL_GATE_FILES = new Set([
  'package.json',
  'package-lock.json',
  'server/package.json',
  'server/package-lock.json',
  'dashboard/package.json',
  'dashboard/package-lock.json',
  'server/vitest.config.js',
  'dashboard/vitest.config.js',
  'server/tests/worker-setup.js',
  'server/tests/global-setup.js',
  'scripts/pre-push-hook',
  'scripts/install-git-hooks.sh',
  'scripts/worktree-create.sh',
  'scripts/worktree-cutover.sh',
  'scripts/audit-db-queries.js',
  'bin/torque-remote',
  'bin/torque-coord-client',
]);

const SERVER_TARGETED_SOURCE_PREFIXES = [
  'server/ci/',
  'server/dashboard/routes/',
  'server/execution/',
  'server/factory/',
  'server/providers/',
  'server/tool-defs/',
  'server/utils/',
];

const SERVER_TARGETED_SOURCE_FILES = new Set([
  'server/api/v2-discovery-helpers.js',
]);

let serverTestContentCache = null;

function isDocPath(file) {
  return ROOT_DOC_FILES.has(file)
    || file.startsWith('docs/')
    || file.endsWith('.md')
    || file.endsWith('.txt');
}

function isDashboardTest(file) {
  return /^dashboard\/src\/.*\.test\.(js|jsx)$/.test(file);
}

function isServerTest(file) {
  return /^server\/tests\/.*\.test\.js$/.test(file)
    || /^server\/plugins\/[^/]+\/tests\/.*\.test\.js$/.test(file)
    || /^server\/eslint-rules\/.*\.test\.js$/.test(file);
}

function repoAbs(repoPath) {
  return path.join(REPO_ROOT, ...repoPath.split('/'));
}

function repoPathExists(repoPath) {
  return fs.existsSync(repoAbs(repoPath));
}

function normalizeRepoPath(repoPath) {
  return repoPath.replace(/\\/g, '/');
}

function listTestFilesUnder(repoDir) {
  const root = repoAbs(repoDir);
  const results = [];

  function walk(absDir, relDir) {
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const childRel = `${relDir}/${entry.name}`;
      const childAbs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        walk(childAbs, childRel);
      } else if (/\.test\.js$/.test(entry.name)) {
        results.push(childRel);
      }
    }
  }

  if (fs.existsSync(root)) {
    walk(root, repoDir);
  }
  return uniqSorted(results);
}

function quotedIncludes(content, value) {
  return content.includes(`'${value}'`)
    || content.includes(`"${value}"`)
    || content.includes(`\`${value}\``);
}

function isTargetableServerSource(file) {
  if (!file.startsWith('server/') || !file.endsWith('.js') || isServerTest(file)) return false;
  if (file.startsWith('server/plugins/') || file.startsWith('server/eslint-rules/')) return false;
  return SERVER_TARGETED_SOURCE_FILES.has(file)
    || SERVER_TARGETED_SOURCE_PREFIXES.some((prefix) => file.startsWith(prefix));
}

function serverTestsWithContent() {
  if (serverTestContentCache) return serverTestContentCache;
  serverTestContentCache = listTestFilesUnder('server/tests').map((testFile) => {
    let content = '';
    try {
      content = fs.readFileSync(repoAbs(testFile), 'utf8');
    } catch {
      content = '';
    }
    return { testFile, content };
  });
  return serverTestContentCache;
}

function directImportTestFilesForServerSource(file) {
  if (!isTargetableServerSource(file)) return [];
  const sourceAbs = repoAbs(file);
  const matches = [];

  for (const { testFile, content } of serverTestsWithContent()) {
    if (!content) continue;
    const testDir = path.dirname(repoAbs(testFile));
    const withExt = normalizeRepoPath(path.relative(testDir, sourceAbs));
    const normalizedWithExt = withExt.startsWith('.') ? withExt : `./${withExt}`;
    const withoutExt = normalizedWithExt.replace(/\.js$/, '');
    if (quotedIncludes(content, normalizedWithExt) || quotedIncludes(content, withoutExt)) {
      matches.push(serverRelative(testFile));
    }
  }

  return uniqSorted(matches);
}

function serverTargetedSourceTests(file) {
  if (file.startsWith('server/plugins/')) {
    const parts = file.split('/');
    const pluginName = parts[2];
    if (!pluginName || parts[3] === 'tests') return [];
    return listTestFilesUnder(`server/plugins/${pluginName}/tests`).map(serverRelative);
  }

  if (file.startsWith('server/eslint-rules/') && file.endsWith('.js') && !file.endsWith('.test.js')) {
    const candidate = file.replace(/\.js$/, '.test.js');
    return repoPathExists(candidate) ? [serverRelative(candidate)] : [];
  }

  return directImportTestFilesForServerSource(file);
}

function dashboardTargetedSourceTests(file) {
  if (!file.startsWith('dashboard/src/') || isDashboardTest(file)) return [];
  if (!/\.(js|jsx)$/.test(file)) return [];
  if (![
    'dashboard/src/components/',
    'dashboard/src/hooks/',
    'dashboard/src/utils/',
    'dashboard/src/views/',
  ].some((prefix) => file.startsWith(prefix))) {
    return [];
  }

  const withoutExt = file.replace(/\.(js|jsx)$/, '');
  const candidates = uniqSorted([
    `${withoutExt}.test.js`,
    `${withoutExt}.test.jsx`,
  ]);
  return candidates
    .filter(repoPathExists)
    .map(dashboardRelative);
}

function serverRelative(file) {
  return file.replace(/^server\//, '');
}

function dashboardRelative(file) {
  return file.replace(/^dashboard\//, '');
}

function uniqSorted(values) {
  return Array.from(new Set(values)).sort();
}

function hashObject(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, 12);
}

function forceFull(plan, reason) {
  plan.full = true;
  plan.reasons.push(reason);
}

// Top-level JS files in these dirs are the audit's actual scan targets
// (audit-db-queries.js scans dir entries, not subdirectories). Any changed
// file under one of these prefixes flips the audit into --strict, which
// subtracts scripts/audit-db-queries.baseline.json — pre-existing warnings
// stay un-enforced; new violations block the push.
const AUDIT_STRICT_PREFIXES = [
  'server/db/',
  'server/handlers/',
  'server/factory/',
];

function isAuditStrictTrigger(file) {
  if (!file.endsWith('.js')) return false;
  if (isServerTest(file)) return false;
  for (const prefix of AUDIT_STRICT_PREFIXES) {
    if (!file.startsWith(prefix)) continue;
    const remainder = file.slice(prefix.length);
    // Top-level JS only — audit reads `fs.readdirSync(dir)` without recursion.
    if (!remainder.includes('/')) return true;
  }
  return false;
}

function planFromFiles(files, options = {}) {
  const changedFiles = uniqSorted((files || []).filter(Boolean));
  // REMOTE_OS is included in the hash so a Linux operator's passing gate run
  // is not replayed as a cache hit for a Windows operator (different binary
  // toolchains, possible test surface differences). Defaults to 'unknown' when
  // unset — the "unknown" bucket gets its own cache key, which is the correct
  // conservative behaviour. Operators on Linux can set REMOTE_OS=linux via
  // env when invoking the gate (or via the probe added in Task 21).
  const remoteOs = options.remoteOs || process.env.REMOTE_OS || 'unknown';
  const plan = {
    version: PLAN_VERSION,
    mode: 'affected',
    full: false,
    reasons: [],
    changed_files: changedFiles,
    run_dashboard: false,
    run_server: false,
    run_perf: false,
    run_audit: false,
    audit_strict: false,
    dashboard_args: [],
    server_args: [],
    _dashboard_full: false,
    _server_full: false,
    base: options.base || '',
    head: options.head || '',
    remote_os: remoteOs,
  };

  for (const file of changedFiles) {
    if (isAuditStrictTrigger(file)) {
      plan.audit_strict = true;
      break;
    }
  }

  if (changedFiles.length === 0) {
    forceFull(plan, 'empty or unreadable diff');
  }

  for (const file of changedFiles) {
    if (!SAFE_PATH.test(file)) {
      forceFull(plan, `unsafe path requires full gate: ${file}`);
      continue;
    }

    if (FULL_GATE_FILES.has(file) || file.startsWith('server/coord/')) {
      forceFull(plan, `gate, dependency, or coordinator file changed: ${file}`);
      continue;
    }

    if (isDocPath(file)) {
      continue;
    }

    if (file.startsWith('dashboard/')) {
      plan.run_dashboard = true;
      if (isDashboardTest(file)) {
        if (!plan._dashboard_full) plan.dashboard_args.push(dashboardRelative(file));
      } else {
        const targetedTests = dashboardTargetedSourceTests(file);
        if (targetedTests.length > 0) {
          if (!plan._dashboard_full) plan.dashboard_args.push(...targetedTests);
        } else {
          plan.dashboard_args = [];
          plan._dashboard_full = true;
        }
      }
      continue;
    }

    if (file.startsWith('server/perf/')) {
      plan.run_perf = true;
      continue;
    }

    if (file.startsWith('server/')) {
      if (isServerTest(file)) {
        plan.run_server = true;
        if (!plan._server_full) plan.server_args.push(serverRelative(file));
      } else {
        const targetedTests = serverTargetedSourceTests(file);
        if (targetedTests.length > 0) {
          plan.run_server = true;
          if (!plan._server_full) plan.server_args.push(...targetedTests);
          if (!file.startsWith('server/eslint-rules/')) plan.run_audit = true;
        } else {
          plan.run_server = true;
          plan.run_perf = true;
          plan.run_audit = true;
          plan.server_args = [];
          plan._server_full = true;
        }
      }
      continue;
    }

    if (file.startsWith('scripts/') || file.startsWith('bin/')) {
      forceFull(plan, `script or executable changed: ${file}`);
      continue;
    }

    forceFull(plan, `unclassified path requires full gate: ${file}`);
  }

  if (plan.full) {
    plan.mode = 'full';
    plan.run_dashboard = true;
    plan.run_server = true;
    plan.run_perf = true;
    plan.run_audit = true;
    plan.audit_strict = true;
    plan.dashboard_args = [];
    plan.server_args = [];
    plan._dashboard_full = true;
    plan._server_full = true;
  } else {
    plan.dashboard_args = plan.run_dashboard ? uniqSorted(plan.dashboard_args) : [];
    plan.server_args = plan.run_server ? uniqSorted(plan.server_args) : [];
    if (!plan.run_audit) plan.audit_strict = false;
    if (!plan.run_dashboard && !plan.run_server && !plan.run_perf && !plan.run_audit) {
      plan.mode = 'docs-only';
      plan.reasons.push('documentation-only diff');
    } else {
      plan.mode = 'affected';
      if (plan.run_dashboard) plan.reasons.push(plan.dashboard_args.length ? 'dashboard affected tests' : 'dashboard full suite');
      if (plan.run_server) plan.reasons.push(plan.server_args.length ? 'server affected tests' : 'server full suite');
      if (plan.run_perf) plan.reasons.push('perf gate required');
      if (plan.run_audit) plan.reasons.push(plan.audit_strict ? 'db query audit (strict, baseline-aware)' : 'db query audit required');
    }
  }

  const hashInput = {
    version: plan.version,
    mode: plan.mode,
    run_dashboard: plan.run_dashboard,
    run_server: plan.run_server,
    run_perf: plan.run_perf,
    run_audit: plan.run_audit,
    audit_strict: plan.audit_strict,
    dashboard_args: plan.dashboard_args,
    server_args: plan.server_args,
    changed_files: plan.changed_files,
    base: plan.base,
    head: plan.head,
    remote_os: plan.remote_os,
  };
  plan.hash = hashObject(hashInput);
  plan.coord_suite = `gate-${plan.mode}-${plan.hash}`;
  plan.summary = `${plan.mode}: ${plan.reasons.join('; ') || 'no reason recorded'}`;
  delete plan._dashboard_full;
  delete plan._server_full;

  // Opt-in codegraph plan augmenter — only widens the affected-tests set,
  // never narrows it. Gated by TORQUE_GATE_USE_CODEGRAPH=1 so default gate
  // behaviour is preserved while the impact-set integration matures.
  //
  // SAFETY CONTRACT:
  //  - Failures (missing db, missing better-sqlite3, query error, stale
  //    index) are silent. Plan is returned unchanged.
  //  - The augmenter NEVER demotes a full-gate plan to affected, and it
  //    NEVER removes test files from server_args/dashboard_args.
  //  - The plan hash includes any added test files so cache hits remain
  //    correct.
  // server_args.length > 0 gate: when the heuristic returned an empty
  // server_args list, that means "run the entire server suite" — adding
  // 14 codegraph hits would narrow the gate from full-suite to those 14
  // files, demoting coverage. Only augment when the heuristic already
  // settled on a specific test slice.
  //
  // Default-on: the augmenter only ever WIDENS the test set. Explicit
  // TORQUE_GATE_USE_CODEGRAPH=0 disables it; any other value (unset,
  // '1', anything) enables. The internal safety contract above prevents
  // narrowing, so default-on cannot reduce gate coverage.
  if (process.env.TORQUE_GATE_USE_CODEGRAPH !== '0'
      && plan.mode === 'affected'
      && plan.run_server
      && plan.server_args.length > 0
      && !plan._codegraph_already_applied) {
    const extras = tryCodegraphImpactTests(plan);
    if (extras && extras.length > 0) {
      const previousArgs = plan.server_args;
      plan.server_args = uniqSorted([...previousArgs, ...extras]);
      const added = plan.server_args.length - previousArgs.length;
      if (added > 0) {
        plan.reasons.push(`codegraph impact-set added ${added} test file(s)`);
        plan.summary = `${plan.mode}: ${plan.reasons.join('; ') || 'no reason recorded'}`;
        // Re-hash with the expanded args so the cache key reflects the
        // augmented plan; otherwise a non-augmented prior run could replay.
        plan.hash = hashObject({ ...hashInput, server_args: plan.server_args });
        plan.coord_suite = `gate-${plan.mode}-${plan.hash}`;
      }
    }
    plan._codegraph_already_applied = true;
  }

  delete plan._codegraph_already_applied;
  return plan;
}

// Best-effort codegraph impact-set lookup. Opens the codegraph.db (if
// present), maps each changed source file to symbols defined in it, and
// follows `impactSet` reverse-call-graph queries up to depth 3 to find
// test files that transitively exercise those symbols.
//
// All errors are swallowed — this routine MUST NOT break the gate when
// codegraph is missing, the index is stale, or better-sqlite3 isn't
// resolvable from the script's module path. Returns either an array of
// test file paths (server/-relative, suitable for plan.server_args) or
// null when no augmentation could be performed.
function tryCodegraphImpactTests(plan) {
  try {
    const Database = tryRequireFromServer('better-sqlite3');
    if (!Database) return null;
    const dbPath = resolveCodegraphDbPath();
    if (!dbPath || !fs.existsSync(dbPath)) return null;
    const db = new Database(dbPath, { readonly: true });
    try {
      // Filter to changed source files in server/ that we can resolve
      // to symbols. Tests are passed through verbatim by the heuristic
      // path; codegraph augments the source→tests gap.
      const sourceFiles = plan.changed_files.filter((f) =>
        f.startsWith('server/')
        && f.endsWith('.js')
        && !isServerTest(f));
      if (sourceFiles.length === 0) return null;

      const { impactSet } = tryRequireFromServer(
        'server/plugins/codegraph/queries/impact-set',
        { allowRelative: true }
      ) || {};
      if (typeof impactSet !== 'function') return null;

      const repoPath = REPO_ROOT;
      const out = new Set();
      const symbolStmt = db.prepare(
        `SELECT DISTINCT name FROM cg_symbols
         WHERE repo_path = ? AND file_path = ?`
      );
      for (const file of sourceFiles) {
        let symbolRows;
        try {
          symbolRows = symbolStmt.all(repoPath, file);
        } catch {
          continue;
        }
        for (const { name } of symbolRows) {
          let result;
          try {
            result = impactSet({ db, repoPath, symbol: name, depth: 3, scope: 'loose' });
          } catch {
            continue;
          }
          for (const impactedFile of result.files || []) {
            if (isServerTest(impactedFile)) {
              out.add(serverRelative(impactedFile));
            }
          }
        }
      }
      return Array.from(out);
    } finally {
      try { db.close(); } catch { /* best effort */ }
    }
  } catch {
    return null;
  }
}

function tryRequireFromServer(moduleName, options = {}) {
  const candidates = [];
  if (options.allowRelative) {
    candidates.push(path.join(REPO_ROOT, moduleName));
  }
  candidates.push(path.join(REPO_ROOT, 'server', 'node_modules', moduleName));
  candidates.push(moduleName);
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch { /* try next */ }
  }
  return null;
}

function resolveCodegraphDbPath() {
  // Mirror server/plugins/codegraph/index.js resolution but prefer the
  // operator's persistent TORQUE data dir (~/.torque/codegraph.db) over
  // a stale repo-root copy. The plugin runs with TORQUE_DATA_DIR set, so
  // that's the populated DB; the repo-root file is usually a leftover
  // from an early init that no longer gets written.
  //
  // Candidate order: TORQUE_DATA_DIR > ~/.torque > REPO_ROOT.
  // First existing & non-empty (file size > 0) wins.
  const homeDir = require('os').homedir();
  const candidates = [];
  if (process.env.TORQUE_DATA_DIR) candidates.push(path.join(process.env.TORQUE_DATA_DIR, 'codegraph.db'));
  candidates.push(path.join(homeDir, '.torque', 'codegraph.db'));
  candidates.push(path.join(REPO_ROOT, 'codegraph.db'));
  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && stat.size > 0) return candidate;
    } catch { /* try next */ }
  }
  return null;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function shellArgs(paths) {
  return paths.map(shellQuote).join(' ');
}

function toShell(plan) {
  const entries = {
    GATE_PLAN_VERSION: String(plan.version),
    GATE_MODE: plan.mode,
    GATE_PLAN_HASH: plan.hash,
    GATE_COORD_SUITE: plan.coord_suite,
    GATE_PLAN_SUMMARY: plan.summary,
    GATE_CHANGED_COUNT: String(plan.changed_files.length),
    GATE_RUN_DASHBOARD: plan.run_dashboard ? '1' : '0',
    GATE_RUN_SERVER: plan.run_server ? '1' : '0',
    GATE_RUN_PERF: plan.run_perf ? '1' : '0',
    GATE_RUN_AUDIT: plan.run_audit ? '1' : '0',
    GATE_AUDIT_STRICT: plan.audit_strict ? '1' : '0',
    GATE_DASHBOARD_TEST_ARGS: shellArgs(plan.dashboard_args),
    GATE_SERVER_TEST_ARGS: shellArgs(plan.server_args),
  };
  return Object.entries(entries)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join('\n');
}

function diffFiles(base, head) {
  if (!base || !head) return null;
  const result = spawnSync('git', ['diff', '--name-only', '--diff-filter=ACMR', base, head], {
    encoding: 'utf8',
  });
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

function parseArgs(argv) {
  const args = { format: 'shell', base: '', head: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base') args.base = argv[++i] || '';
    else if (arg === '--head') args.head = argv[++i] || '';
    else if (arg === '--format') args.format = argv[++i] || 'shell';
    else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = diffFiles(args.base, args.head);
  const plan = planFromFiles(files, {
    base: args.base,
    head: args.head,
  });
  if (args.format === 'json') {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  } else if (args.format === 'shell') {
    process.stdout.write(`${toShell(plan)}\n`);
  } else {
    throw new Error(`unknown format: ${args.format}`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`[pre-push-gate-plan] ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  planFromFiles,
  toShell,
  shellArgs,
};
