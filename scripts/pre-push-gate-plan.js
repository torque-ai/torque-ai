#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const { spawnSync } = require('child_process');

const PLAN_VERSION = 1;
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;

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

function planFromFiles(files, options = {}) {
  const changedFiles = uniqSorted((files || []).filter(Boolean));
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
    dashboard_args: [],
    server_args: [],
    _dashboard_full: false,
    _server_full: false,
    base: options.base || '',
    head: options.head || '',
  };

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
        plan.dashboard_args = [];
        plan._dashboard_full = true;
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
        plan.run_server = true;
        plan.run_perf = true;
        plan.run_audit = true;
        plan.server_args = [];
        plan._server_full = true;
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
    plan.dashboard_args = [];
    plan.server_args = [];
    plan._dashboard_full = true;
    plan._server_full = true;
  } else {
    plan.dashboard_args = plan.run_dashboard ? uniqSorted(plan.dashboard_args) : [];
    plan.server_args = plan.run_server ? uniqSorted(plan.server_args) : [];
    if (!plan.run_dashboard && !plan.run_server && !plan.run_perf && !plan.run_audit) {
      plan.mode = 'docs-only';
      plan.reasons.push('documentation-only diff');
    } else {
      plan.mode = 'affected';
      if (plan.run_dashboard) plan.reasons.push(plan.dashboard_args.length ? 'dashboard affected tests' : 'dashboard full suite');
      if (plan.run_server) plan.reasons.push(plan.server_args.length ? 'server affected tests' : 'server full suite');
      if (plan.run_perf) plan.reasons.push('perf gate required');
      if (plan.run_audit) plan.reasons.push('db query audit required');
    }
  }

  const hashInput = {
    version: plan.version,
    mode: plan.mode,
    run_dashboard: plan.run_dashboard,
    run_server: plan.run_server,
    run_perf: plan.run_perf,
    run_audit: plan.run_audit,
    dashboard_args: plan.dashboard_args,
    server_args: plan.server_args,
    changed_files: plan.changed_files,
    base: plan.base,
    head: plan.head,
  };
  plan.hash = hashObject(hashInput);
  plan.coord_suite = `gate-${plan.mode}-${plan.hash}`;
  plan.summary = `${plan.mode}: ${plan.reasons.join('; ') || 'no reason recorded'}`;
  delete plan._dashboard_full;
  delete plan._server_full;
  return plan;
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
