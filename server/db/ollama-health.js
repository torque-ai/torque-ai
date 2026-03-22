// Extracted from provider-routing-core.js — Ollama Health Check / Auto-Start / WSL2
'use strict';

const path = require('path');
const fs = require('fs');
const logger = require('../logger').child({ component: 'ollama-health' });

// Health check timeout for Ollama connectivity probe (matches constants.js TASK_TIMEOUTS.HEALTH_CHECK)
const OLLAMA_HEALTH_CHECK_TIMEOUT_MS = 5000;

// These are set by the parent module via init()
let _deps = null;

/**
 * Initialize this module with dependencies from provider-routing-core.
 * Must be called before any exported function is used.
 * @param {object} deps
 * @param {function} deps.getDatabaseConfig
 * @param {function} deps.setConfig
 * @param {function} deps.getHostManagementFns - returns current hostManagementFns
 */
function init(deps) {
  _deps = deps;
}

// ============================================================
// Ollama Health Check / Auto-Start / WSL2
// ============================================================

// Ollama health check cache
const ollamaHealthCache = {
  healthy: null,
  checkedAt: null,
  cacheDurationMs: 30000  // Cache for 30 seconds
};

// Prevent concurrent auto-start attempts
let ollamaAutoStartInProgress = false;

/**
 * Detect if running in WSL2 and get the Windows host IP
 * @returns {string|null} Windows host IP or null if not in WSL2
 */
function detectWSL2HostIP() {
  const { execFileSync } = require('child_process');

  // Check if we're in WSL
  try {

    const procVersion = fs.readFileSync('/proc/version', 'utf8');
    if (!procVersion.toLowerCase().includes('microsoft')) {
      return null; // Not WSL
    }
  } catch {
    return null; // Can't read /proc/version, not Linux
  }

  // Get the default gateway IP using ip command with safe arguments
  try {
    const routeOutput = execFileSync('ip', ['route'], { encoding: 'utf8' });
    const lines = routeOutput.split('\n');
    for (const line of lines) {
      if (line.startsWith('default via')) {
        const parts = line.split(' ');
        const idx = parts.indexOf('via');
        if (idx !== -1 && parts[idx + 1]) {
          const hostIP = parts[idx + 1];
          if (/^\d+\.\d+\.\d+\.\d+$/.test(hostIP)) {
            return hostIP;
          }
        }
      }
    }
  } catch (e) {
    logger.warn('[Ollama] Failed to detect WSL2 host IP:', e.message);
  }

  return null;
}

/**
 * Find the Ollama binary, checking common locations and WSL/Windows paths
 * @returns {string|null} Path to Ollama binary or null if not found
 */
function findOllamaBinary() {
  const getDatabaseConfig = _deps.getDatabaseConfig;

  // Check configured path first
  const configuredPath = getDatabaseConfig('ollama_binary_path');
  if (configuredPath && fs.existsSync(configuredPath)) {
    try {
      const stats = fs.statSync(configuredPath);
      if (stats.size > 1000) { // Real binary, not a placeholder
        return configuredPath;
      }
    } catch {
      // Continue to other paths
    }
  }

  const homeDir = process.env.HOME || process.env.USERPROFILE || '';

  // Common paths to check (Linux/Mac)
  const linuxPaths = [
    '/usr/local/bin/ollama',
    '/usr/bin/ollama',
    path.join(homeDir, '.local/bin/ollama'),
    '/opt/ollama/ollama'
  ];

  // Check Linux paths
  for (const p of linuxPaths) {
    if (fs.existsSync(p)) {
      try {
        const stats = fs.statSync(p);
        if (stats.size > 1000) { // Real binary, not a placeholder
          return p;
        }
      } catch {
        continue;
      }
    }
  }

  // Check Windows paths via glob (safe since we control the pattern)
  const windowsPatterns = [
    ['/mnt/c/Users', 'AppData/Local/Programs/Ollama/ollama.exe'],
    ['/mnt/c/Program Files/Ollama', 'ollama.exe']
  ];

  for (const [baseDir, subPath] of windowsPatterns) {
    try {
      if (fs.existsSync(baseDir)) {
        const entries = fs.readdirSync(baseDir);
        for (const entry of entries) {
          const fullPath = path.join(baseDir, entry, subPath);
          if (fs.existsSync(fullPath)) {
            const stats = fs.statSync(fullPath);
            if (stats.size > 1000) {
              return fullPath;
            }
          }
        }
      }
    } catch {
      continue;
    }
  }

  // Also check direct Program Files path
  const programFilesPath = '/mnt/c/Program Files/Ollama/ollama.exe';
  if (fs.existsSync(programFilesPath)) {
    try {
      const stats = fs.statSync(programFilesPath);
      if (stats.size > 1000) {
        return programFilesPath;
      }
    } catch {
      // Continue
    }
  }

  return null;
}

/**
 * Wait for Ollama to become ready by polling the API
 * @param {number} timeoutMs Maximum time to wait
 * @returns {Promise<boolean>} True if Ollama became ready
 */
async function waitForOllamaReady(timeoutMs) {
  const http = require('http');
  const https = require('https');
  const getDatabaseConfig = _deps.getDatabaseConfig;
  const startTime = Date.now();
  const pollInterval = 2000; // Check every 2s

  const ollamaHost = getDatabaseConfig('ollama_host') || 'http://localhost:11434';
  const url = new URL('/api/tags', ollamaHost);
  const client = url.protocol === 'https:' ? https : http;

  while (Date.now() - startTime < timeoutMs) {
    const isReady = await new Promise((resolve) => {
      const req = client.get(url.toString(), { timeout: 2000 }, (res) => {
        // CRITICAL: Must consume response body to prevent memory leak
        // Without this, response data accumulates in memory
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });

    if (isReady) {
      return true;
    }

    // Wait before next poll
    await new Promise(r => setTimeout(r, pollInterval));
  }

  return false;
}

/**
 * Attempt to start Ollama service
 * @param {void} _ - No parameters.
 * @returns {Promise<boolean>} True if Ollama was started successfully
 */
async function attemptOllamaStart() {
  const getDatabaseConfig = _deps.getDatabaseConfig;
  const setConfig = _deps.setConfig;

  if (ollamaAutoStartInProgress) {
    logger.warn('[Ollama] Auto-start already in progress');
    return false;
  }

  const autoStartEnabled = getDatabaseConfig('ollama_auto_start_enabled') === '1';
  if (!autoStartEnabled) {
    return false;
  }

  ollamaAutoStartInProgress = true;

  try {
    const { spawn, execFileSync } = require('child_process');

    // Check if we're in WSL and Ollama is on Windows
    const wslHostIP = detectWSL2HostIP();
    const binaryPath = findOllamaBinary();

    if (wslHostIP && binaryPath && binaryPath.includes('/mnt/c/')) {
      // Ollama is on Windows - try to start it via Windows
      logger.info('[Ollama] Detected Windows Ollama in WSL2 environment');

      // Convert WSL path to Windows path and start
      const winPath = binaryPath.replace(/^\/mnt\/([a-z])\//, '$1:\\').replace(/\//g, '\\');

      try {
        // Start Ollama on Windows using cmd.exe with safe arguments
        execFileSync('cmd.exe', ['/c', 'start', '""', winPath, 'serve'], {
          stdio: 'ignore',
          windowsHide: true
        });
        logger.info('[Ollama] Started Windows Ollama');
      } catch (e) {
        logger.error('[Ollama] Failed to start Windows Ollama:', e.message);
        return false;
      }

      // Update host to use Windows IP
      const currentHost = getDatabaseConfig('ollama_host') || 'http://localhost:11434';
      if (currentHost.includes('localhost') || currentHost.includes('127.0.0.1')) {
        const newHost = `http://${wslHostIP}:11434`;
        setConfig('ollama_host', newHost);
        logger.info(`[Ollama] Updated host for WSL2: ${newHost}`);
      }
    } else if (binaryPath && !binaryPath.includes('/mnt/c/')) {
      // Native Linux Ollama
      logger.info(`[Ollama] Starting native Ollama: ${binaryPath}`);

      const child = spawn(binaryPath, ['serve'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.unref();
    } else {
      logger.warn('[Ollama] No Ollama binary found');
      return false;
    }

    // Wait for Ollama to be ready
    const timeoutMs = parseInt(getDatabaseConfig('ollama_auto_start_timeout_ms') || '15000', 10);
    logger.info(`[Ollama] Waiting up to ${timeoutMs}ms for Ollama to start...`);

    const isReady = await waitForOllamaReady(timeoutMs);

    if (isReady) {
      logger.info('[Ollama] Successfully started and ready');
      ollamaHealthCache.healthy = true;
      ollamaHealthCache.checkedAt = Date.now();
      return true;
    } else {
      logger.warn('[Ollama] Start timeout - Ollama did not become ready');
      return false;
    }
  } catch (error) {
    logger.error('[Ollama] Auto-start failed:', error.message);
    return false;
  } finally {
    ollamaAutoStartInProgress = false;
  }
}

/**
 * Auto-detect and configure WSL2 host if enabled
 * @param {void} _ - No parameters.
 * @returns {boolean} True when host settings were updated.
 */
function autoConfigureWSL2Host() {
  const getDatabaseConfig = _deps.getDatabaseConfig;
  const setConfig = _deps.setConfig;

  const autoDetect = getDatabaseConfig('ollama_auto_detect_wsl_host');
  // Default to enabled if not set
  if (autoDetect !== '0') {
    const wslHostIP = detectWSL2HostIP();
    if (wslHostIP) {
      const currentHost = getDatabaseConfig('ollama_host') || 'http://localhost:11434';
      if (currentHost.includes('localhost') || currentHost.includes('127.0.0.1')) {
        const newHost = `http://${wslHostIP}:11434`;
        setConfig('ollama_host', newHost);
        logger.info(`[Ollama] Auto-configured WSL2 host: ${newHost}`);
        return true;
      }
    }
  }
  return false;
}

/**
 * Check if Ollama is reachable (with caching and auto-start support)
 */
async function checkOllamaHealth(forceCheck = false) {
  const getDatabaseConfig = _deps.getDatabaseConfig;
  const now = Date.now();

  // Return cached result if still valid
  if (!forceCheck && ollamaHealthCache.checkedAt &&
      (now - ollamaHealthCache.checkedAt) < ollamaHealthCache.cacheDurationMs) {
    return ollamaHealthCache.healthy;
  }

  // Auto-detect WSL2 host on first check
  autoConfigureWSL2Host();

  const ollamaHost = getDatabaseConfig('ollama_host') || 'http://localhost:11434';
  const http = require('http');
  const https = require('https');
  const url = new URL('/api/tags', ollamaHost);
  const client = url.protocol === 'https:' ? https : http;

  const healthCheckTimeout = OLLAMA_HEALTH_CHECK_TIMEOUT_MS;

  // First attempt to connect
  const isHealthy = await new Promise((resolve) => {
    const req = client.get(url.toString(), { timeout: healthCheckTimeout }, (res) => {
      // CRITICAL: Must consume response body to prevent memory leak
      res.resume();
      resolve(res.statusCode === 200);
    });

    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });

  if (isHealthy) {
    ollamaHealthCache.healthy = true;
    ollamaHealthCache.checkedAt = now;
    return true;
  }

  // Not healthy - try auto-start if enabled
  const autoStartEnabled = getDatabaseConfig('ollama_auto_start_enabled') === '1';
  if (autoStartEnabled && !ollamaAutoStartInProgress) {
    logger.warn('[Ollama] Health check failed, attempting auto-start...');
    const started = await attemptOllamaStart();
    if (started) {
      return true; // attemptOllamaStart updates the cache
    }
  }

  // Still not healthy
  ollamaHealthCache.healthy = false;
  ollamaHealthCache.checkedAt = now;
  return false;
}

/**
 * Synchronous check using cached Ollama health status
 * @returns {any}
 */
function isOllamaHealthy() {
  const hostManagementFns = _deps.getHostManagementFns();

  // If we have a recent check, use it
  if (ollamaHealthCache.checkedAt &&
      (Date.now() - ollamaHealthCache.checkedAt) < ollamaHealthCache.cacheDurationMs) {
    return ollamaHealthCache.healthy;
  }

  // In multi-host mode, check if any hosts are marked healthy
  if (hostManagementFns) {
    const hosts = hostManagementFns?.listOllamaHosts?.() || [];
    if (!Array.isArray(hosts)) return false;
    if (hosts.length > 0) {
      const healthyHosts = hosts.filter(h => h.enabled && h.status === 'healthy');
      if (healthyHosts.length > 0) {
        // Found healthy hosts - update cache and return true
        ollamaHealthCache.healthy = true;
        ollamaHealthCache.checkedAt = Date.now();
        return true;
      }
    }
  }

  // If no recent check, assume healthy and let async check update
  return null;  // Unknown
}

/**
 * Clear Ollama health cache (call when Ollama task fails)
 * @returns {any}
 */
function invalidateOllamaHealth() {
  ollamaHealthCache.healthy = false;
  ollamaHealthCache.checkedAt = Date.now();
}

/**
 * Set Ollama health cache status (call from multi-host health checks)
 * @param {boolean} healthy - Whether Ollama is healthy
 * @returns {any}
 */
function setOllamaHealthy(healthy) {
  ollamaHealthCache.healthy = healthy;
  ollamaHealthCache.checkedAt = Date.now();
}

/**
 * Check if any healthy Ollama host has available capacity.
 * Delegates to host-management module via dependency injection.
 * @returns {boolean}
 */
function hasHealthyOllamaHost() {
  const hostManagementFns = _deps.getHostManagementFns();
  if (!hostManagementFns || !hostManagementFns.hasHealthyOllamaHost) {
    return false;
  }
  return hostManagementFns.hasHealthyOllamaHost();
}

module.exports = {
  init,
  OLLAMA_HEALTH_CHECK_TIMEOUT_MS,
  detectWSL2HostIP,
  findOllamaBinary,
  waitForOllamaReady,
  attemptOllamaStart,
  autoConfigureWSL2Host,
  checkOllamaHealth,
  isOllamaHealthy,
  invalidateOllamaHealth,
  setOllamaHealthy,
  hasHealthyOllamaHost,
};
