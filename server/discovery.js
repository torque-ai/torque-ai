/**
 * Ollama LAN Discovery Module
 * Uses mDNS/Bonjour for automatic discovery of Ollama hosts on the network
 */

const os = require('os');
const { execSync } = require('child_process');
const Bonjour = require('bonjour-service').Bonjour;
const logger = require('./logger').child({ component: 'discovery' });

const PRIVATE_172_RANGE_REGEX = /^172\.(1[6-9]|2[0-9]|3[01])\./;
const BONJOUR_NAME_COLLISION_MESSAGE = 'Service name is already in use on the network';

/**
 * Check whether an IPv4 address is private and usable for LAN discovery.
 * @param {string} address - IPv4 address to check
 * @param {boolean} allowAny192 - When true, treat any 192.x.x.x as private
 * @returns {boolean}
 */
function isPrivateIP(address, allowAny192 = false) {
  if (typeof address !== 'string') {
    return false;
  }

  return (allowAny192 ? address.startsWith('192.') : address.startsWith('192.168.')) ||
    address.startsWith('10.') ||
    PRIVATE_172_RANGE_REGEX.test(address);
}

// Cache for LAN IP detection
let cachedLanIP = null;

// Lazy-load db sub-modules to avoid circular dependencies
let _configCore = null;
let _hostManagement = null;
function getConfigCore() {
  if (!_configCore) {
    _configCore = require('./db/config-core');
  }
  return _configCore;
}
function getHostManagement() {
  if (!_hostManagement) {
    _hostManagement = require('./db/host-management');
  }
  return _hostManagement;
}

// Module state
let bonjour = null;
let browser = null;
let advertiser = null;
let isInitialized = false;
let restoreBonjourCollisionLogFilter = null;

// Auto-scan state
let autoScanInterval = null;
let lastKnownSubnets = [];

// Service type for Ollama discovery
const SERVICE_TYPE = 'ollama';

function isBonjourCollisionLog(args) {
  if (args.length !== 1 || !(args[0] instanceof Error)) {
    return false;
  }

  const [err] = args;
  return err.message === BONJOUR_NAME_COLLISION_MESSAGE &&
    typeof err.stack === 'string' &&
    err.stack.includes('bonjour-service');
}

function ensureBonjourCollisionLogFilter() {
  if (restoreBonjourCollisionLogFilter) {
    return;
  }

  const originalConsoleLog = console.log;
  function filteredConsoleLog(...args) {
    if (isBonjourCollisionLog(args)) {
      logger.debug(`[Discovery] Bonjour advertiser collision: ${args[0].message}`);
      return;
    }
    return originalConsoleLog.apply(this, args);
  }

  console.log = filteredConsoleLog;
  restoreBonjourCollisionLogFilter = () => {
    if (console.log === filteredConsoleLog) {
      console.log = originalConsoleLog;
    }
    restoreBonjourCollisionLogFilter = null;
  };
}

function clearBonjourCollisionLogFilter() {
  if (restoreBonjourCollisionLogFilter) {
    restoreBonjourCollisionLogFilter();
  }
}

/**
 * Initialize discovery - start advertising and browsing
 */
function initDiscovery() {
  const configDb = getConfigCore();

  // Check if discovery is enabled
  if (configDb.getConfig('discovery_enabled') === '0') {
    logger.info('[Discovery] Disabled by configuration');
    return { success: false, reason: 'Discovery disabled' };
  }

  if (isInitialized) {
    logger.info('[Discovery] Already initialized');
    return { success: false, reason: 'Already initialized' };
  }

  try {
    bonjour = new Bonjour();
    isInitialized = true;

    // Start advertising local Ollama if enabled and healthy
    if (configDb.getConfig('discovery_advertise') === '1') {
      startAdvertising();
    }

    // Start browsing for other hosts if enabled
    if (configDb.getConfig('discovery_browse') !== '0') {
      startBrowsing();
    }

    logger.info('[Discovery] Initialized successfully');
    return { success: true };
  } catch (err) {
    logger.info(`[Discovery] Failed to initialize: ${err.message}`);
    return { success: false, reason: err.message };
  }
}

/**
 * Start advertising local Ollama instance
 */
function startAdvertising() {
  const configDb = getConfigCore();
  const hostDb = getHostManagement();

  if (!bonjour) {
    logger.info('[Discovery] Cannot advertise - not initialized');
    return false;
  }

  if (advertiser) {
    logger.info('[Discovery] Already advertising');
    return false;
  }

  // Get local Ollama configuration
  const ollamaHost = configDb.getConfig('ollama_host') || 'http://localhost:11434';

  try {
    const configUrl = new URL(ollamaHost);
    const port = parseInt(configUrl.port, 10) || 11434;
    const hostname = os.hostname();

    // Detect LAN IP for advertising (not the WSL2 internal IP)
    const lanIP = getLanIP();
    const advertisedUrl = lanIP ? `http://${lanIP}:${port}` : ollamaHost;

    // Get models from local Ollama if available
    let models = '';
    const hosts = hostDb.listOllamaHosts();
    const localHost = hosts.find(h => h.url === ollamaHost);
    if (localHost && localHost.models_cache) {
      try {
        const modelList = JSON.parse(localHost.models_cache);
        models = modelList.map(m => m.name || m).join(',');
      } catch {
        // Ignore parse errors
      }
    }

    // bonjour-service logs name collisions directly to console.log during probing.
    // Filter only that specific case so test output stays quiet.
    ensureBonjourCollisionLogFilter();
    advertiser = bonjour.publish({
      name: `${hostname}-ollama-${port}`,
      type: SERVICE_TYPE,
      port: port,
      txt: {
        id: `${hostname}-${port}`,
        name: `${hostname} Ollama`,
        url: advertisedUrl,
        models: models
      }
    });

    logger.info(`[Discovery] Advertising local Ollama at ${advertisedUrl} (config: ${ollamaHost})`);
    return true;
  } catch (err) {
    clearBonjourCollisionLogFilter();
    logger.info(`[Discovery] Failed to start advertising: ${err.message}`);
    return false;
  }
}

/**
 * Stop advertising
 */
function stopAdvertising() {
  if (advertiser) {
    try {
      advertiser.stop();
      advertiser = null;
      clearBonjourCollisionLogFilter();
      logger.info('[Discovery] Stopped advertising');
    } catch (err) {
      clearBonjourCollisionLogFilter();
      logger.info(`[Discovery] Error stopping advertiser: ${err.message}`);
    }
  }
}

/**
 * Start browsing for Ollama services on the network
 */
/**
 * Start browsing for Ollama services on the network
 * @returns {boolean} True if browsing started successfully
 */
function startBrowsing() {
  if (!bonjour) {
    logger.info('[Discovery] Cannot browse - not initialized');
    return false;
  }

  if (browser) {
    logger.info('[Discovery] Already browsing');
    return false;
  }

  try {
    browser = bonjour.find({ type: SERVICE_TYPE });

    browser.on('up', (service) => {
      handleServiceFound(service);
    });

    browser.on('down', (service) => {
      handleServiceLost(service);
    });

    logger.info('[Discovery] Started browsing for Ollama services');
    return true;
  } catch (err) {
    logger.info(`[Discovery] Failed to start browsing: ${err.message}`);
    return false;
  }
}

/**
 * Resolve the advertised Ollama URL for a discovered service.
 * Prefers the TXT record URL, but normalizes it to a stable host:port form.
 * @param {Object} service - The discovered service object
 * @returns {string|null} Normalized base URL or null when it cannot be resolved
 */
function getServiceUrl(service) {
  const txt = service.txt || {};
  const host = service.host || service.addresses?.[0];

  if (txt.url) {
    try {
      const parsed = new URL(txt.url);
      const hostname = parsed.hostname || host;
      const port = parsed.port || String(service.port || 11434);
      const pathname = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname.replace(/\/+$/, '') : '';
      if (!hostname) {
        return null;
      }
      // Note: URL fragments (#...) are intentionally dropped — they have no
      // meaning in an HTTP API base URL and would be rejected by Node's http module.
      return `${parsed.protocol || 'http:'}//${hostname}:${port}${pathname}${parsed.search || ''}`;
    } catch {
      if (!host) {
        return null;
      }
    }
  }

  if (!host) {
    return null;
  }

  return `http://${host}:${service.port || 11434}`;
}

/**
 * Derive a stable identity for a discovered service.
 * Uses the resolved URL first so multiple Ollama instances on one hostname
 * remain distinct even when older TXT ids omit the port.
 * @param {Object} service - The discovered service object
 * @param {string|null} url - Resolved service URL
 * @returns {string|null} Stable identity string
 */
function getServiceIdentity(service, url) {
  if (url) {
    try {
      const parsed = new URL(url);
      const port = parsed.port || String(service.port || 11434);
      const pathname = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname.replace(/\/+$/, '') : '';
      if (parsed.hostname) {
        return `${parsed.hostname}-${port}${pathname}`;
      }
    } catch {
      // Fall through to legacy identities.
    }
  }

  const txt = service.txt || {};
  return txt.id || service.name || null;
}

/**
 * Handle a discovered Ollama service
 */
/**
 * Handle a discovered Ollama service
 * @param {Object} service - The discovered service object
 * @returns {void}
 */
function handleServiceFound(service) {
  const configDb = getConfigCore();
  const hostDb = getHostManagement();

  try {
    // Extract service information
    const txt = service.txt || {};
    const url = getServiceUrl(service);

    if (!url) {
      logger.info(`[Discovery] Service found but no URL available: ${service.name}`);
      return;
    }

    // Skip if this is our own advertisement
    const localOllama = configDb.getConfig('ollama_host') || 'http://localhost:11434';
    if (url === localOllama || isLocalUrl(url)) {
      return;
    }

    // Check if host already exists
    const existing = hostDb.getOllamaHostByUrl(url);

    if (existing) {
      // mDNS advertisement seen — verify the host is actually reachable before marking healthy
      refreshHostModels(existing.id, url);
    } else {
      // New host discovered — only auto-add if explicitly allowed via config
      const autoAddEnabled = configDb.getConfig('discovery_auto_add') === '1';
      const identity = getServiceIdentity(service, url) || txt.id || service.name || 'ollama';
      const id = sanitizeId(`discovered-${identity}`);
      const name = txt.name || service.name || `Discovered Ollama`;

      if (!autoAddEnabled) {
        logger.info(`[Discovery] Found new host: ${name} at ${url} — NOT auto-adding (discovery_auto_add=0). Approve manually via add_ollama_host.`);
        return;
      }

      hostDb.addOllamaHost({
        id: id,
        name: name,
        url: url,
        max_concurrent: 4
      });

      logger.info(`[Discovery] Added new host: ${name} at ${url}`);

      // Try to fetch models for the new host
      refreshHostModels(id, url);

      // Probe for gpu-metrics-server companion on default port
      probeGpuMetricsServer(id, url);
    }
  } catch (err) {
    logger.info(`[Discovery] Error handling service: ${err.message}`);
  }
}

/**
 * Probe a discovered host for a gpu-metrics-server companion on port 9394.
 * If found, auto-set gpu_metrics_port on the host record.
 * @param {string} hostId - The host ID in the database
 * @param {string} hostUrl - The Ollama URL (used to extract IP)
 */
function probeGpuMetricsServer(hostId, hostUrl) {
  const DEFAULT_GPU_METRICS_PORT = 9394;
  try {
    const hostname = new URL(hostUrl).hostname;
    const http = require('http');
    const req = http.get(`http://${hostname}:${DEFAULT_GPU_METRICS_PORT}/health`, { timeout: 2000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const body = JSON.parse(data);
            if (body.status === 'ok') {
              getHostManagement().updateOllamaHost(hostId, { gpu_metrics_port: DEFAULT_GPU_METRICS_PORT });
              logger.info(`[Discovery] Auto-detected gpu-metrics-server on ${hostname}:${DEFAULT_GPU_METRICS_PORT} for host ${hostId}`);
            }
          } catch { /* not valid JSON */ }
        }
      });
    });
    req.on('error', () => { /* no metrics server — ignore */ });
    req.on('timeout', () => { req.destroy(); });
  } catch { /* ignore probe failures */ }
}

/**
 * Handle a lost Ollama service
 * @param {Object} service - The lost service object
 * @returns {void}
 */
function handleServiceLost(service) {
  const hostDb = getHostManagement();

  try {
    const url = getServiceUrl(service);

    if (!url) return;

    const existing = hostDb.getOllamaHostByUrl(url);
    if (existing) {
      const wasHealthy = existing.status === 'healthy';
      // Record a health check failure - consistent with existing behavior
      hostDb.recordHostHealthCheck(existing.id, false);
      // Only log on first transition away from healthy, not repeated offline events
      if (wasHealthy) {
        logger.info(`[Discovery] Host went offline: ${url}`);
      }
    }
  } catch (err) {
    logger.info(`[Discovery] Error handling service loss: ${err.message}`);
  }
}

/**
 * Stop browsing
 */
/**
 * Stop browsing for Ollama services
 * @returns {boolean} True if browsing stopped successfully
 */
function stopBrowsing() {
  if (browser) {
    try {
      browser.stop();
      browser = null;
      logger.info('[Discovery] Stopped browsing');
    } catch (err) {
      logger.info(`[Discovery] Error stopping browser: ${err.message}`);
    }
  }
}

/**
 * Shutdown discovery completely
 * @returns {void}
 */
function shutdownDiscovery() {
  stopAdvertising();
  stopBrowsing();

  if (bonjour) {
    try {
      bonjour.destroy();
      bonjour = null;
    } catch (err) {
      logger.info(`[Discovery] Error destroying bonjour: ${err.message}`);
    }
  }

  clearBonjourCollisionLogFilter();
  isInitialized = false;
  logger.info('[Discovery] Shutdown complete');
}

/**
 * Get current discovery status
 * @returns {{initialized: boolean, enabled: boolean, advertising: boolean, browsing: boolean, advertiseEnabled: boolean, browseEnabled: boolean, lanIP: string, isWSL2: boolean}} Discovery status object
 */
function getDiscoveryStatus() {
  const configDb = getConfigCore();

  return {
    initialized: isInitialized,
    enabled: configDb.getConfig('discovery_enabled') !== '0',
    advertising: advertiser !== null,
    browsing: browser !== null,
    advertiseEnabled: configDb.getConfig('discovery_advertise') === '1',
    browseEnabled: configDb.getConfig('discovery_browse') !== '0',
    lanIP: getLanIP(),
    isWSL2: isWSL2()
  };
}

/**
 * Detect if running in WSL2
 * @returns {boolean} True if running in WSL2
 */
function isWSL2() {
  try {
    const version = require('fs').readFileSync('/proc/version', 'utf8');
    return version.toLowerCase().includes('microsoft');
  } catch {
    return false;
  }
}

/**
 * Get the LAN-accessible IP address (192.168.x.x, 10.x.x.x, etc.)
 * In WSL2, this queries the Windows host for its actual network IP
 * Note: Uses execSync with a static command (no user input) - safe from injection
 * @returns {string|null} LAN IP address or null if detection failed
 */
function getLanIP() {
  if (cachedLanIP) return cachedLanIP;

  try {
    if (isWSL2()) {
      // In WSL2, get the Windows host's LAN IP via PowerShell
      // Static command with no user input - safe from injection
      // Use full path since powershell.exe may not be in PATH
      const psCommand = `/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notmatch 'vEthernet|Loopback' -and $_.IPAddress -match '^192\\\\.|^10\\\\.|^172\\\\.(1[6-9]|2[0-9]|3[01])\\\\.' } | Select-Object -First 1 -ExpandProperty IPAddress"`;
      const result = execSync(psCommand, { encoding: 'utf8', timeout: 5000 }).trim();
      if (result && isPrivateIP(result, true)) {
        cachedLanIP = result;
        logger.info(`[Discovery] Detected LAN IP (WSL2): ${cachedLanIP}`);
        return cachedLanIP;
      }
    }

    // Fallback: scan Node's network interfaces for LAN IPs
    // Skip virtual interfaces (Hyper-V, Docker, VirtualBox, VMware, WSL2)
    const skipPatterns = [
      /^vEthernet/i,
      /^VirtualBox/i,
      /^docker/i,
      /^br-/,
      /^veth/,
      /^vmnet/i,
    ];
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      if (skipPatterns.some(p => p.test(name))) {
        continue;
      }
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          if (isPrivateIP(iface.address)) {
            cachedLanIP = iface.address;
            logger.info(`[Discovery] Detected LAN IP: ${cachedLanIP}`);
            return cachedLanIP;
          }
        }
      }
    }
  } catch (err) {
    logger.info(`[Discovery] Failed to detect LAN IP: ${err.message}`);
  }

  return null;
}

/**
 * Check if URL is local (localhost or 127.x.x.x)
 * @param {string} url - URL to check
 * @returns {boolean} True if URL is local
 */
function isLocalUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host.startsWith('127.') || host === '::1') {
      return true;
    }
    // Also check if the IP matches any of this machine's network interfaces
    return getLocalIPs().has(host);
  } catch {
    return false;
  }
}

/** Cache of this machine's IP addresses (refreshed once per process) */
let _localIPs = null;
function getLocalIPs() {
  if (_localIPs) return _localIPs;
  _localIPs = new Set();
  try {
    const ifaces = os.networkInterfaces();
    for (const addrs of Object.values(ifaces)) {
      for (const addr of addrs) {
        _localIPs.add(addr.address.toLowerCase());
      }
    }
  } catch { /* ignore */ }
  return _localIPs;
}

/**
 * Sanitize ID for database
 * @param {string} id - ID to sanitize
 * @returns {string} Sanitized ID
 */
function sanitizeId(id) {
  return id.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase();
}

/**
 * Refresh models for a discovered host
 * @param {string} hostId - Unique identifier for the host
 * @param {string} url - URL of the Ollama instance
 * @returns {Promise<void>} Promise that resolves when models are refreshed
 */
async function refreshHostModels(hostId, url) {
  const http = require('http');
  const https = require('https');
  const hostDb = getHostManagement();

  try {
    const parsedUrl = new URL(`${url}/api/tags`);
    const client = parsedUrl.protocol === 'https:' ? https : http;

    const req = client.get(parsedUrl.toString(), { timeout: 5000 }, (res) => {
      let data = '';
      const MAX_RESPONSE_SIZE = 1024 * 1024; // 1MB limit
      res.on('data', chunk => {
        data += chunk;
        if (data.length > MAX_RESPONSE_SIZE) {
          res.destroy();
          return;
        }
      });
      res.on('end', () => {
        try {
          if (res.statusCode === 200) {
            const response = JSON.parse(data);
            const models = response.models || [];
            hostDb.updateOllamaHost(hostId, {
              models_cache: JSON.stringify(models),
              models_updated_at: new Date().toISOString(),
              status: 'healthy',
              consecutive_failures: 0
            });
          }
        } catch {
          // Ignore parse errors
        }
      });
    });

    req.on('error', () => {
      // Ignore connection errors during discovery
    });

    req.on('timeout', () => {
      req.destroy();
    });
  } catch {
    // Ignore errors during model refresh
  }
}

// ============================================================
// Network Scanning for Ollama Discovery
// ============================================================

// Scanning state
let isScanning = false;
let lastScanResults = null;

/**
 * Get all local subnets to scan
 * @returns {string[]} Array of subnet strings (e.g., "192.168.1")
 */
function getLocalSubnets() {
  const subnets = [];
  const interfaces = os.networkInterfaces();

  // Skip virtual network interfaces (WSL2, VirtualBox, Docker, etc.)
  const skipPatterns = [
    /^vEthernet/i,       // Hyper-V/WSL2
    /^VirtualBox/i,      // VirtualBox
    /^docker/i,          // Docker
    /^br-/,              // Docker bridge
    /^veth/,             // Docker veth
    /^vmnet/i,           // VMware
  ];

  for (const name of Object.keys(interfaces)) {
    // Skip virtual interfaces
    if (skipPatterns.some(p => p.test(name))) {
      continue;
    }

    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        // Scan RFC1918 private ranges (192.168/16, 10/8, 172.16/12)
        if (isPrivateIP(iface.address)) {
          // Extract subnet (assume /24 for simplicity)
          const parts = iface.address.split('.');
          const subnet = `${parts[0]}.${parts[1]}.${parts[2]}`;
          if (!subnets.includes(subnet)) {
            subnets.push(subnet);
          }
        }
      }
    }
  }

  return subnets;
}

/**
 * Check if a host is running Ollama
 * @param {string} ip - IP address to check
 * @param {number} port - Port number (default: 11434)
 * @param {number} timeout - Request timeout in milliseconds (default: 2000)
 * @returns {Promise<{ip: string, port: number, url: string, models: string[]}>} Promise that resolves to host information if Ollama is running, or null if not
 */
function checkOllamaHost(ip, port = 11434, timeout = 500) {
  return new Promise((resolve) => {
    const http = require('http');
    const url = `http://${ip}:${port}/api/tags`;

    const req = http.get(url, { timeout }, (res) => {
      let data = '';
      const MAX_SIZE = 512 * 1024; // 512KB limit

      res.on('data', chunk => {
        data += chunk;
        if (data.length > MAX_SIZE) {
          res.destroy();
          resolve(null);
        }
      });

      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const response = JSON.parse(data);
            if (response.models !== undefined) {
              resolve({
                ip,
                port,
                url: `http://${ip}:${port}`,
                models: response.models || []
              });
              return;
            }
          } catch {
            // Not valid JSON
          }
        }
        resolve(null);
      });
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

/**
 * Try to get hostname for an IP via reverse DNS
 * @param {string} ip - IP address to resolve
 * @returns {Promise<string|null>} Promise that resolves to the hostname (without domain), or null if reverse DNS fails
 */
function getHostnameForIP(ip) {
  return new Promise((resolve) => {
    const dns = require('dns');
    dns.reverse(ip, (err, hostnames) => {
      if (err || !hostnames || hostnames.length === 0) {
        resolve(null);
      } else {
        // Return first hostname, strip domain if present
        const hostname = hostnames[0].split('.')[0];
        resolve(hostname);
      }
    });
  });
}

/**
 * Scan a subnet for Ollama instances
 * @param {string} subnet - Subnet prefix to scan (e.g. "192.168.1")
 * @param {number} [port=11434] - Port number to check on each host
 * @param {number} [concurrency=10] - Number of hosts to probe in parallel per batch
 * @returns {Promise<Array<{ip: string, port: number, url: string, models: string[]}>>} Array of discovered Ollama hosts
 */
async function scanSubnet(subnet, port = 11434) {
  // Fire all 254 probes simultaneously — each is a tiny HTTP request with
  // a 500ms timeout. The OS can handle 254 concurrent sockets on a LAN.
  const probes = [];
  for (let i = 1; i <= 254; i++) {
    probes.push(checkOllamaHost(`${subnet}.${i}`, port));
  }
  const results = await Promise.all(probes);
  return results.filter(Boolean);
}

/**
 * Scan network for Ollama instances and auto-add them
 * @param {Object} [options] - Scan options
 * @param {number} [options.port=11434] - Port number to scan
 * @param {boolean} [options.autoAdd=true] - Whether to automatically add discovered hosts to the database
 * @param {string[]|null} [options.subnets=null] - Specific subnets to scan, or null to auto-detect
 * @returns {Promise<{success: boolean, reason?: string, timestamp?: string, duration?: number, subnetsScanned?: string[], totalFound?: number, newHosts?: Array<Object>, skipped?: Array<Object>}>} Scan results
 */
async function scanNetworkForOllama(options = {}) {
  const configDb = getConfigCore();
  const hostDb = getHostManagement();
  const autoAddConfig = configDb.getConfig('discovery_auto_add') === '1';
  const {
    port = 11434,
    autoAdd = autoAddConfig,
    subnets = null
  } = options;

  if (isScanning) {
    return { success: false, reason: 'Scan already in progress' };
  }

  isScanning = true;
  const startTime = Date.now();

  try {
    // Get subnets to scan
    const targetSubnets = subnets || getLocalSubnets();

    if (targetSubnets.length === 0) {
      isScanning = false;
      return { success: false, reason: 'No local subnets found to scan' };
    }

    logger.info(`[Discovery] Scanning subnets: ${targetSubnets.join(', ')}`);

    // Get current local IPs to skip
    const localIPs = new Set();
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4') {
          localIPs.add(iface.address);
        }
      }
    }

    // Scan all subnets
    const allResults = [];
    for (const subnet of targetSubnets) {
      const results = await scanSubnet(subnet, port);
      allResults.push(...results);
    }

    // Filter out local machine and already-known hosts
    const existingHosts = hostDb.listOllamaHosts();
    const existingUrls = new Set(existingHosts.map(h => h.url));

    const newHosts = [];
    const skipped = [];

    for (const result of allResults) {
      // Skip local machine
      if (localIPs.has(result.ip) || result.ip === '127.0.0.1') {
        skipped.push({ ...result, reason: 'local' });
        continue;
      }

      // Skip already known hosts
      if (existingUrls.has(result.url)) {
        skipped.push({ ...result, reason: 'exists' });
        continue;
      }

      // Try to get hostname
      let hostname = await getHostnameForIP(result.ip);
      if (!hostname) {
        hostname = result.ip; // Fallback to IP
      }

      result.hostname = hostname;
      newHosts.push(result);

      // Auto-add if enabled
      if (autoAdd) {
        const id = `scan-${result.ip.replace(/\./g, '-')}`;
        try {
          hostDb.addOllamaHost({
            id: id,
            name: hostname,
            url: result.url
          });

          // Update models cache
          hostDb.updateOllamaHost(id, {
            models_cache: JSON.stringify(result.models),
            models_updated_at: new Date().toISOString(),
            status: 'healthy',
            consecutive_failures: 0,
            last_healthy: new Date().toISOString()
          });

          logger.info(`[Discovery] Added host from scan: ${hostname} (${result.url})`);
          result.added = true;

          // Probe for gpu-metrics-server companion on default port
          probeGpuMetricsServer(id, result.url);
        } catch (e) {
          logger.info(`[Discovery] Failed to add host ${result.url}: ${e.message}`);
          result.added = false;
          result.error = e.message;
        }
      }
    }

    const duration = Date.now() - startTime;

    // Store summary only — omit potentially large model lists to bound memory
    lastScanResults = {
      timestamp: new Date().toISOString(),
      duration,
      subnetsScanned: targetSubnets,
      totalFound: allResults.length,
      newHosts: newHosts.map(({ models: _models, ...rest }) => rest),
      skipped: skipped.map(({ models: _models, ...rest }) => rest),
    };

    logger.info(`[Discovery] Scan complete: ${allResults.length} found, ${newHosts.length} new, ${duration}ms`);

    isScanning = false;
    return {
      success: true,
      ...lastScanResults
    };

  } catch (err) {
    isScanning = false;
    logger.info(`[Discovery] Scan failed: ${err.message}`);
    return { success: false, reason: err.message };
  }
}

/**
 * Get last scan results
 * @returns {{timestamp: string, duration: number, subnetsScanned: string[], totalFound: number, newHosts: Array<Object>, skipped: Array<Object>}} Last scan results object
 */
function getLastScanResults() {
  return lastScanResults;
}

/**
 * Check if scan is in progress
 * @returns {boolean} True if a scan is currently in progress
 */
function isScanInProgress() {
  return isScanning;
}

// ============================================================
// Auto-Scan (Periodic Network Scanning)
// ============================================================

/**
 * Start automatic periodic network scanning
 * Scans immediately if network changed, then every intervalMinutes
 * @param {number} [intervalMinutes=5] - Interval in minutes between scans
 * @returns {boolean} True if auto-scan started successfully
 */
function startAutoScan(intervalMinutes = 5) {
  const configDb = getConfigCore();

  if (autoScanInterval) {
    logger.info('[Discovery] Auto-scan already running');
    return false;
  }

  const intervalMs = intervalMinutes * 60 * 1000;

  /**
   * Check for network changes and trigger a scan if subnets changed
   * @returns {Promise<void>}
   */
  const checkAndScan = async () => {
    const currentSubnets = getLocalSubnets();
    const subnetsChanged = JSON.stringify(currentSubnets.sort()) !== JSON.stringify(lastKnownSubnets.sort());

    if (subnetsChanged) {
      logger.info(`[Discovery] Network changed: ${lastKnownSubnets.join(',')} -> ${currentSubnets.join(',')}`);
      lastKnownSubnets = currentSubnets;

      // Clear LAN IP cache on network change
      cachedLanIP = null;

      // Scan immediately on network change (autoAdd respects discovery_auto_add config)
      if (currentSubnets.length > 0) {
        await scanNetworkForOllama();
      }
    }
  };

  // Initial scan
  lastKnownSubnets = getLocalSubnets();
  logger.info(`[Discovery] Starting auto-scan every ${intervalMinutes} minutes`);
  logger.info(`[Discovery] Initial subnets: ${lastKnownSubnets.join(', ')}`);

  // Run initial scan after short delay (autoAdd respects discovery_auto_add config)
  setTimeout(async () => {
    if (lastKnownSubnets.length > 0) {
      await scanNetworkForOllama();
    }
  }, 5000);

  // Set up periodic check
  autoScanInterval = setInterval(checkAndScan, intervalMs);

  // Save config
  configDb.setConfig('auto_scan_enabled', '1');
  configDb.setConfig('auto_scan_interval', String(intervalMinutes));

  return true;
}

/**
 * Stop automatic network scanning
 * @returns {boolean} True when auto-scan has been stopped
 */
function stopAutoScan() {
  const configDb = getConfigCore();

  if (autoScanInterval) {
    clearInterval(autoScanInterval);
    autoScanInterval = null;
    logger.info('[Discovery] Auto-scan stopped');
  }

  configDb.setConfig('auto_scan_enabled', '0');
  return true;
}

/**
 * Check if auto-scan is running
 * @returns {boolean} True if auto-scan interval is currently active
 */
function isAutoScanRunning() {
  return autoScanInterval !== null;
}

/**
 * Get auto-scan status
 * @returns {{running: boolean, enabled: boolean, intervalMinutes: number, currentSubnets: string[], lastKnownSubnets: string[]}} Auto-scan status object
 */
function getAutoScanStatus() {
  const configDb = getConfigCore();

  return {
    running: autoScanInterval !== null,
    enabled: configDb.getConfig('auto_scan_enabled') === '1',
    intervalMinutes: parseInt(configDb.getConfig('auto_scan_interval') || '5', 10),
    currentSubnets: getLocalSubnets(),
    lastKnownSubnets
  };
}

/**
 * Initialize auto-scan from saved config (call on startup)
 * @returns {boolean} True if auto-scan was enabled and started, false otherwise
 */
function initAutoScanFromConfig() {
  const configDb = getConfigCore();

  if (configDb.getConfig('auto_scan_enabled') === '1') {
    const interval = parseInt(configDb.getConfig('auto_scan_interval') || '5', 10);
    startAutoScan(interval);
    return true;
  }
  return false;
}

// ── Factory (DI Phase 3) ─────────────────────────────────────────────────

function createDiscovery(deps) {
  // deps reserved for future DI refinement
  return {
    initDiscovery, shutdownDiscovery,
    startAdvertising, stopAdvertising,
    startBrowsing, stopBrowsing,
    getDiscoveryStatus,
    scanNetworkForOllama, getLastScanResults, isScanInProgress, getLocalSubnets,
    startAutoScan, stopAutoScan, isAutoScanRunning, getAutoScanStatus, initAutoScanFromConfig
  };
}

module.exports = {
  initDiscovery,
  shutdownDiscovery,
  startAdvertising,
  stopAdvertising,
  startBrowsing,
  stopBrowsing,
  getDiscoveryStatus,
  // Network scanning
  scanNetworkForOllama,
  getLastScanResults,
  isScanInProgress,
  getLocalSubnets,
  // Auto-scan
  startAutoScan,
  stopAutoScan,
  isAutoScanRunning,
  getAutoScanStatus,
  initAutoScanFromConfig,
  createDiscovery,
};
