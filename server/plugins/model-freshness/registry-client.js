'use strict';

const REGISTRY_BASE = 'https://registry.ollama.ai';

async function fetchRemoteDigest(family, tag, { timeoutMs = 10000 } = {}) {
  const url = `${REGISTRY_BASE}/v2/library/${encodeURIComponent(family)}/manifests/${encodeURIComponent(tag)}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { method: 'HEAD', signal: controller.signal });
    if (resp.status === 404) return null;
    if (!resp.ok) {
      throw new Error(`registry.ollama.ai returned ${resp.status} for ${family}:${tag}`);
    }
    const digest = resp.headers.get
      ? resp.headers.get('ollama-content-digest')
      : resp.headers['ollama-content-digest'];
    return digest || null;
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = { fetchRemoteDigest, REGISTRY_BASE };
