'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process'); // eslint-disable-line security/detect-child-process
const { API_PORT } = require('./shared');

const SSE_PORT = parseInt(process.env.TORQUE_MCP_SSE_PORT || '3458', 10);
const DASHBOARD_PORT = parseInt(process.env.TORQUE_DASHBOARD_PORT || '3456', 10);
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';

const API_KEYS = [
  { env: 'DEEPINFRA_API_KEY', label: 'DeepInfra' },
  { env: 'HYPERBOLIC_API_KEY', label: 'Hyperbolic' },
  { env: 'OPENAI_API_KEY', label: 'OpenAI (Codex)' },
  { env: 'ANTHROPIC_API_KEY', label: 'Anthropic' },
  { env: 'GROQ_API_KEY', label: 'Groq' },
  { env: 'CEREBRAS_API_KEY', label: 'Cerebras' },
  { env: 'GOOGLE_AI_API_KEY', label: 'Google AI' },
  { env: 'OPENROUTER_API_KEY', label: 'OpenRouter' },
];

// ── Helpers ──────────────────────────────────────────────────────────────

async function httpCheck(url, timeoutMs = 3000) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: null };
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

// ── Checks ───────────────────────────────────────────────────────────────

function checkNodeVersion() {
  const current = process.version;
  const major = parseInt(current.slice(1), 10);
  if (major >= 20) {
    return { status: 'pass', message: `Node.js ${current} (>= 20.0.0 required)` };
  }
  return { status: 'fail', message: `Node.js ${current} — version 20+ required` };
}

async function checkServer() {
  const result = await httpCheck(`http://127.0.0.1:${API_PORT}/healthz`);
  if (result.ok) {
    return { status: 'pass', message: `Server running on port ${API_PORT}` };
  }
  return { status: 'fail', message: `Server not reachable on port ${API_PORT} — run 'torque start'` };
}

async function checkDashboard() {
  const result = await httpCheck(`http://127.0.0.1:${DASHBOARD_PORT}/`);
  if (result.ok) {
    return { status: 'pass', message: `Dashboard available on port ${DASHBOARD_PORT}` };
  }
  return { status: 'fail', message: `Dashboard not reachable on port ${DASHBOARD_PORT}` };
}

async function checkSse() {
  // SSE endpoint returns a stream — we just check it connects (won't be 200 JSON)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`http://127.0.0.1:${SSE_PORT}/sse`, { signal: controller.signal });
    clearTimeout(timeout);
    // SSE returns 200 with text/event-stream content type
    if (res.ok || res.status === 200) {
      // Abort the body stream — we don't need to consume it
      try { res.body?.cancel(); } catch { /* ignore */ }
      return { status: 'pass', message: `MCP SSE endpoint on port ${SSE_PORT}` };
    }
    return { status: 'fail', message: `MCP SSE endpoint returned ${res.status} on port ${SSE_PORT}` };
  } catch {
    return { status: 'fail', message: `MCP SSE endpoint not reachable on port ${SSE_PORT}` };
  }
}

async function checkOllama() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      return { status: 'fail', message: `Ollama at ${OLLAMA_HOST} returned ${res.status}` };
    }
    const data = await res.json();
    const models = (data.models || []).map(m => m.name);
    if (models.length === 0) {
      return { status: 'fail', message: `Ollama at ${OLLAMA_HOST} — no models pulled` };
    }
    return { status: 'pass', message: `Ollama at ${OLLAMA_HOST} — ${models.length} model(s) available` };
  } catch {
    return { status: 'info', message: `Ollama not detected at ${OLLAMA_HOST} (optional)` };
  }
}

function checkCliTools() {
  const results = [];
  const codexPath = findCliTool('codex');
  if (codexPath) {
    results.push({ status: 'info', message: `codex CLI found at ${codexPath}` });
  } else {
    results.push({ status: 'info', message: 'codex CLI not found (optional)' });
  }

  const claudePath = findCliTool('claude');
  if (claudePath) {
    results.push({ status: 'info', message: `claude CLI found at ${claudePath}` });
  } else {
    results.push({ status: 'info', message: 'claude CLI not found (optional)' });
  }
  return results;
}

function checkApiKeys() {
  const results = [];
  for (const key of API_KEYS) {
    if (process.env[key.env]) {
      results.push({ status: 'info', message: `${key.env} set (${key.label})` });
    } else {
      results.push({ status: 'info', message: `${key.env} not set (${key.label}, optional)` });
    }
  }
  return results;
}

function checkMcpJson() {
  const mcpPath = path.join(process.cwd(), '.mcp.json');
  if (fs.existsSync(mcpPath)) {
    return { status: 'pass', message: '.mcp.json found in current directory' };
  }
  return { status: 'fail', message: ".mcp.json not found — run 'torque init' to generate" };
}

// ── Runner ───────────────────────────────────────────────────────────────

const STATUS_LABELS = {
  pass: '[pass]',
  fail: '[FAIL]',
  info: '[info]',
};

async function run() {
  console.log('TORQUE Doctor\n');

  const results = [];

  // 1. Node version (sync)
  results.push(checkNodeVersion());

  // 2-5. Server, dashboard, SSE, Ollama (async, run in parallel)
  const [server, dashboard, sse, ollama] = await Promise.all([
    checkServer(),
    checkDashboard(),
    checkSse(),
    checkOllama(),
  ]);
  results.push(server, dashboard, sse, ollama);

  // 6. CLI tools (sync)
  results.push(...checkCliTools());

  // 7. API keys (sync)
  results.push(...checkApiKeys());

  // 8. .mcp.json (sync)
  results.push(checkMcpJson());

  // Print results
  for (const r of results) {
    console.log(`  ${STATUS_LABELS[r.status]}  ${r.message}`);
  }

  // Summary
  const passed = results.filter(r => r.status === 'pass').length;
  const failed = results.filter(r => r.status === 'fail').length;
  const info = results.filter(r => r.status === 'info').length;
  console.log(`\n  ${passed} passed, ${failed} failed, ${info} info`);

  return failed > 0 ? 1 : 0;
}

module.exports = { run };
