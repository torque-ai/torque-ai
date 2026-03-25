'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const logger = require('../logger').child({ component: 'mcp-config-injector' });

const MCP_CONFIG_FILENAME = '.mcp.json';
const CLAUDE_DIR_NAME = '.claude';
const KEY_FILENAME = '.torque-api-key';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_SSE_PORT = 3458;
const DESCRIPTION = 'TORQUE - Task Orchestration System with local LLM routing';

function readKeyFromFile(dataDir) {
  const keyPath = path.join(dataDir, KEY_FILENAME);
  try {
    return fs.readFileSync(keyPath, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

function ensureGlobalMcpConfig(apiKey, options = {}) {
  const {
    ssePort = DEFAULT_SSE_PORT,
    host = DEFAULT_HOST,
    homeDir,
  } = options;

  const home = homeDir || os.homedir();
  const claudeDir = path.join(home, CLAUDE_DIR_NAME);
  const configPath = path.join(claudeDir, MCP_CONFIG_FILENAME);

  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    return { injected: false, path: configPath, reason: 'no_key' };
  }

  const expectedUrl = `http://${host}:${ssePort}/sse?apiKey=${apiKey}`;

  try {
    fs.mkdirSync(claudeDir, { recursive: true });

    let data = { mcpServers: {} };
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      data = JSON.parse(raw);
      if (!data || typeof data !== 'object') {
        data = { mcpServers: {} };
      }
      if (!data.mcpServers || typeof data.mcpServers !== 'object') {
        data.mcpServers = {};
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.info(`[MCP Config] Cannot read/parse ${configPath}: ${err.message} — skipping injection`);
        return { injected: false, path: configPath, reason: 'parse_error' };
      }
    }

    const existing = data.mcpServers.torque;
    if (existing && existing.url === expectedUrl) {
      return { injected: false, path: configPath, reason: 'already_current' };
    }

    data.mcpServers.torque = {
      ...(existing || {}),
      type: 'sse',
      url: expectedUrl,
      description: DESCRIPTION,
    };

    const tmpPath = configPath + '.tmp.' + process.pid;
    const content = JSON.stringify(data, null, 2) + '\n';
    fs.writeFileSync(tmpPath, content, { mode: 0o600 });
    fs.renameSync(tmpPath, configPath);

    if (process.platform === 'win32') {
      try {
        const { execFileSync } = require('child_process');
        execFileSync('icacls', [
          configPath, '/inheritance:r', '/grant:r',
          `${process.env.USERNAME}:(F)`,
        ], { stdio: 'pipe', windowsHide: true });
      } catch { /* best-effort */ }
    }

    const reason = existing ? 'updated' : 'created';
    logger.info(`[MCP Config] Injected TORQUE entry into ${configPath} (${reason})`);
    return { injected: true, path: configPath, reason };
  } catch (err) {
    logger.info(`[MCP Config] Injection failed: ${err.message}`);
    return { injected: false, path: configPath, reason: `error: ${err.message}` };
  }
}

module.exports = { ensureGlobalMcpConfig, readKeyFromFile };
