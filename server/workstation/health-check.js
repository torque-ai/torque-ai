'use strict';

const http = require('node:http');
const https = require('node:https');
const { safeJsonParse } = require('../utils/json');

/**
 * Capability-aware workstation health check.
 *
 * Strategy:
 *  1. If the workstation has 'ollama' capability → hit Ollama API on ollama_port
 *  2. If the workstation has 'command_exec' or an agent port → hit agent-server /health
 *  3. Agent-server response provides system stats (platform, memory, etc.)
 *  4. Workstation is healthy if ANY strategy succeeds
 */

function fetchJson(url, timeoutMs, headers = {}) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      timeout: timeoutMs,
      headers,
    };
    const req = proto.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error('Invalid JSON'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
    req.end();
  });
}

/**
 * Check Ollama API at /api/tags to discover models.
 * @param {string} host
 * @param {number} port
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<{healthy: boolean, models: string[]}>}
 */
async function checkOllama(host, port, timeoutMs = 5000) {
  const url = `http://${host}:${port}/api/tags`;
  const data = await fetchJson(url, timeoutMs);
  const models = (data.models || [])
    .map(m => m.name || m.model)
    .filter(Boolean);
  return { healthy: true, models };
}

/**
 * Check agent-server at /health with authentication.
 * Extracts system stats (platform, memory) from the response.
 * @param {string} host
 * @param {number} port
 * @param {string} [secret]
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<{healthy: boolean, system: object|null}>}
 */
async function checkAgentServer(host, port, secret, timeoutMs = 5000) {
  const url = `http://${host}:${port}/health`;
  const headers = {};
  if (secret) {
    headers['X-Torque-Secret'] = secret;
  }
  const data = await fetchJson(url, timeoutMs, headers);
  const status = data.status === 'ok' || data.status === 'healthy';
  return {
    healthy: status,
    system: data.system || null,
  };
}

/**
 * Run a multi-strategy health check on a workstation.
 *
 * @param {object} ws - Workstation record (from model.getWorkstation or listWorkstations)
 * @returns {Promise<{healthy: boolean, models: string[]|null, system: object|null, source: string}>}
 */
async function checkWorkstation(ws) {
  if (!ws) return { healthy: false, models: null, system: null, source: 'none' };

  const caps = ws._capabilities || safeJsonParse(ws.capabilities, {});
  const hasOllama = caps.ollama && (caps.ollama === true || caps.ollama.detected);
  const ollamaPort = (caps.ollama && caps.ollama.port) || ws.ollama_port || 11434;

  let ollamaResult = null;
  let agentResult = null;

  // Strategy 1: check Ollama API directly
  if (hasOllama) {
    try {
      ollamaResult = await checkOllama(ws.host, ollamaPort);
    } catch {
      ollamaResult = null;
    }
  }

  // Strategy 2: check agent-server for system stats
  if (ws.agent_port) {
    try {
      agentResult = await checkAgentServer(ws.host, ws.agent_port, ws.secret);
    } catch {
      agentResult = null;
    }
  }

  // Merge results — healthy if either check passed
  const healthy = (ollamaResult && ollamaResult.healthy) || (agentResult && agentResult.healthy) || false;
  const models = ollamaResult ? ollamaResult.models : null;
  const system = agentResult ? agentResult.system : null;

  let source = 'none';
  if (ollamaResult && agentResult) source = 'ollama+agent';
  else if (ollamaResult) source = 'ollama';
  else if (agentResult) source = 'agent';

  return { healthy, models, system, source };
}

module.exports = {
  checkWorkstation,
  checkOllama,
  checkAgentServer,
  fetchJson,
};
