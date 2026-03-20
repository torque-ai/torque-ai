'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process'); // eslint-disable-line security/detect-child-process

const API_KEYS = [
  { env: 'DEEPINFRA_API_KEY', label: 'DeepInfra' },
  { env: 'OPENAI_API_KEY', label: 'OpenAI (Codex)' },
  { env: 'ANTHROPIC_API_KEY', label: 'Anthropic' },
  { env: 'GROQ_API_KEY', label: 'Groq' },
];

async function detectOllama(host = 'http://localhost:11434') {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${host}/api/tags`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return { available: false, models: [], host };
    const data = await res.json();
    return { available: true, models: (data.models || []).map(m => m.name), host };
  } catch {
    return { available: false, models: [], host };
  }
}

function findCliTool(name) {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const result = execFileSync(cmd, [name], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 });
    return result.toString().trim().split(/\r?\n/)[0];
  } catch {
    return null;
  }
}

function detectApiKeys() {
  const found = [];
  const missing = [];
  for (const key of API_KEYS) {
    if (process.env[key.env]) {
      found.push(key);
    } else {
      missing.push(key);
    }
  }
  return { found, missing };
}

/**
 * Write .mcp.json to targetDir.
 * If the file already exists and options.force is not set, this is a no-op
 * and the function returns { dest, skipped: true } so the caller can warn the user.
 */
function generateMcpJson(targetDir, options = {}) {
  const dest = path.join(targetDir, '.mcp.json');
  if (!options.force && fs.existsSync(dest)) {
    return { dest, skipped: true };
  }
  const config = {
    mcpServers: {
      torque: {
        type: 'sse',
        url: 'http://127.0.0.1:3458/sse',
        description: 'TORQUE \u2014 Distributed AI task orchestration',
      },
    },
  };
  fs.writeFileSync(dest, JSON.stringify(config, null, 2) + '\n');
  return { dest, skipped: false };
}

/**
 * Write .env to targetDir.
 * If the file already exists and options.force is not set, this is a no-op
 * and the function returns { dest, skipped: true } so the caller can warn the user.
 */
function generateEnvFile(targetDir, options = {}) {
  const dest = path.join(targetDir, '.env');
  if (!options.force && fs.existsSync(dest)) {
    return { dest, skipped: true };
  }
  const lines = ['# TORQUE environment configuration', ''];
  lines.push(`TORQUE_API_KEY=${crypto.randomUUID()}`);
  lines.push('');
  for (const key of API_KEYS) {
    const value = process.env[key.env] || '';
    const prefix = value ? '' : '# ';
    lines.push(`${prefix}${key.env}=${value}`);
  }
  lines.push('');
  fs.writeFileSync(dest, lines.join('\n'));
  return { dest, skipped: false };
}

async function run(args = []) {
  const force = args.includes('--force');
  const targetDir = process.cwd();

  console.log('TORQUE \u2014 Setup\n');

  // 1. Detect Ollama
  console.log('Scanning for Ollama...');
  const ollama = await detectOllama();
  if (ollama.available) {
    const names = ollama.models.slice(0, 10).map(m => `    - ${m}`).join('\n');
    const extra = ollama.models.length > 10 ? `\n    ... and ${ollama.models.length - 10} more` : '';
    console.log(`  Found Ollama at ${ollama.host} with ${ollama.models.length} model(s)`);
    if (names) console.log(names + extra);
  } else {
    console.log('  Ollama not detected (install from https://ollama.com)');
  }

  // 2. Scan for CLI tools
  console.log('\nScanning for CLI tools...');
  const codexPath = findCliTool('codex');
  const claudePath = findCliTool('claude');
  console.log(`  codex: ${codexPath || 'not found'}`);
  console.log(`  claude: ${claudePath || 'not found'}`);

  // 3. Check API keys
  console.log('\nChecking API keys...');
  const keys = detectApiKeys();
  for (const k of keys.found) {
    console.log(`  ${k.label}: configured`);
  }
  for (const k of keys.missing) {
    console.log(`  ${k.label}: not set (${k.env})`);
  }

  // 4. Generate .mcp.json
  console.log('\nGenerating configuration...');
  const mcpResult = generateMcpJson(targetDir, { force });
  if (mcpResult.skipped) {
    console.log(`  Skipped ${mcpResult.dest} (already exists — use --force to overwrite)`);
  } else {
    console.log(`  Created ${mcpResult.dest}`);
  }

  // 5. Generate .env
  const envResult = generateEnvFile(targetDir, { force });
  if (envResult.skipped) {
    console.log(`  Skipped ${envResult.dest} (already exists — use --force to overwrite)`);
  } else {
    console.log(`  Created ${envResult.dest}`);
  }

  // 6. Summary
  const providers = [];
  if (ollama.available) providers.push('Ollama (local)');
  if (codexPath) providers.push('Codex (CLI)');
  if (claudePath) providers.push('Claude Code (CLI)');
  for (const k of keys.found) providers.push(`${k.label} (API)`);

  console.log('\n\u2500\u2500\u2500 Setup Complete \u2500\u2500\u2500');
  console.log(`Available providers: ${providers.length > 0 ? providers.join(', ') : 'none detected'}`);
  console.log('\nNext steps:');
  console.log('  1. Start the server:   torque start');
  console.log('  2. Open the dashboard: torque dashboard');
  console.log('  3. Submit a task:      torque submit "Write unit tests for utils.js"');
  if (keys.missing.length > 0) {
    console.log(`\nOptional: set ${keys.missing.map(k => k.env).join(', ')} for cloud providers`);
  }
}

module.exports = { run };
