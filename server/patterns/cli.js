#!/usr/bin/env node
'use strict';

const path = require('path');
const { loadPatternsFromDir } = require('./pattern-loader');
const { runPattern } = require('./pattern-runner');

const USAGE = [
  'Usage: torque fabric -p <pattern> [options]',
  '',
  'Options:',
  '  -p, --pattern <name>  Pattern name to execute',
  '  -l, --list            List available patterns',
  '  -v <key=value>        Set a template variable (repeatable)',
  '  --dir <path>          Override the patterns directory',
  '  -h, --help            Show this help',
].join('\n');

function parseArgs(argv = []) {
  const opts = { vars: {} };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '-p' || arg === '--pattern') {
      opts.pattern = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '-l' || arg === '--list') {
      opts.list = true;
      continue;
    }

    if (arg === '--dir') {
      opts.dir = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '-v') {
      const rawPair = argv[index + 1];
      index += 1;

      if (typeof rawPair !== 'string' || !rawPair.includes('=')) {
        return { error: 'Each -v flag must use key=value syntax.' };
      }

      const separatorIndex = rawPair.indexOf('=');
      const key = rawPair.slice(0, separatorIndex).trim();
      const value = rawPair.slice(separatorIndex + 1);

      if (!key) {
        return { error: 'Variable names passed to -v must be non-empty.' };
      }

      opts.vars[key] = value;
      continue;
    }

    if (arg === '-h' || arg === '--help') {
      opts.help = true;
      continue;
    }

    return { error: `Unknown argument: ${arg}` };
  }

  return opts;
}

function readStdin(stdin = process.stdin) {
  return new Promise((resolve) => {
    if (stdin.isTTY) {
      resolve('');
      return;
    }

    let data = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => {
      data += chunk;
    });
    stdin.on('end', () => {
      resolve(data);
    });
  });
}

function getPatternsDir(cwd, dir) {
  return path.resolve(dir || path.join(cwd, '.torque', 'patterns'));
}

function resolveDatabaseFacade() {
  try {
    const { defaultContainer } = require('../container');
    return defaultContainer.get('db');
  } catch {
    // eslint-disable-next-line global-require -- pre-boot fallback
    return require('../database');
  }
}

function initializeProviderRuntime() {
  const db = resolveDatabaseFacade();
  const serverConfig = require('../config');
  const providerRegistry = require('../providers/registry');

  let initializedDb = false;
  if (!db.isReady()) {
    db.init();
    initializedDb = true;
  }

  serverConfig.init({ db });
  providerRegistry.init({ db });
  providerRegistry.registerProviderClass('codex', require('../providers/v2-cli-providers').CodexCliProvider);

  const codex = providerRegistry.getProviderInstance('codex');
  if (!codex) {
    if (initializedDb) {
      db.close();
    }
    throw new Error('codex provider is unavailable');
  }

  return {
    codex,
    close() {
      if (initializedDb && db.isReady()) {
        db.close();
      }
    },
  };
}

async function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const stdin = io.stdin || process.stdin;
  const cwd = io.cwd || process.cwd();

  const opts = parseArgs(argv);
  if (opts.error) {
    stderr.write(`${opts.error}\n\n${USAGE}\n`);
    return 1;
  }

  if (opts.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }

  const dir = getPatternsDir(cwd, opts.dir);
  const patterns = loadPatternsFromDir(dir);

  if (opts.list) {
    for (const pattern of patterns) {
      stdout.write(`${pattern.name}${pattern.description ? ` - ${pattern.description}` : ''}\n`);
    }
    return 0;
  }

  if (!opts.pattern) {
    stderr.write(`A pattern name is required.\n\n${USAGE}\n`);
    return 1;
  }

  const pattern = patterns.find((entry) => entry.name === opts.pattern);
  if (!pattern) {
    stderr.write(`Unknown pattern: ${opts.pattern}. Run with -l to list.\n`);
    return 1;
  }

  const input = await readStdin(stdin);
  const providerRuntime = initializeProviderRuntime();

  try {
    const output = await runPattern({
      pattern,
      input,
      vars: opts.vars,
      callModel: async ({ system, user }) => {
        const prompt = `${system}\n\n${user}`.trim();

        if (typeof providerRuntime.codex.runPrompt === 'function') {
          return providerRuntime.codex.runPrompt({
            prompt,
            max_tokens: 2000,
          });
        }

        const result = await providerRuntime.codex.submit(prompt, null, {
          transport: 'api',
          maxTokens: 2000,
          raw_prompt: true,
        });
        return result?.output ?? result;
      },
    });

    stdout.write(typeof output === 'string' ? output : JSON.stringify(output));
    return 0;
  } finally {
    providerRuntime.close();
  }
}

module.exports = {
  USAGE,
  parseArgs,
  readStdin,
  main,
};

if (require.main === module) {
  main().then((code) => {
    process.exit(code);
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
