# Provider API Key Management Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users set, change, and clear API keys for cloud providers through the dashboard, with AES-256-GCM encryption at rest and async validation.

**Architecture:** Reuse `credential-crypto.js` for encryption. Add encrypt/decrypt helper functions to `provider-crud-handlers.js` that pack three hex fields into the single `api_key_encrypted` column. Update `config.js` `getApiKey()` to resolve encrypted keys. Add REST endpoints and MCP tools. Add inline key management UI to provider cards.

**Tech Stack:** Node.js (CommonJS), SQLite (better-sqlite3), React + Tailwind (Vite), Vitest, `crypto` (AES-256-GCM)

**Spec:** `docs/superpowers/specs/2026-03-17-provider-api-key-management-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `server/utils/credential-crypto.js` | Existing — AES-256-GCM encrypt/decrypt, secret key management. No changes. |
| `server/handlers/provider-crud-handlers.js` | Add `encryptApiKey`/`decryptApiKey` wrappers, `handleSetApiKey`/`handleClearApiKey` handlers. Update `handleAddProvider` to encrypt keys. |
| `server/config.js` | Update `getApiKey()` to check `provider_config.api_key_encrypted` (decrypt). |
| `server/tool-defs/provider-crud-defs.js` | Add 2 MCP tool definitions. |
| `server/api/routes.js` | Add 2 REST routes. |
| `server/api/v2-dispatch.js` | Add 2 dispatch handlers. |
| `server/api/v2-governance-handlers.js` | Enrich provider list with `api_key_status` and `api_key_masked`. |
| `dashboard/src/views/Providers.jsx` | Add key management row to provider cards. |
| `dashboard/src/api.js` | Add 2 API client functions. |
| `server/tests/provider-api-key.test.js` | Unit tests for encryption helpers and getApiKey. |
| `server/tests/provider-api-key-integration.test.js` | Integration tests for endpoints. |

---

### Task 1: Encryption Helpers + Unit Tests

**Files:**
- Modify: `server/handlers/provider-crud-handlers.js`
- Create: `server/tests/provider-api-key.test.js`

- [x] **Step 1: Write failing tests**

Create `server/tests/provider-api-key.test.js`:

```js
'use strict';

describe('provider API key encryption helpers', () => {
  let encryptApiKey, decryptApiKey;

  beforeAll(() => {
    // Import from provider-crud-handlers after they're added
    const handlers = require('../handlers/provider-crud-handlers');
    encryptApiKey = handlers.encryptApiKey;
    decryptApiKey = handlers.decryptApiKey;
  });

  it('round-trips a key through encrypt and decrypt', () => {
    const key = 'sk-test-abc123-very-secret-key';
    const encrypted = encryptApiKey(key);
    expect(encrypted).toBeTruthy();
    expect(encrypted).not.toBe(key);
    expect(encrypted).toContain(':'); // packed format iv:tag:cipher
    const decrypted = decryptApiKey(encrypted);
    expect(decrypted).toBe(key);
  });

  it('produces different ciphertext for same input (random IV)', () => {
    const key = 'sk-test-same-key';
    const a = encryptApiKey(key);
    const b = encryptApiKey(key);
    expect(a).not.toBe(b);
    // Both decrypt to same value
    expect(decryptApiKey(a)).toBe(key);
    expect(decryptApiKey(b)).toBe(key);
  });

  it('returns null for tampered ciphertext', () => {
    const encrypted = encryptApiKey('sk-test-tamper');
    // Flip a character in the ciphertext portion
    const parts = encrypted.split(':');
    parts[2] = parts[2].slice(0, -2) + 'ff';
    const tampered = parts.join(':');
    expect(decryptApiKey(tampered)).toBeNull();
  });

  it('returns null for plaintext (no colon separator)', () => {
    expect(decryptApiKey('just-a-plaintext-key')).toBeNull();
  });

  it('returns null for empty or null input', () => {
    expect(decryptApiKey('')).toBeNull();
    expect(decryptApiKey(null)).toBeNull();
    expect(decryptApiKey(undefined)).toBeNull();
  });

  it('returns null for malformed packed value (wrong number of parts)', () => {
    expect(decryptApiKey('part1:part2')).toBeNull();
    expect(decryptApiKey('a:b:c:d')).toBeNull();
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/provider-api-key.test.js`
Expected: Failures — `encryptApiKey` and `decryptApiKey` not yet exported

- [x] **Step 3: Add encrypt/decrypt helpers to provider-crud-handlers.js**

At the top of `server/handlers/provider-crud-handlers.js`, add the require (after existing requires):

```js
const credentialCrypto = require('../utils/credential-crypto');
```

After the existing helper functions (before `handleAddProvider`), add:

```js
function encryptApiKey(plaintext) {
  if (!plaintext || typeof plaintext !== 'string') return null;
  const key = credentialCrypto.getOrCreateKey();
  const { encrypted_value, iv, auth_tag } = credentialCrypto.encrypt(plaintext, key);
  return `${iv}:${auth_tag}:${encrypted_value}`;
}

function decryptApiKey(packed) {
  if (!packed || typeof packed !== 'string' || !packed.includes(':')) return null;
  const parts = packed.split(':');
  if (parts.length !== 3) return null;
  try {
    const key = credentialCrypto.getOrCreateKey();
    const result = credentialCrypto.decrypt(parts[2], parts[0], parts[1], key);
    // credential-crypto.decrypt returns JSON.parse'd value — our input was a string
    return typeof result === 'string' ? result : String(result);
  } catch {
    return null;
  }
}
```

Add both to `module.exports`:

```js
module.exports = {
  handleAddProvider,
  handleRemoveProvider,
  encryptApiKey,
  decryptApiKey,
};
```

- [x] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/provider-api-key.test.js`
Expected: All tests PASS

- [x] **Step 5: Commit**

```bash
git add server/handlers/provider-crud-handlers.js server/tests/provider-api-key.test.js
git commit -m "feat: add encryptApiKey/decryptApiKey helpers with tests"
```

---

### Task 2: Update getApiKey() Resolution

**Files:**
- Modify: `server/config.js`
- Modify: `server/tests/provider-api-key.test.js`

- [x] **Step 1: Add tests for getApiKey resolution**

Append to `server/tests/provider-api-key.test.js`:

```js
describe('config.js getApiKey() with encrypted keys', () => {
  const { setupTestDb, teardownTestDb } = require('./vitest-setup');
  let db;
  let config;
  let encryptApiKey;

  beforeAll(() => {
    ({ db } = setupTestDb('provider-api-key-config'));
    config = require('../config');
    ({ encryptApiKey } = require('../handlers/provider-crud-handlers'));
  });

  afterAll(() => {
    teardownTestDb();
  });

  it('resolves encrypted key from provider_config', () => {
    const encrypted = encryptApiKey('sk-from-db-encrypted');
    const database = db.getDbInstance ? db.getDbInstance() : db;
    // Ensure provider exists
    try {
      database.prepare("INSERT OR IGNORE INTO provider_config (provider, enabled, max_concurrent, transport) VALUES ('test-provider', 1, 3, 'api')").run();
    } catch { /* may already exist */ }
    database.prepare("UPDATE provider_config SET api_key_encrypted = ? WHERE provider = 'test-provider'").run(encrypted);

    const resolved = config.getApiKey('test-provider');
    // Should find the encrypted key (env var not set for test-provider)
    expect(resolved).toBe('sk-from-db-encrypted');
  });

  it('falls through gracefully when decryption fails', () => {
    const database = db.getDbInstance ? db.getDbInstance() : db;
    try {
      database.prepare("INSERT OR IGNORE INTO provider_config (provider, enabled, max_concurrent, transport) VALUES ('bad-key-provider', 1, 3, 'api')").run();
    } catch { /* may already exist */ }
    database.prepare("UPDATE provider_config SET api_key_encrypted = ? WHERE provider = 'bad-key-provider'").run('not-encrypted-garbage');

    // Should not throw, should return null (or fall through to config table)
    const resolved = config.getApiKey('bad-key-provider');
    expect(resolved).toBeNull();
  });

  it('env var takes precedence over encrypted DB value', () => {
    const origKey = process.env.GROQ_API_KEY;
    process.env.GROQ_API_KEY = 'env-groq-key';

    const encrypted = encryptApiKey('db-groq-key');
    const database = db.getDbInstance ? db.getDbInstance() : db;
    database.prepare("UPDATE provider_config SET api_key_encrypted = ? WHERE provider = 'groq'").run(encrypted);

    expect(config.getApiKey('groq')).toBe('env-groq-key');

    if (origKey) process.env.GROQ_API_KEY = origKey;
    else delete process.env.GROQ_API_KEY;
  });
});
```

- [x] **Step 2: Update config.js getApiKey()**

In `server/config.js`, modify `getApiKey()` to add encrypted key resolution between env var and config table:

```js
function getApiKey(provider) {
  const envVar = API_KEY_ENV_VARS[provider];

  // 1. Environment variable (highest priority)
  if (envVar) {
    const envVal = process.env[envVar];
    if (envVal) return envVal;
  }

  // 2. provider_config.api_key_encrypted (decrypt)
  if (db && typeof db.getProvider === 'function') {
    const providerRow = db.getProvider(provider);
    if (providerRow && providerRow.api_key_encrypted) {
      try {
        const { decryptApiKey } = require('./handlers/provider-crud-handlers');
        const decrypted = decryptApiKey(providerRow.api_key_encrypted);
        if (decrypted) return decrypted;
      } catch {
        // decryption failed or module not ready — fall through
      }
    }
  }

  // 3. DB config table (legacy)
  const dbKey = `${provider.replace(/-/g, '_')}_api_key`;
  if (db && typeof db.getConfig === 'function') {
    const dbVal = db.getConfig(dbKey);
    if (dbVal) return dbVal;
  }

  return null;
}
```

Note: `db.getProvider` may not exist in `config.js`'s scope. Check how `db` is initialized — it's set via `config.init({ db })`. Read the file to see if `db.getProvider` is available or if you need to query the DB directly. If `db` is the database module, use `db.getProvider(provider)`. If it's a raw SQLite instance, use `db.prepare('SELECT api_key_encrypted FROM provider_config WHERE provider = ?').get(provider)`.

- [x] **Step 3: Run tests**

Run: `cd server && npx vitest run tests/provider-api-key.test.js`
Expected: All tests PASS

- [x] **Step 4: Commit**

```bash
git add server/config.js server/tests/provider-api-key.test.js
git commit -m "feat: getApiKey resolves encrypted keys from provider_config"
```

---

### Task 3: Set/Clear API Key Handlers + MCP Tools

**Files:**
- Modify: `server/handlers/provider-crud-handlers.js`
- Modify: `server/tool-defs/provider-crud-defs.js`

- [x] **Step 1: Add handleSetApiKey and handleClearApiKey**

In `server/handlers/provider-crud-handlers.js`, add two new handler functions before `module.exports`:

```js
// In-memory set tracking providers undergoing validation after key save
const validatingProviders = new Map();
const VALIDATION_TIMEOUT_MS = 30000;

function getApiKeyStatus(provider) {
  const providerName = typeof provider === 'object' ? provider.provider : provider;

  // Check validation timeout
  const validatingTs = validatingProviders.get(providerName);
  if (validatingTs && (Date.now() - validatingTs) < VALIDATION_TIMEOUT_MS) {
    return 'validating';
  }
  if (validatingTs) validatingProviders.delete(providerName); // expired

  // Check env var
  const serverConfig = require('../config');
  const API_KEY_ENV_VARS = {
    anthropic: 'ANTHROPIC_API_KEY', groq: 'GROQ_API_KEY', cerebras: 'CEREBRAS_API_KEY',
    'google-ai': 'GOOGLE_AI_API_KEY', 'ollama-cloud': 'OLLAMA_CLOUD_API_KEY',
    openrouter: 'OPENROUTER_API_KEY', deepinfra: 'DEEPINFRA_API_KEY',
    hyperbolic: 'HYPERBOLIC_API_KEY', codex: 'OPENAI_API_KEY',
  };
  const envVar = API_KEY_ENV_VARS[providerName];
  if (envVar && process.env[envVar]) return 'env';

  // Check DB encrypted key
  const database = getDatabaseHandle();
  if (database) {
    const row = database.prepare('SELECT api_key_encrypted FROM provider_config WHERE provider = ?').get(providerName);
    if (row && row.api_key_encrypted) {
      const decrypted = decryptApiKey(row.api_key_encrypted);
      if (decrypted) return 'stored';
    }
  }

  return 'not_set';
}

function handleSetApiKey(args) {
  const providerName = normalizeRequiredString(args.provider, 'provider');
  const apiKey = typeof args.api_key === 'string' ? args.api_key.trim() : '';

  if (!apiKey) {
    return makeCrudError(ErrorCodes.MISSING_REQUIRED_PARAM, 'api_key is required', { code: 'validation_error', status: 400 });
  }
  if (apiKey.length > 256) {
    return makeCrudError(ErrorCodes.INVALID_PARAM, 'api_key must be 256 characters or fewer', { code: 'validation_error', status: 400 });
  }

  const database = getDatabaseHandle();
  if (!database) {
    return makeCrudError(ErrorCodes.INTERNAL_ERROR, 'Database not available', { code: 'operation_failed', status: 500 });
  }

  const existing = database.prepare('SELECT provider FROM provider_config WHERE provider = ?').get(providerName);
  if (!existing) {
    return makeCrudError(ErrorCodes.RESOURCE_NOT_FOUND, `Provider not found: ${providerName}`, { code: 'provider_not_found', status: 404 });
  }

  const encrypted = encryptApiKey(apiKey);
  database.prepare('UPDATE provider_config SET api_key_encrypted = ?, updated_at = datetime(\'now\') WHERE provider = ?').run(encrypted, providerName);

  // Mark as validating and trigger health check
  validatingProviders.set(providerName, Date.now());
  // Trigger an async health check cycle — runHostHealthChecks() checks all hosts/providers.
  // It's heavier than a single-provider check, but it's the existing API and runs in background.
  // The 30s auto-timeout in getApiKeyStatus() handles cases where the health check doesn't complete.
  try {
    const hostMonitoring = require('../utils/host-monitoring');
    if (typeof hostMonitoring.runHostHealthChecks === 'function') {
      hostMonitoring.runHostHealthChecks().finally(() => {
        validatingProviders.delete(providerName);
      });
    } else {
      setTimeout(() => validatingProviders.delete(providerName), VALIDATION_TIMEOUT_MS);
    }
  } catch {
    setTimeout(() => validatingProviders.delete(providerName), VALIDATION_TIMEOUT_MS);
  }

  const { redactValue } = require('../utils/sensitive-keys');
  const logger = require('../logger');
  logger.info(`API key set for provider ${providerName}`);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        status: 'saved',
        masked: redactValue(apiKey),
        validating: true,
      }),
    }],
  };
}

function handleClearApiKey(args) {
  const providerName = normalizeRequiredString(args.provider, 'provider');
  const database = getDatabaseHandle();
  if (!database) {
    return makeCrudError(ErrorCodes.INTERNAL_ERROR, 'Database not available', { code: 'operation_failed', status: 500 });
  }

  const existing = database.prepare('SELECT provider FROM provider_config WHERE provider = ?').get(providerName);
  if (!existing) {
    return makeCrudError(ErrorCodes.RESOURCE_NOT_FOUND, `Provider not found: ${providerName}`, { code: 'provider_not_found', status: 404 });
  }

  database.prepare("UPDATE provider_config SET api_key_encrypted = NULL, updated_at = datetime('now') WHERE provider = ?").run(providerName);
  validatingProviders.delete(providerName);

  const logger = require('../logger');
  logger.info(`API key cleared for provider ${providerName}`);

  return {
    content: [{ type: 'text', text: JSON.stringify({ status: 'cleared' }) }],
  };
}
```

Update `module.exports` to include the new functions:

```js
module.exports = {
  handleAddProvider,
  handleRemoveProvider,
  handleSetApiKey,
  handleClearApiKey,
  encryptApiKey,
  decryptApiKey,
  getApiKeyStatus,
  validatingProviders,
};
```

Also update `handleAddProvider` to encrypt the `api_key` parameter. Find line 341 where `apiKey` is passed to the INSERT. Change:

```js
// Before:
        apiKey,
// After:
        apiKey ? encryptApiKey(apiKey) : null,
```

- [x] **Step 2: Add MCP tool definitions**

Append to the array in `server/tool-defs/provider-crud-defs.js`:

```js
  {
    name: 'set_provider_api_key',
    description: 'Set or update the API key for a provider. Encrypts at rest and triggers an async health check.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'Provider name (e.g., "deepinfra", "groq")' },
        api_key: { type: 'string', description: 'The API key value' },
      },
      required: ['provider', 'api_key'],
    },
  },
  {
    name: 'clear_provider_api_key',
    description: 'Clear the stored API key for a provider.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'Provider name (e.g., "deepinfra", "groq")' },
      },
      required: ['provider'],
    },
  },
```

- [x] **Step 3: Commit**

```bash
git add server/handlers/provider-crud-handlers.js server/tool-defs/provider-crud-defs.js
git commit -m "feat: add set/clear API key handlers with encryption and async validation"
```

---

### Task 4: REST Routes + Dispatch

**Files:**
- Modify: `server/api/routes.js`
- Modify: `server/api/v2-dispatch.js`

- [x] **Step 1: Add routes**

In `server/api/routes.js`, near the existing provider CRUD routes (around the `handleV2CpAddProvider` and `handleV2CpRemoveProvider` routes), add:

```js
  { method: 'PUT', path: /^\/api\/v2\/providers\/([^/]+)\/api-key$/, handlerName: 'handleV2CpSetProviderApiKey', mapParams: ['provider_name'], middleware: buildV2Middleware({ params: validateDecodedParamField('provider_name', 'provider name') }) },
  { method: 'DELETE', path: /^\/api\/v2\/providers\/([^/]+)\/api-key$/, handlerName: 'handleV2CpClearProviderApiKey', mapParams: ['provider_name'], middleware: buildV2Middleware({ params: validateDecodedParamField('provider_name', 'provider name') }) },
```

Use the regex pattern + `mapParams` convention that existing routes use (check nearby routes for the exact pattern — look at how `handleV2CpGetRoutingTemplate` is registered for reference).

- [x] **Step 2: Add dispatch handlers**

In `server/api/v2-dispatch.js`, add to `V2_CP_HANDLER_LOOKUP` (after the existing provider CRUD handlers around line 131):

Follow the existing `handleV2CpAddProvider`/`handleV2CpRemoveProvider` pattern exactly (lines 110-131) — use `throwToolResultError(result)` for errors and `unwrapToolResult(result)` for success:

```js
  handleV2CpSetProviderApiKey: async (req, res, ctx) => {
    const body = await readJsonBody(req);
    const providerName = ctx.params?.provider_name || '';
    const providerCrudHandlers = require('../handlers/provider-crud-handlers');
    const result = providerCrudHandlers.handleSetApiKey({ provider: providerName, api_key: body.api_key });
    if (result?.isError) {
      throwToolResultError(result);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: unwrapToolResult(result), meta: { request_id: ctx.requestId } }));
  },
  handleV2CpClearProviderApiKey: (req, res, ctx) => {
    const providerName = ctx.params?.provider_name || '';
    const providerCrudHandlers = require('../handlers/provider-crud-handlers');
    const result = providerCrudHandlers.handleClearApiKey({ provider: providerName });
    if (result?.isError) {
      throwToolResultError(result);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: unwrapToolResult(result), meta: { request_id: ctx.requestId } }));
  },
```

`throwToolResultError` and `unwrapToolResult` are already defined in `v2-dispatch.js`. The outer error handler catches thrown errors and sends the proper HTTP error response with status codes.

- [x] **Step 3: Commit**

```bash
git add server/api/routes.js server/api/v2-dispatch.js
git commit -m "feat: add REST routes for provider API key set/clear"
```

---

### Task 5: Enrich Provider List with Key Status

**Files:**
- Modify: `server/api/v2-governance-handlers.js`

- [x] **Step 1: Enrich handleListProviders response**

In `server/api/v2-governance-handlers.js`, find `handleListProviders` (line 639). In the `providers.map(p => { ... })` block, after the stats enrichment, add key status fields:

```js
      // API key status enrichment
      let api_key_status = 'not_set';
      let api_key_masked = null;
      try {
        const { getApiKeyStatus, decryptApiKey } = require('../handlers/provider-crud-handlers');
        const { redactValue } = require('../utils/sensitive-keys');
        const serverConfig = require('../config');

        api_key_status = getApiKeyStatus(p.provider);
        if (api_key_status === 'env') {
          const envKey = serverConfig.getApiKey(p.provider);
          if (envKey) api_key_masked = redactValue(envKey);
        } else if (api_key_status === 'stored' || api_key_status === 'validating') {
          if (p.api_key_encrypted) {
            const decrypted = decryptApiKey(p.api_key_encrypted);
            if (decrypted) api_key_masked = redactValue(decrypted);
          }
        }
      } catch { /* key enrichment is best-effort */ }
```

Add `api_key_status` and `api_key_masked` to the returned object:

```js
      return {
        ...p,
        stats: { ... },
        api_key_status,
        api_key_masked,
      };
```

- [x] **Step 2: Commit**

```bash
git add server/api/v2-governance-handlers.js
git commit -m "feat: enrich provider list with api_key_status and api_key_masked"
```

---

### Task 6: Dashboard API Client

**Files:**
- Modify: `dashboard/src/api.js`

- [x] **Step 1: Add API functions**

Read `dashboard/src/api.js` and find the existing `providers` export (or `providerCrud` export). Add two new methods. Use the existing `requestV2` helper (same pattern as routing templates API):

```js
  setApiKey: (provider, apiKey, opts = {}) =>
    requestV2(`/providers/${encodeURIComponent(provider)}/api-key`, { method: 'PUT', body: JSON.stringify({ api_key: apiKey }), ...opts }),
  clearApiKey: (provider, opts = {}) =>
    requestV2(`/providers/${encodeURIComponent(provider)}/api-key`, { method: 'DELETE', ...opts }),
```

Check how the existing provider API is structured — the methods might be on `providers` or `providerCrud`. Add to whichever object the Providers.jsx page imports.

- [x] **Step 2: Commit**

```bash
git add dashboard/src/api.js
git commit -m "feat: add provider API key management client functions"
```

---

### Task 7: Dashboard Provider Card Key UI

**Files:**
- Modify: `dashboard/src/views/Providers.jsx`

- [x] **Step 1: Add key management to ProviderCard**

This is the largest UI change. Read `dashboard/src/views/Providers.jsx` and modify the `ProviderCard` component.

Add new props: `onSetApiKey`, `onClearApiKey`

Add component state inside ProviderCard:
```js
const [showKeyInput, setShowKeyInput] = useState(false);
const [keyValue, setKeyValue] = useState('');
const [keyLoading, setKeyLoading] = useState(false);
```

Below the existing "Max Concurrent" input section (after line ~142), add the key management row. Only render for providers where `provider.provider_type === 'cloud-api' || provider.provider_type === 'custom'` (or where the provider is in a known cloud-api set like `['deepinfra', 'hyperbolic', 'groq', 'cerebras', 'google-ai', 'openrouter', 'ollama-cloud']`).

**Key row rendering by status:**

```jsx
{/* API Key Management */}
{isCloudProvider && (
  <div className="mt-3 pt-3 border-t border-slate-700/50">
    {provider.api_key_status === 'env' && (
      <div className="flex items-center gap-2">
        <span className="text-green-400 text-xs">&#128273;</span>
        <span className="text-xs text-green-400">Set via environment</span>
        <code className="text-[10px] text-slate-500 ml-1">{envVarName}</code>
      </div>
    )}
    {provider.api_key_status === 'stored' && !showKeyInput && (
      <div className="flex items-center gap-2">
        <span className="text-green-400 text-xs">&#128273;</span>
        <span className="text-xs text-slate-400 font-mono">{provider.api_key_masked || '<redacted>'}</span>
        <button onClick={() => setShowKeyInput(true)} className="text-xs text-blue-400 hover:text-blue-300 ml-auto">Change</button>
        <button onClick={() => onClearApiKey?.(provider.provider)} className="text-xs text-red-400 hover:text-red-300">Remove</button>
      </div>
    )}
    {provider.api_key_status === 'validating' && (
      <div className="flex items-center gap-2">
        <span className="text-amber-400 text-xs animate-spin">&#9881;</span>
        <span className="text-xs text-amber-400">Validating key...</span>
      </div>
    )}
    {(provider.api_key_status === 'not_set' || showKeyInput) && (
      <div className="flex items-center gap-2">
        {!showKeyInput ? (
          <>
            <span className="text-slate-500 text-xs">&#128273;</span>
            <span className="text-xs text-slate-500">No API key</span>
            <button onClick={() => setShowKeyInput(true)} className="text-xs text-blue-400 hover:text-blue-300 ml-auto">Add Key</button>
          </>
        ) : (
          <>
            <input type="password" value={keyValue} onChange={e => setKeyValue(e.target.value)}
              placeholder="Paste API key" maxLength={256}
              className="flex-1 px-2 py-1 bg-slate-800 border border-slate-600 rounded text-xs text-white" />
            <button disabled={!keyValue.trim() || keyLoading}
              onClick={async () => {
                setKeyLoading(true);
                await onSetApiKey?.(provider.provider, keyValue.trim());
                setKeyValue(''); setShowKeyInput(false); setKeyLoading(false);
              }}
              className="text-xs text-green-400 hover:text-green-300 disabled:opacity-40">Save</button>
            <button onClick={() => { setKeyValue(''); setShowKeyInput(false); }}
              className="text-xs text-slate-400 hover:text-slate-300">Cancel</button>
          </>
        )}
      </div>
    )}
  </div>
)}
```

Determine `isCloudProvider` from the provider data:
```js
const CLOUD_PROVIDERS = new Set(['deepinfra', 'hyperbolic', 'groq', 'cerebras', 'google-ai', 'openrouter', 'ollama-cloud', 'anthropic']);
const isCloudProvider = CLOUD_PROVIDERS.has(provider.provider) || provider.provider_type === 'cloud-api' || provider.provider_type === 'custom';
```

Map env var names for display:
```js
const ENV_VAR_NAMES = {
  deepinfra: 'DEEPINFRA_API_KEY', hyperbolic: 'HYPERBOLIC_API_KEY', groq: 'GROQ_API_KEY',
  cerebras: 'CEREBRAS_API_KEY', 'google-ai': 'GOOGLE_AI_API_KEY', openrouter: 'OPENROUTER_API_KEY',
  'ollama-cloud': 'OLLAMA_CLOUD_API_KEY', anthropic: 'ANTHROPIC_API_KEY', codex: 'OPENAI_API_KEY',
};
const envVarName = ENV_VAR_NAMES[provider.provider] || '';
```

In the parent component that renders `ProviderCard`, add handlers that call the API and refresh:
```js
const handleSetApiKey = async (providerName, apiKey) => {
  try {
    await providerCrud.setApiKey(providerName, apiKey);
    toast.success('API key saved');
    loadProviders(); // refresh list
  } catch (err) {
    toast.error(`Failed to save key: ${err.message}`);
  }
};

const handleClearApiKey = async (providerName) => {
  try {
    await providerCrud.clearApiKey(providerName);
    toast.success('API key cleared');
    loadProviders();
  } catch (err) {
    toast.error(`Failed to clear key: ${err.message}`);
  }
};
```

Pass `onSetApiKey={handleSetApiKey}` and `onClearApiKey={handleClearApiKey}` to each `ProviderCard`.

- [x] **Step 2: Build dashboard**

Run: `cd dashboard && npm run build`

- [x] **Step 3: Commit**

```bash
git add dashboard/src/views/Providers.jsx dashboard/src/api.js
git commit -m "feat: add inline API key management to provider cards"
```

---

### Task 8: Integration Tests

**Files:**
- Create: `server/tests/provider-api-key-integration.test.js`

- [ ] **Step 1: Write integration tests**

Create `server/tests/provider-api-key-integration.test.js` using `setupTestDb`:

```js
'use strict';
const { setupTestDb, teardownTestDb } = require('./vitest-setup');

describe('provider API key management integration', () => {
  let db;
  let handleToolCall;

  beforeAll(() => {
    ({ db, handleToolCall } = setupTestDb('provider-api-key-integration'));
  });

  afterAll(() => {
    teardownTestDb();
  });

  it('set_provider_api_key encrypts and stores key', async () => {
    const result = await handleToolCall('set_provider_api_key', { provider: 'groq', api_key: 'test-groq-key-12345' });
    const text = result?.content?.[0]?.text;
    expect(text).toBeTruthy();
    const parsed = JSON.parse(text);
    expect(parsed.status).toBe('saved');
    expect(parsed.masked).toContain('<redacted>');
    expect(parsed.validating).toBe(true);
  });

  it('getApiKey resolves the encrypted key', () => {
    const config = require('../config');
    // Should find the key we just set (no env var for groq in test)
    const origKey = process.env.GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;
    const key = config.getApiKey('groq');
    expect(key).toBe('test-groq-key-12345');
    if (origKey) process.env.GROQ_API_KEY = origKey;
  });

  it('clear_provider_api_key removes the key', async () => {
    const result = await handleToolCall('clear_provider_api_key', { provider: 'groq' });
    const text = result?.content?.[0]?.text;
    const parsed = JSON.parse(text);
    expect(parsed.status).toBe('cleared');

    const config = require('../config');
    const origKey = process.env.GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;
    expect(config.getApiKey('groq')).toBeNull();
    if (origKey) process.env.GROQ_API_KEY = origKey;
  });

  it('rejects empty api_key', async () => {
    const result = await handleToolCall('set_provider_api_key', { provider: 'groq', api_key: '' });
    expect(result?.isError).toBe(true);
  });

  it('rejects unknown provider', async () => {
    const result = await handleToolCall('set_provider_api_key', { provider: 'nonexistent', api_key: 'key' });
    expect(result?.isError || result?.content?.[0]?.text?.includes('not found')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run all tests**

Run: `cd server && npx vitest run tests/provider-api-key.test.js tests/provider-api-key-integration.test.js`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add server/tests/provider-api-key-integration.test.js
git commit -m "test: add provider API key management integration tests"
```

---

### Task 9: Final Verification

- [ ] **Step 1: Run full server test suite**

Run: `cd server && npx vitest run`
Expected: All tests pass, no regressions

- [ ] **Step 2: Run full dashboard test suite**

Run: `cd dashboard && npx vitest run`
Expected: All tests pass

- [ ] **Step 3: Build dashboard**

Run: `cd dashboard && npm run build`

- [ ] **Step 4: Restart TORQUE and smoke test**

1. Restart TORQUE
2. Open dashboard Providers page
3. Find a cloud provider card (e.g., DeepInfra) — should show "No API key"
4. Click "Add Key", paste a test key, click Save
5. Should see "Validating..." then status update
6. Refresh — should show masked key
7. Click "Remove" — key cleared
8. Verify via MCP: `set_provider_api_key { provider: "groq", api_key: "test" }`

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: complete provider API key management — encrypted storage, dashboard UI, MCP tools"
```
