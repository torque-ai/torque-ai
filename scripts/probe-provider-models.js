#!/usr/bin/env node
'use strict';

/**
 * On-demand model registry probe.
 *
 * For each model in `model_registry` for the named provider, do a tiny
 * `chat/completions` call (1-token max_tokens, "ping" prompt). Models that
 * fail with model-not-found / 5xx / paid-tier denial are reported.
 *
 * Auto-pruning is INTENTIONALLY off: one transient API hiccup shouldn't mark
 * a model permanently denied. The script prints the unreachable list; the
 * operator decides which to deny via the dashboard or:
 *   curl -X POST http://127.0.0.1:3457/api/v2/models/deny \
 *        -H "Content-Type: application/json" \
 *        -d '{"provider":"google-ai","model_name":"gemma-4-31b-it"}'
 *
 * Usage:
 *   node scripts/probe-provider-models.js <provider>
 *   node scripts/probe-provider-models.js google-ai
 *   node scripts/probe-provider-models.js cerebras --limit 5
 *
 * Provider must already be enabled with a configured API key.
 */

const path = require('path');
const Database = require(path.join(__dirname, '..', 'server', 'node_modules', 'better-sqlite3'));
const { getDataDir } = require(path.join(__dirname, '..', 'server', 'data-dir'));
const credentialCrypto = require(path.join(__dirname, '..', 'server', 'utils', 'credential-crypto'));

const SUPPORTED_PROVIDERS = new Set(['google-ai', 'cerebras', 'groq', 'openrouter', 'deepinfra', 'hyperbolic', 'ollama-cloud']);

function parseArgs(argv) {
  const args = { provider: null, limit: 0, verbose: false };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--limit') { args.limit = parseInt(rest[++i] || '0', 10) || 0; continue; }
    if (a === '--verbose' || a === '-v') { args.verbose = true; continue; }
    if (!args.provider) { args.provider = a; continue; }
  }
  return args;
}

function loadProviderKey(db, provider) {
  const envName = `${provider.toUpperCase().replace(/-/g, '_')}_API_KEY`;
  const envKey = process.env[envName];
  if (envKey) return envKey;
  const row = db.prepare('SELECT api_key_encrypted FROM provider_config WHERE provider = ?').get(provider);
  if (!row || !row.api_key_encrypted) return null;
  const parts = String(row.api_key_encrypted).split(':');
  if (parts.length !== 3) return null;
  try {
    const k = credentialCrypto.getOrCreateKey();
    const result = credentialCrypto.decrypt(parts[2], parts[0], parts[1], k);
    return typeof result === 'string' ? result : String(result);
  } catch (e) {
    return null;
  }
}

const PROVIDER_ENDPOINTS = {
  'google-ai':  (model) => ({
    url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    method: 'POST',
    body: { contents: [{ role: 'user', parts: [{ text: 'ping' }] }], generationConfig: { maxOutputTokens: 1 } },
    authQuery: 'key',
  }),
  'cerebras':   (model) => ({
    url: 'https://api.cerebras.ai/v1/chat/completions',
    method: 'POST',
    body: { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 },
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
  }),
  'groq':       (model) => ({
    url: 'https://api.groq.com/openai/v1/chat/completions',
    method: 'POST',
    body: { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 },
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
  }),
  'openrouter': (model) => ({
    url: 'https://openrouter.ai/api/v1/chat/completions',
    method: 'POST',
    body: { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 },
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
  }),
  'deepinfra':  (model) => ({
    url: 'https://api.deepinfra.com/v1/openai/chat/completions',
    method: 'POST',
    body: { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 },
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
  }),
  'hyperbolic': (model) => ({
    url: 'https://api.hyperbolic.xyz/v1/chat/completions',
    method: 'POST',
    body: { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 },
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
  }),
  'ollama-cloud': (model) => ({
    url: 'https://ollama.com/api/chat',
    method: 'POST',
    body: { model, messages: [{ role: 'user', content: 'ping' }], stream: false, options: { num_predict: 1 } },
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
  }),
};

function classifyError(status, body) {
  const text = String(body || '').toLowerCase();
  if (status === 404) return 'not_found';
  if (status === 403 && /access|tier|paid|upgrade/.test(text)) return 'tier_denied';
  if (status === 429) return 'rate_limited'; // skip — transient, model itself may be fine
  if (status >= 500 && status < 600) return text.includes('internal') ? 'internal_5xx' : 'transient_5xx';
  if (/does not exist|model_not_found|not supported/.test(text)) return 'not_found';
  if (/deprecated/.test(text)) return 'deprecated';
  return null;
}

async function probeOne(provider, model, apiKey, timeoutMs = 8000) {
  const builder = PROVIDER_ENDPOINTS[provider];
  if (!builder) return { ok: false, error: `provider ${provider} not supported by probe script` };
  const cfg = builder(model);
  const headers = { 'Content-Type': 'application/json' };
  let url = cfg.url;
  if (cfg.authHeader) headers[cfg.authHeader] = `${cfg.authPrefix || ''}${apiKey}`;
  if (cfg.authQuery) url += `${url.includes('?') ? '&' : '?'}${cfg.authQuery}=${encodeURIComponent(apiKey)}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: cfg.method, headers, body: JSON.stringify(cfg.body), signal: controller.signal });
    clearTimeout(t);
    const text = await res.text();
    if (res.ok) return { ok: true, status: res.status };
    const classification = classifyError(res.status, text);
    return { ok: false, status: res.status, classification, body: text.slice(0, 200) };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, error: e.message };
  }
}

(async () => {
  const args = parseArgs(process.argv);
  if (!args.provider || !SUPPORTED_PROVIDERS.has(args.provider)) {
    console.error(`Usage: node scripts/probe-provider-models.js <provider> [--limit N]`);
    console.error(`Providers: ${[...SUPPORTED_PROVIDERS].join(', ')}`);
    process.exit(2);
  }
  const dbPath = path.join(getDataDir(), 'tasks.db');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const apiKey = loadProviderKey(db, args.provider);
  if (!apiKey) {
    console.error(`No API key configured for ${args.provider}`);
    process.exit(3);
  }
  const rows = db.prepare(`
    SELECT model_name, status, last_seen_at
    FROM model_registry
    WHERE provider = ? AND COALESCE(host_id, '') = ''
    ORDER BY model_name
  `).all(args.provider);
  if (rows.length === 0) {
    console.log(`No registered models for ${args.provider}.`);
    process.exit(0);
  }
  const slice = args.limit > 0 ? rows.slice(0, args.limit) : rows;
  console.log(`Probing ${slice.length} model(s) for ${args.provider} (timeout 8s each)...`);
  console.log('');
  const reachable = [];
  const unreachable = [];
  const transient = [];
  for (const row of slice) {
    process.stdout.write(`  ${row.model_name.padEnd(50)} `);
    const result = await probeOne(args.provider, row.model_name, apiKey);
    if (result.ok) {
      console.log('OK');
      reachable.push(row.model_name);
    } else if (result.classification === 'rate_limited' || result.classification === 'transient_5xx') {
      console.log(`SKIP (transient: ${result.status} ${result.classification})`);
      transient.push({ model: row.model_name, ...result });
    } else if (result.classification) {
      console.log(`UNREACHABLE (${result.status} ${result.classification})`);
      unreachable.push({ model: row.model_name, status: row.status, ...result });
    } else {
      console.log(`UNKNOWN (${result.error || result.status})`);
      transient.push({ model: row.model_name, ...result });
    }
    if (args.verbose && result.body) {
      console.log(`    body: ${result.body.replace(/\s+/g, ' ').slice(0, 180)}`);
    }
  }
  console.log('');
  console.log(`Summary: ${reachable.length} reachable, ${unreachable.length} unreachable, ${transient.length} transient/skipped`);
  if (unreachable.length > 0) {
    console.log('');
    console.log('Suggested deny commands:');
    for (const u of unreachable) {
      console.log(`  curl -X POST http://127.0.0.1:3457/api/v2/models/deny -H "Content-Type: application/json" -d '${JSON.stringify({ provider: args.provider, model_name: u.model })}'`);
    }
  }
  process.exit(0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
