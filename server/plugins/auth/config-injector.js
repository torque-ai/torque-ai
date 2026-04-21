'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const MCP_CONFIG_FILENAME = '.mcp.json';
const CLAUDE_DIR_NAME = '.claude';
const KEY_FILENAME = '.torque-api-key';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_SSE_PORT = 3458;
const DESCRIPTION = 'TORQUE - Task Orchestration System (enterprise auth)';
// server/index.js owns the `torque` MCP entry (streamable-http). The auth
// plugin owns `torque-auth` (keyed SSE) so the two injectors never clobber
// each other in the shared ~/.claude/.mcp.json file.
const MCP_SERVER_KEY = 'torque-auth';

function createConfigInjector({ logger } = {}) {
  const safeLogger = logger || { info() {} };

  function readKeyFromFile(dataDir) {
    const keyPath = path.join(dataDir, KEY_FILENAME);
    try {
      return fs.readFileSync(keyPath, 'utf-8').trim() || null;
    } catch {
      return null;
    }
  }

  function ensureGlobalMcpConfig(apiKey, options = {}) {
    const { ssePort = DEFAULT_SSE_PORT, host = DEFAULT_HOST, homeDir } = options;
    const key = typeof apiKey === 'string' ? apiKey.trim() : '';

    const home = homeDir || os.homedir();
    const claudeDir = path.join(home, CLAUDE_DIR_NAME);
    const configPath = path.join(claudeDir, MCP_CONFIG_FILENAME);

    if (!key) {
      return { injected: false, path: configPath, reason: 'no_key' };
    }

    const expectedUrl = `http://${host}:${ssePort}/sse?apiKey=${key}`;
    const keylessSseUrl = `http://${host}:${ssePort}/sse`;

    try {
      fs.mkdirSync(claudeDir, { recursive: true });

      let data = { mcpServers: {} };
      try {
        const raw = fs.readFileSync(configPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          data = parsed;
        }
        if (!data || typeof data !== 'object') {
          data = { mcpServers: {} };
        }
        if (!data.mcpServers || typeof data.mcpServers !== 'object') {
          data.mcpServers = {};
        }
      } catch (err) {
        if (err.code !== 'ENOENT') {
          safeLogger.info(`[MCP Config] Cannot read/parse ${configPath}: ${err.message} — skipping injection`);
          return { injected: false, path: configPath, reason: 'parse_error' };
        }
      }

      const legacy = data.mcpServers['torque-sse'];
      if (legacy && legacy.type === 'sse' && legacy.url === keylessSseUrl) {
        return { injected: false, path: configPath, reason: 'keyless_sse_present' };
      }

      const existing = data.mcpServers[MCP_SERVER_KEY];
      if (existing && existing.url === expectedUrl) {
        return { injected: false, path: configPath, reason: 'already_current' };
      }

      data.mcpServers[MCP_SERVER_KEY] = {
        ...(existing || {}),
        type: 'sse',
        url: expectedUrl,
        description: existing && existing.description ? existing.description : DESCRIPTION,
      };

      const tmpPath = `${configPath}.tmp.${Date.now()}.${process.pid}`;
      const content = `${JSON.stringify(data, null, 2)}\n`;
      fs.writeFileSync(tmpPath, content, { mode: 0o600 });
      fs.renameSync(tmpPath, configPath);

      if (process.platform === 'win32') {
        try {
          execFileSync('icacls', [
            configPath,
            '/inheritance:r',
            '/grant:r',
            `${process.env.USERNAME}:(F)`,
          ], {
            stdio: 'pipe',
            windowsHide: true,
          });
        } catch {
          // best effort
        }
      }

      const reason = existing ? 'updated' : 'created';
      safeLogger.info(`[MCP Config] Injected TORQUE entry into ${configPath} (${reason})`);

      return { injected: true, path: configPath, reason };
    } catch (err) {
      safeLogger.info(`[MCP Config] Injection failed: ${err.message}`);
      return { injected: false, path: configPath, reason: `error: ${err.message}` };
    }
  }

  return { readKeyFromFile, ensureGlobalMcpConfig };
}

module.exports = { createConfigInjector };
