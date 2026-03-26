'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const logger = require('../logger').child({ component: 'mcp-config-injector' });

const MCP_CONFIG_FILENAME = '.mcp.json';
const CLAUDE_DIR_NAME = '.claude';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_SSE_PORT = 3458;
const DESCRIPTION = 'TORQUE - Task Orchestration System with local LLM routing';

function ensureGlobalMcpConfig(options = {}) {
  const { ssePort = DEFAULT_SSE_PORT, host = DEFAULT_HOST, homeDir } = options;
  const home = homeDir || os.homedir();
  const claudeDir = path.join(home, CLAUDE_DIR_NAME);
  const configPath = path.join(claudeDir, MCP_CONFIG_FILENAME);
  const expectedUrl = `http://${host}:${ssePort}/sse`;

  try {
    fs.mkdirSync(claudeDir, { recursive: true });
    let data = { mcpServers: {} };
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      data = JSON.parse(raw);
      if (!data || typeof data !== 'object') data = { mcpServers: {} };
      if (!data.mcpServers || typeof data.mcpServers !== 'object') data.mcpServers = {};
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.info(`[MCP Config] Cannot parse ${configPath}: ${err.message}`);
        return { injected: false, path: configPath, reason: 'parse_error' };
      }
    }
    const existing = data.mcpServers.torque;
    if (existing && existing.url === expectedUrl) {
      return { injected: false, path: configPath, reason: 'already_current' };
    }
    data.mcpServers.torque = { ...(existing || {}), type: 'sse', url: expectedUrl, description: DESCRIPTION };
    const tmpPath = configPath + '.tmp.' + process.pid;
    const content = JSON.stringify(data, null, 2) + '\n';
    fs.writeFileSync(tmpPath, content, { mode: 0o600 });
    fs.renameSync(tmpPath, configPath);
    if (process.platform === 'win32') {
      try {
        const { execFileSync } = require('child_process');
        execFileSync('icacls', [configPath, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:(F)`], { stdio: 'pipe', windowsHide: true });
      } catch {}
    }
    const reason = existing ? 'updated' : 'created';
    return { injected: true, path: configPath, reason };
  } catch (err) {
    return { injected: false, path: configPath, reason: `error: ${err.message}` };
  }
}

module.exports = { ensureGlobalMcpConfig };
