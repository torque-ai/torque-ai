'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

function createPeekClient({ url = '', hostRegistry = null }) {
  function getBaseUrl() {
    if (url) return url.replace(/\/$/, '');
    if (hostRegistry) {
      const hosts = hostRegistry.getHealthyHosts();
      if (hosts.length > 0) return hosts[0].url.replace(/\/$/, '');
    }
    return null;
  }

  async function request(method, path, body = null, timeoutMs = 30000) {
    const base = getBaseUrl();
    if (!base) throw new Error('No peek_server available');

    const fullUrl = new URL(path, base);
    const client = fullUrl.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
      const req = client.request(
        fullUrl,
        {
          method,
          timeout: timeoutMs,
          headers: { 'Content-Type': 'application/json' },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode, data: JSON.parse(data) });
            } catch {
              resolve({ status: res.statusCode, data });
            }
          });
        }
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timed out'));
      });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  async function isReachable() {
    try {
      const { status } = await request('GET', '/health', null, 5000);
      return status === 200;
    } catch {
      return false;
    }
  }

  return { getBaseUrl, request, isReachable };
}

module.exports = { createPeekClient };
