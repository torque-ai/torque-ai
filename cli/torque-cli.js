#!/usr/bin/env node

const path = require('path');
const { BASE_URL } = require('./api-client');
const { executeCommand } = require('./commands');
const { formatCommandResult } = require('./formatter');

function getVersion() {
  try {
    const pkg = require(path.join(__dirname, '..', 'server', 'package.json'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function getHelpText() {
  return `TORQUE v${getVersion()} \u2014 Distributed AI Task Orchestration

Usage: torque-cli <command> [options]

Commands:
  status                    Show TORQUE server status and queue overview
  submit <description>      Submit a task (uses smart routing)
  list [--status=X]         List tasks with optional status filter
  result <task-id>          Get task result/output
  cancel <task-id>          Cancel a running task
  await <task-id>           Wait for task to complete (polls until done)
  workflow create <name>    Create a new workflow
  workflow run <id>         Start a workflow
  workflow status <id>      Check workflow status
  decompose <feature> -d <dir>  Strategic decomposition
  diagnose <task-id>        Strategic failure diagnosis
  review <task-id>          Strategic quality review
  benchmark [--suite=all]   Run strategic benchmark
  health                    Check server and Ollama health

Options:
  --provider=X     Override provider (codex, ollama, deepinfra, etc.)
  --model=X        Override model
  --json           Output raw JSON instead of formatted text
  --help           Show this help

Base URL:
  ${BASE_URL}`;
}

function parseCliArgs(argv) {
  const flags = { json: false };
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === '--json') {
      flags.json = true;
      continue;
    }
    if (token === '--dry-run') {
      flags.dryRun = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      flags.help = true;
      continue;
    }
    if (token.startsWith('--provider=')) {
      flags.provider = token.slice('--provider='.length);
      continue;
    }
    if (token.startsWith('--model=')) {
      flags.model = token.slice('--model='.length);
      continue;
    }
    if (token.startsWith('--status=')) {
      flags.status = token.slice('--status='.length);
      continue;
    }
    if (token.startsWith('--suite=')) {
      flags.suite = token.slice('--suite='.length);
      continue;
    }
    if (token === '-d' || token === '--dir' || token === '--directory') {
      index += 1;
      flags.directory = argv[index];
      continue;
    }
    if (token.startsWith('--dir=')) {
      flags.directory = token.slice('--dir='.length);
      continue;
    }
    if (token.startsWith('--directory=')) {
      flags.directory = token.slice('--directory='.length);
      continue;
    }
    if (token.startsWith('--poll=')) {
      flags.poll = token.slice('--poll='.length);
      continue;
    }
    if (token.startsWith('--timeout=')) {
      flags.timeout = token.slice('--timeout='.length);
      continue;
    }
    if (token === '--task') {
      index += 1;
      if (!flags.task) flags.task = [];
      flags.task.push(argv[index]);
      continue;
    }
    if (token.startsWith('--task=')) {
      if (!flags.task) flags.task = [];
      flags.task.push(token.slice('--task='.length));
      continue;
    }

    positionals.push(token);
  }

  if (flags.help || positionals.length === 0) {
    return { help: true, flags };
  }

  const [command, subcommand, ...rest] = positionals;

  if (command === 'submit') {
    return {
      command: 'submit',
      description: rest.length > 0 ? [subcommand, ...rest].join(' ') : String(subcommand || ''),
      provider: flags.provider,
      model: flags.model,
      dryRun: flags.dryRun || false,
      json: flags.json,
    };
  }

  if (command === 'list') {
    return {
      command: 'list',
      status: flags.status,
      json: flags.json,
    };
  }

  if (command === 'result') {
    return {
      command: 'result',
      taskId: subcommand,
      json: flags.json,
    };
  }

  if (command === 'cancel') {
    return {
      command: 'cancel',
      taskId: subcommand,
      json: flags.json,
    };
  }

  if (command === 'await') {
    return {
      command: 'await',
      taskId: subcommand,
      poll: flags.poll,
      timeout: flags.timeout,
      json: flags.json,
      _log: (msg) => process.stderr.write(`${msg}\n`),
    };
  }

  if (command === 'workflow') {
    if (subcommand === 'create') {
      return {
        command: 'workflow_create',
        name: rest.join(' '),
        task: flags.task,
        _positional: [],
        json: flags.json,
      };
    }
    if (subcommand === 'run') {
      return {
        command: 'workflow_run',
        workflowId: rest[0],
        json: flags.json,
      };
    }
    if (subcommand === 'status') {
      return {
        command: 'workflow_status',
        workflowId: rest[0],
        json: flags.json,
      };
    }
  }

  if (command === 'decompose') {
    return {
      command: 'decompose',
      feature: [subcommand, ...rest].filter(Boolean).join(' '),
      directory: flags.directory || '',
      provider: flags.provider,
      model: flags.model,
      json: flags.json,
    };
  }

  if (command === 'diagnose') {
    return {
      command: 'diagnose',
      taskId: subcommand,
      provider: flags.provider,
      json: flags.json,
    };
  }

  if (command === 'review') {
    return {
      command: 'review',
      taskId: subcommand,
      provider: flags.provider,
      json: flags.json,
    };
  }

  if (command === 'benchmark') {
    return {
      command: 'benchmark',
      suite: flags.suite || 'all',
      provider: flags.provider,
      model: flags.model,
      json: flags.json,
    };
  }

  if (command === 'status' || command === 'health') {
    return {
      command,
      json: flags.json,
    };
  }

  return {
    command,
    json: flags.json,
  };
}

async function runCli(argv = process.argv.slice(2), deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const cwd = deps.cwd || process.cwd();
  const parsed = parseCliArgs(argv);

  if (parsed.help) {
    stdout.write(`${getHelpText()}\n`);
    return 0;
  }

  try {
    const result = await executeCommand(parsed, { cwd });
    stdout.write(`${formatCommandResult(result, { json: parsed.json })}\n`);
    return 0;
  } catch (err) {
    stderr.write(`${err.message || String(err)}\n`);
    return 1;
  }
}

if (require.main === module) {
  runCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

module.exports = {
  getHelpText,
  parseCliArgs,
  runCli,
};
