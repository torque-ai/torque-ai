/**
 * utils/proxy-agent.js — HTTP/HTTPS proxy support for cloud API providers
 *
 * Reads standard proxy environment variables (HTTPS_PROXY, HTTP_PROXY, NO_PROXY)
 * and configures a global fetch dispatcher via undici's EnvHttpProxyAgent.
 *
 * When no proxy env vars are set, fetch behaves exactly as before (direct connections).
 * When proxy env vars are set, all fetch() calls route through the configured proxy,
 * respecting NO_PROXY exclusions for hosts that should bypass the proxy (e.g., localhost,
 * local Ollama hosts).
 *
 * Usage: call installProxyAgent() once at startup, before any API provider fetch calls.
 */

'use strict';

const logger = require('../logger').child({ component: 'proxy-agent' });

/**
 * Detect proxy configuration from environment variables.
 * Checks both upper and lower case variants (HTTPS_PROXY, https_proxy, etc.)
 *
 * @returns {{ httpsProxy: string|null, httpProxy: string|null, noProxy: string|null }}
 */
function detectProxyEnv() {
  const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy || null;
  const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy || null;
  const noProxy = process.env.NO_PROXY || process.env.no_proxy || null;

  return { httpsProxy, httpProxy, noProxy };
}

/**
 * Returns true if any proxy environment variable is configured.
 * @returns {boolean}
 */
function isProxyConfigured() {
  const { httpsProxy, httpProxy } = detectProxyEnv();
  return !!(httpsProxy || httpProxy);
}

/**
 * Create and install a global proxy dispatcher for Node.js fetch.
 * Uses undici's EnvHttpProxyAgent which automatically reads HTTPS_PROXY,
 * HTTP_PROXY, and NO_PROXY env vars.
 *
 * Safe to call when no proxy vars are set — EnvHttpProxyAgent falls back
 * to direct connections, identical to the default behavior.
 *
 * @returns {{ installed: boolean, httpsProxy: string|null, httpProxy: string|null, noProxy: string|null }}
 */
function installProxyAgent() {
  const { httpsProxy, httpProxy, noProxy } = detectProxyEnv();

  if (!httpsProxy && !httpProxy) {
    return { installed: false, httpsProxy: null, httpProxy: null, noProxy: null };
  }

  try {
    const { EnvHttpProxyAgent, setGlobalDispatcher } = require('undici');
    const agent = new EnvHttpProxyAgent();
    setGlobalDispatcher(agent);

    logger.info('Proxy agent installed for cloud API providers', {
      httpsProxy: httpsProxy ? redactProxyUrl(httpsProxy) : null,
      httpProxy: httpProxy ? redactProxyUrl(httpProxy) : null,
      noProxy: noProxy || null,
    });

    return { installed: true, httpsProxy, httpProxy, noProxy };
  } catch (err) {
    logger.info(`Failed to install proxy agent: ${err.message}. Cloud API connections will be direct.`);
    return { installed: false, httpsProxy, httpProxy, noProxy };
  }
}

/**
 * Create a ProxyAgent for a specific proxy URL (for testing or explicit proxy config).
 * Returns null if proxyUrl is falsy.
 *
 * @param {string} proxyUrl - The proxy URL (e.g., "http://proxy.corp:8080")
 * @returns {object|null} undici ProxyAgent instance, or null
 */
function createProxyAgent(proxyUrl) {
  if (!proxyUrl) return null;

  const { ProxyAgent } = require('undici');
  return new ProxyAgent(proxyUrl);
}

/**
 * Check whether a given hostname should bypass the proxy based on NO_PROXY rules.
 *
 * NO_PROXY is a comma-separated list of hostnames/domains/IPs.
 * Supports:
 *   - Exact match: "api.example.com"
 *   - Domain suffix: ".example.com" matches "sub.example.com"
 *   - Wildcard: "*" bypasses all
 *   - Localhost variants: "localhost", "127.0.0.1", "::1"
 *
 * @param {string} hostname - The hostname to check
 * @param {string} [noProxyValue] - NO_PROXY value (defaults to env var)
 * @returns {boolean} true if the hostname should bypass the proxy
 */
function shouldBypassProxy(hostname, noProxyValue) {
  const noProxy = noProxyValue !== undefined
    ? noProxyValue
    : (process.env.NO_PROXY || process.env.no_proxy || '');

  if (!noProxy || !hostname) return false;

  const entries = noProxy.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  const lowerHost = hostname.toLowerCase();

  for (const entry of entries) {
    // Wildcard: bypass everything
    if (entry === '*') return true;

    // Exact match
    if (lowerHost === entry) return true;

    // Domain suffix match (e.g., ".example.com" matches "sub.example.com")
    if (entry.startsWith('.') && lowerHost.endsWith(entry)) return true;

    // Also match if entry without leading dot matches the suffix
    // e.g., "example.com" should match "sub.example.com"
    if (!entry.startsWith('.') && lowerHost.endsWith('.' + entry)) return true;
  }

  return false;
}

/**
 * Redact credentials from a proxy URL for safe logging.
 * "http://user:pass@proxy:8080" → "http://***:***@proxy:8080"
 */
function redactProxyUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = '***';
      parsed.password = '***';
    }
    return parsed.toString();
  } catch {
    return '[invalid-url]';
  }
}

module.exports = {
  detectProxyEnv,
  isProxyConfigured,
  installProxyAgent,
  createProxyAgent,
  shouldBypassProxy,
  redactProxyUrl,
};
