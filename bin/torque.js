#!/usr/bin/env node

'use strict';

const path = require('path');
const fs = require('fs');
const { apiPost } = require(path.join(__dirname, '..', 'cli', 'api-client'));

// Read version from server package.json
let version = 'unknown';
try {
  version = require(path.join(__dirname, '..', 'server', 'package.json')).version;
} catch { /* ignore */ }

const command = process.argv[2];
const subcommand = process.argv[3];

// Handle --version and -v
if (command === '--version' || command === '-v') {
  console.log(version);
  process.exit(0);
}

// Handle --help, -h, or no command
if (command === '--help' || command === '-h' || !command) {
  console.log(`TORQUE v${version} — Distributed AI Task Orchestration

Usage: torque <command> [options]

Setup:
  init                    Initialize TORQUE in current directory
  start                   Start the TORQUE server
  stop                    Stop the TORQUE server
  dashboard               Open the web dashboard

Task Management:
  submit <description>    Submit a task (uses smart routing)
  submit --dry-run <desc> Preview routing without submitting
  status                  Show server status and queue overview
  list [--status=X]       List tasks with optional filters
  result <task-id>        Get task result/output
  cancel <task-id>        Cancel a running task
  await <task-id>         Wait for task to complete

Workflows:
  workflow create <name>  Create a new workflow (use --task flags)
  workflow run <id>       Start a workflow
  workflow status <id>    Check workflow status

Planning:
  decompose <description>  Break a feature into tasks
  plan import <file.md>    Import a plan document

Providers:
  provider list           Show all providers and their status
  provider add            Add a new provider (interactive)
  provider test <name>    Verify a provider works
  health                  Check server and host health

Templates:
  template list           List saved task templates
  template submit <name>  Submit a task from a template
  template create         Create a new template (coming soon)

Cache:
  cache lookup <desc>     Look up cached results for a task
  cache clear             Clear the task cache

Database:
  backup create           Create a database backup
  backup list             List available backups
  backup restore <file>   Restore from a backup

Diagnostics:
  doctor                  Run diagnostic checks
  logs [task-id]          View server or task logs
  budget                  Show cost tracking and budget status
  budget --forecast       Show cost forecast and projections

Options:
  --provider=X     Override provider
  --model=X        Override model
  --json           Output raw JSON
  --dry-run        Preview routing without submitting (with submit)
  --no-color       Disable colored output
  --help           Show this help
  --version        Show version

Documentation: https://torque-ai.dev/docs
Community: https://github.com/torque-ai/torque-ai/discussions`);
  process.exit(0);
}

// Known top-level flags that should be excluded from positional description collection.
const KNOWN_FLAGS = new Set(['--json', '--no-color', '--dry-run', '--help', '-h', '--version', '-v']);
const KNOWN_FLAG_PREFIXES = ['--provider=', '--model=', '--status=', '--suite=', '--dir=', '--directory=', '--poll=', '--timeout='];

// --- Helper: collect remaining args as a string (skipping known flags only) ---
// Only strips recognized CLI flags so that description text containing "--" is preserved.
function collectDescription(startIndex) {
  const parts = [];
  for (let i = startIndex; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (KNOWN_FLAGS.has(arg)) continue;
    if (KNOWN_FLAG_PREFIXES.some(prefix => arg.startsWith(prefix))) continue;
    parts.push(arg);
  }
  return parts.join(' ').trim();
}

// --- Helper: check if a flag is present ---
function hasFlag(flag) {
  return process.argv.includes(flag);
}

// --- Helper: extract text from MCP tool response ---
function extractText(raw) {
  if (typeof raw === 'string') return raw;
  if (raw?.result && typeof raw.result === 'string') return raw.result;
  if (raw?.content?.[0]?.text) return raw.content[0].text;
  return JSON.stringify(raw, null, 2);
}

// --- Helper: run an async handler with error handling ---
// Exit code 1 = API/network error; exit code 2 = usage/validation error.
function runHandler(fn) {
  fn().catch(err => {
    const isUsageError = err && (err.code === 'INVALID_USAGE' || err.name === 'UsageError');
    console.error(err.message || String(err));
    if (isUsageError) {
      process.exitCode = 2;
    } else {
      process.exitCode = 1;
    }
  });
}

// ===================================================================
// HF2: torque budget --forecast
// ===================================================================
async function handleBudgetForecast() {
  if (hasFlag('--forecast')) {
    const raw = await apiPost('/api/tools/get_cost_forecast', {});
    const text = extractText(raw);

    // Parse key fields from response
    const trendMatch = text.match(/trend[:\s]*([^\n|]+)/i);
    const projectionMatch = text.match(/(?:monthly|projection)[:\s]*([^\n|]+)/i);
    const exhaustionMatch = text.match(/(?:exhaust|days)[:\s]*([^\n|]+)/i);

    console.log('Cost Forecast');
    console.log('─'.repeat(40));
    if (trendMatch) console.log(`  Trend:       ${trendMatch[1].trim()}`);
    if (projectionMatch) console.log(`  Monthly:     ${projectionMatch[1].trim()}`);
    if (exhaustionMatch) console.log(`  Exhaustion:  ${exhaustionMatch[1].trim()}`);
    if (!trendMatch && !projectionMatch && !exhaustionMatch) {
      // Fallback: print raw text
      console.log(text);
    }
  } else {
    // Delegate to existing status command for budget view
    const { runCli } = require(path.join(__dirname, '..', 'cli', 'torque-cli'));
    const code = await runCli(['status']);
    process.exitCode = code;
  }
}

// ===================================================================
// HF3: torque cache lookup "description" / torque cache clear
// ===================================================================
async function handleCache() {
  if (subcommand === 'lookup') {
    const description = collectDescription(4);
    if (!description) {
      console.error('Usage: torque cache lookup "task description"');
      process.exitCode = 1;
      return;
    }
    const raw = await apiPost('/api/tools/lookup_cache', {
      task_description: description,
    });
    const text = extractText(raw);
    console.log(text);
  } else if (subcommand === 'clear') {
    const raw = await apiPost('/api/tools/clear_cache', {});
    const text = extractText(raw);
    console.log(text);
  } else {
    console.error('Usage: torque cache <lookup|clear>');
    console.error('  torque cache lookup "task description"');
    console.error('  torque cache clear');
    process.exitCode = 1;
  }
}

// ===================================================================
// HF4: torque template list/create/submit/delete
// ===================================================================
async function handleTemplate() {
  if (subcommand === 'list') {
    const raw = await apiPost('/api/tools/list_task_templates', {});
    const text = extractText(raw);
    console.log(text);
  } else if (subcommand === 'create') {
    console.log('Template creation is not yet available from the CLI.');
    console.log('Use the MCP tool "create_task_template" or the web dashboard.');
    process.exitCode = 1;
  } else if (subcommand === 'submit') {
    const name = collectDescription(4);
    if (!name) {
      console.error('Usage: torque template submit <template-name>');
      process.exitCode = 1;
      return;
    }
    const raw = await apiPost('/api/tools/submit_from_template', {
      template_name: name,
    });
    const text = extractText(raw);
    console.log(text);
  } else if (subcommand === 'delete') {
    const name = collectDescription(4);
    if (!name) {
      console.error('Usage: torque template delete <template-name>');
      process.exitCode = 1;
      return;
    }
    const raw = await apiPost('/api/tools/delete_task_template', {
      template_name: name,
    });
    const text = extractText(raw);
    console.log(text);
  } else {
    console.error('Usage: torque template <list|create|submit|delete>');
    console.error('  torque template list');
    console.error('  torque template submit <name>');
    console.error('  torque template create    (coming soon)');
    console.error('  torque template delete <name>');
    process.exitCode = 1;
  }
}

// ===================================================================
// HF5: torque plan import <file.md>
// ===================================================================
async function handlePlan() {
  if (subcommand === 'import') {
    const filePath = process.argv[4];
    if (!filePath) {
      console.error('Usage: torque plan import <file.md>');
      process.exitCode = 1;
      return;
    }

    const resolved = path.resolve(filePath);
    let fileContent;
    try {
      fileContent = fs.readFileSync(resolved, 'utf-8');
    } catch (err) {
      console.error(`Failed to read file: ${resolved}`);
      console.error(err.message);
      process.exitCode = 1;
      return;
    }

    const raw = await apiPost('/api/tools/import_plan', {
      plan_content: fileContent,
      working_directory: process.cwd(),
    });
    const text = extractText(raw);
    console.log(text);
  } else {
    console.error('Usage: torque plan import <file.md>');
    process.exitCode = 1;
  }
}

// ===================================================================
// HF6: torque backup create/list/restore
// ===================================================================
async function handleBackup() {
  if (subcommand === 'create') {
    const raw = await apiPost('/api/tools/backup_database', {});
    const text = extractText(raw);
    console.log(text);
  } else if (subcommand === 'list') {
    const raw = await apiPost('/api/tools/list_database_backups', {});
    const text = extractText(raw);
    console.log(text);
  } else if (subcommand === 'restore') {
    const backupPath = process.argv[4];
    if (!backupPath) {
      console.error('Usage: torque backup restore <backup-file>');
      process.exitCode = 1;
      return;
    }
    // Validate the backup path exists on the client before sending to API
    const resolvedPath = path.resolve(backupPath);
    if (!fs.existsSync(resolvedPath)) {
      console.error(`Error: backup file not found: ${resolvedPath}`);
      process.exitCode = 1;
      return;
    }
    const raw = await apiPost('/api/tools/restore_database', {
      backup_path: resolvedPath,
      confirm: true,
    });
    const text = extractText(raw);
    console.log(text);
  } else {
    console.error('Usage: torque backup <create|list|restore>');
    console.error('  torque backup create');
    console.error('  torque backup list');
    console.error('  torque backup restore <file>');
    process.exitCode = 1;
  }
}

// ===================================================================
// Command dispatcher
// ===================================================================

// Delegate existing commands to cli/torque-cli.js
const EXISTING_COMMANDS = new Set([
  'status', 'submit', 'list', 'result', 'cancel', 'await',
  'workflow', 'health', 'decompose', 'diagnose', 'review', 'benchmark'
]);

if (EXISTING_COMMANDS.has(command)) {
  const { runCli } = require(path.join(__dirname, '..', 'cli', 'torque-cli'));
  runCli(process.argv.slice(2)).then(code => { process.exitCode = code; });
} else if (command === 'init') {
  require(path.join(__dirname, '..', 'cli', 'init')).run(process.argv.slice(3));
} else if (command === 'start') {
  require(path.join(__dirname, '..', 'cli', 'start')).run(process.argv.slice(3));
} else if (command === 'stop') {
  require(path.join(__dirname, '..', 'cli', 'stop')).run();
} else if (command === 'dashboard') {
  require(path.join(__dirname, '..', 'cli', 'dashboard')).run();
} else if (command === 'doctor') {
  console.log('torque doctor is not yet implemented.');
  process.exitCode = 1;
} else if (command === 'logs') {
  console.log('torque logs is not yet implemented.');
  process.exitCode = 1;
} else if (command === 'budget') {
  runHandler(handleBudgetForecast);
} else if (command === 'provider') {
  console.log('torque provider is not yet implemented.');
  process.exitCode = 1;
} else if (command === 'cache') {
  runHandler(handleCache);
} else if (command === 'template') {
  runHandler(handleTemplate);
} else if (command === 'plan') {
  runHandler(handlePlan);
} else if (command === 'backup') {
  runHandler(handleBackup);
} else {
  console.error(`Unknown command: ${command}\nRun 'torque --help' for usage.`);
  process.exitCode = 1;
}
