# Provider API Key Management — Design Spec

**Date:** 2026-03-17
**Status:** Draft (post-review revision 1)
**Scope:** Encrypted API key storage, dashboard UI for key management on provider cards, MCP tool parity, corporate-ready security model.

## Problem

TORQUE's cloud API providers (DeepInfra, Hyperbolic, Groq, etc.) require API keys, but there's no way to set them through the dashboard. Users must set environment variables or manually insert into the DB config table. The `provider_config.api_key_encrypted` column exists but stores keys as plaintext. This is unusable for corporate deployments where multiple users share a TORQUE instance and keys must be encrypted at rest.

## Goals

1. Users set/clear API keys per provider through the dashboard Providers page
2. Keys encrypted at rest using AES-256-GCM
3. Auto-generated encryption key for single-user setups, env var override for corporate
4. Dashboard never receives raw keys — only masked versions
5. Immediate save with async validation (health check) and status indicator
6. MCP tool parity for LLM-driven key management
7. Audit trail for key changes

## Non-Goals

- Multi-tenant key isolation (TORQUE Cloud scope, not self-hosted)
- Key rotation scheduling
- Per-user key scoping (all keys are instance-wide)
- Rate limiting on key endpoints (small team scale for v1)

---

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Encryption module | Reuse existing `server/utils/credential-crypto.js` | Already implements AES-256-GCM, auto-generated `secret.key` file, `TORQUE_SECRET_KEY` env var override, Windows-aware permissions, race-condition-safe key generation. No need for a second encryption system. |
| Storage format | Pack `iv:authTag:ciphertext` (hex) into single `api_key_encrypted` column | `credential-crypto.js` returns separate fields, but `api_key_encrypted` is a single TEXT column. A thin wrapper packs/unpacks the three hex fields with `:` separator. |
| Key resolution order | env var → `provider_config.api_key_encrypted` (decrypt) → DB config table | Env vars always win. Dashboard-set keys are second priority. Legacy config table is fallback. |
| Dashboard key visibility | Masked via `sensitive-keys.js` `redactValue()` — shows first 4 + last 4 chars with `<redacted>` in between | Consistent with existing redaction across the codebase. |
| Validation approach | Save immediately, validate async | User isn't blocked. Status indicator shows progress. 30-second timeout on validation before auto-clearing the validating state. |
| Key input type | Password field with paste | Dots in DOM, never visible as plaintext in browser. |
| Route parameter | `:provider` (provider name string, not UUID) | `provider_config` uses `provider` (name) as primary key. Consistent with existing `handleAddProvider`/`handleRemoveProvider`. |

---

## Encryption Layer

Reuses `server/utils/credential-crypto.js` which provides:

- **Key management:** `getOrCreateKey()` — checks `TORQUE_SECRET_KEY` env var first, then reads/creates `TORQUE_DATA_DIR/secret.key` (hex-encoded, 0600 perms on non-Windows). Cached in memory after first load.
- **Encrypt:** `encrypt(value, key)` → `{ encrypted_value, iv, auth_tag }` (all hex strings)
- **Decrypt:** `decrypt(encrypted_value, iv, auth_tag, key)` → parsed value

### Single-Column Packing

Since `provider_config.api_key_encrypted` is a single TEXT column, a thin wrapper packs/unpacks:

```
Pack:   encrypt(apiKey, key) → "${iv}:${auth_tag}:${encrypted_value}" (hex, colon-separated)
Unpack: split on ':' → [iv, auth_tag, encrypted_value] → decrypt(encrypted_value, iv, auth_tag, key)
```

New helper functions added to `provider-crud-handlers.js` (not a new module):

```js
function encryptApiKey(plaintext) {
  const key = credentialCrypto.getOrCreateKey();
  const { encrypted_value, iv, auth_tag } = credentialCrypto.encrypt(plaintext, key);
  return `${iv}:${auth_tag}:${encrypted_value}`;
}

function decryptApiKey(packed) {
  if (!packed || !packed.includes(':')) return null;  // plaintext or empty
  const parts = packed.split(':');
  if (parts.length !== 3) return null;
  try {
    const key = credentialCrypto.getOrCreateKey();
    return credentialCrypto.decrypt(parts[2], parts[0], parts[1], key);
  } catch {
    return null;  // wrong key, tampered, or corrupt — treat as "no key set"
  }
}
```

### Plaintext Migration

Existing values in `api_key_encrypted` stored by `handleAddProvider` are plaintext (no `:` separator). The `decryptApiKey` function detects this: if the value doesn't contain `:`, it returns `null` (treats as no valid encrypted key). `getApiKey()` then falls through to the DB config table.

On the next `handleSetApiKey` call for that provider, the plaintext is overwritten with a properly encrypted value. No bulk migration needed — keys re-encrypt naturally on first dashboard edit.

The existing `handleAddProvider` is also updated to encrypt the `api_key` parameter at insertion time, so new providers added via MCP get encrypted storage from the start.

### Windows Security Note

On Windows, POSIX file permissions (`0600`) are ignored by NTFS. The existing `credential-crypto.js` already handles this by only warning on non-win32 platforms. For corporate Windows deployments, NTFS ACLs should be configured by the sysadmin to restrict access to the `TORQUE_DATA_DIR` directory. Alternatively, set `TORQUE_SECRET_KEY` as an environment variable so the key file is not needed on disk.

---

## API Key Resolution (Updated)

`config.js` `getApiKey(provider)` updated resolution chain:

```
1. Environment variable (DEEPINFRA_API_KEY, etc.) — highest priority
2. provider_config.api_key_encrypted — decrypt via decryptApiKey(), use if valid
3. DB config table (legacy: deepinfra_api_key row) — fallback
4. null
```

Step 2 is new. Requires a DB query: `SELECT api_key_encrypted FROM provider_config WHERE provider = ?`. This means keys set through the dashboard are automatically found by all existing routing, execution, and health check code without any changes to consumers.

If decryption fails (wrong key, tampered value, plaintext legacy value), step 2 returns `null` and resolution continues to step 3. No errors thrown.

---

## API Endpoints

### REST (Dashboard)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `PUT /api/v2/providers/:provider/api-key` | PUT | Set or update API key |
| `DELETE /api/v2/providers/:provider/api-key` | DELETE | Clear stored API key |

`:provider` is the provider name string (e.g., `deepinfra`, `groq`), matching the `provider_config.provider` primary key.

**PUT request body:**
```json
{ "api_key": "sk-abc123..." }
```

**PUT response:**
```json
{
  "data": {
    "status": "saved",
    "masked": "sk-a...<redacted>...b123",
    "validating": true
  }
}
```

**DELETE response:**
```json
{
  "data": { "status": "cleared" }
}
```

**DELETE on env-var key:** If the key comes from an environment variable, DELETE clears only the DB-stored encrypted value (if any). The env var continues to provide the key. Response is `{ "status": "cleared" }` — idempotent, no error.

**Error responses:**

| Scenario | Status | Code |
|----------|--------|------|
| Provider not found | 404 | `PROVIDER_NOT_FOUND` |
| Empty/missing api_key | 400 | `VALIDATION_ERROR` |
| Key too long (>256 chars) | 400 | `VALIDATION_ERROR` |

No GET endpoint for raw keys — ever.

### Provider List Enhancement

The existing provider list response (served by `v2-governance-handlers.js` `handleListProviders`) gains two new fields per provider:

- `api_key_status`: `"not_set"` | `"env"` | `"stored"` | `"validating"`
- `api_key_masked`: masked key string (only when status is `"stored"` or `"env"`)

Status meanings:
- `not_set` — no key in env var or DB
- `env` — key comes from environment variable (managed outside TORQUE, not editable via dashboard). `api_key_masked` shows the redacted env var value.
- `stored` — key is encrypted in `provider_config.api_key_encrypted`. `api_key_masked` shows the redacted decrypted value.
- `validating` — key was just saved, async health check in progress. `api_key_masked` shows the redacted value.

Masking uses `sensitive-keys.js` `redactValue()`: first 4 + last 4 chars with `<redacted>` between. Values 12 chars or shorter show `<redacted>` only.

### MCP Tools

| Tool | Purpose |
|------|---------|
| `set_provider_api_key` | Set API key for a provider. Args: `{ provider, api_key }`. Encrypts and stores. Triggers health check. |
| `clear_provider_api_key` | Clear stored API key. Args: `{ provider }` |

Both tools return the same response shape as the REST endpoints.

---

## Dashboard UI

### Provider Card — Key Management Row

Added below the existing concurrency control on each provider card. Only renders for providers with `provider_type` of `cloud-api` or `custom`.

**State: `not_set`**
- Gray key icon + "No API key" text
- "Add Key" button → reveals inline password input with Save/Cancel

**State: `env`**
- Green key icon + "Set via environment" text
- Env var name in mono text (e.g., `DEEPINFRA_API_KEY`)
- No edit controls

**State: `stored`**
- Green key icon + masked value (from `api_key_masked`)
- "Change" button → reveals input
- "Remove" button → confirmation, then DELETE call

**State: `validating`**
- Amber spinning indicator + "Validating key..." text
- Transitions to `stored` + health status once health check completes or 30s timeout

**Failed validation UX:** After validation completes with a health check failure, the card shows `stored` status with the masked key PLUS a red warning badge on the provider's health indicator (e.g., "Authentication failed"). The key remains stored — the user can click "Change" to enter a corrected key or "Remove" to clear it.

**Input field:**
- `type="password"` (dots, not plaintext)
- Paste-friendly
- Save button → PUT call, then clear input from DOM
- Cancel button → collapse input
- Max length 256

**Validation feedback:**
- After save, card shows "Validating..." with amber spinner
- Dashboard receives `stats:updated` WebSocket event when health check completes
- On success: green checkmark, provider health updates
- On failure: red warning icon + error message from health check

---

## Async Health Check on Key Save

After encrypting and storing the key:

1. Set an in-memory flag: `validatingProviders.set(providerId, Date.now())`
2. Trigger an immediate health check for that provider (call existing health check infrastructure)
3. Health check uses the newly stored key (via `getApiKey()` resolution)
4. On completion (success or failure): remove from `validatingProviders`, push `stats:updated` WebSocket event
5. Dashboard receives the event, re-fetches provider status, indicator updates

**Timeout:** When building the provider list response, entries in `validatingProviders` older than 30 seconds are auto-removed (stale validation). The provider appears as `stored` instead of `validating`.

**Server restart:** The in-memory `validatingProviders` map is lost. Keys saved before restart appear as `stored` immediately (health check runs on the normal 60s cycle). This is acceptable — the user sees the key is saved, and health status catches up shortly.

---

## Security Hardening

- **Never log raw keys** — existing `logger.js` redaction covers `*_API_KEY` patterns. Handlers log `"API key set for provider {name}"` at info level — no key content.
- **Never return raw keys in API responses** — provider list endpoints use `redactValue()` from `sensitive-keys.js` for all masked values.
- **Input sanitization** — trim whitespace, reject empty strings, max 256 characters.
- **DOM security** — password input type, input cleared from React state after save.
- **Secret file permissions** — `credential-crypto.js` creates `secret.key` with `0600` on non-Windows. On Windows, NTFS ACLs must be configured by the admin, or use `TORQUE_SECRET_KEY` env var to avoid the file entirely.
- **`secret.key` in `.gitignore`** — already handled by existing gitignore patterns for `TORQUE_DATA_DIR`. Add explicit `secret.key` pattern as defense in depth.
- **Auth tag verification** — AES-256-GCM auth tag prevents tampering with encrypted values. Modified ciphertext fails decryption, returns null.
- **TLS** — the spec assumes localhost access for self-hosted. Corporate deployments with remote dashboard access should terminate TLS at a reverse proxy. This is the deployer's responsibility, not TORQUE's.
- **Memory exposure** — the encryption key and decrypted API keys exist in process memory. A heap dump would expose them. This is a known limitation of all in-process secret management, not specific to TORQUE. Documented for security audits.

---

## Testing Strategy

### Unit Tests (~8)

- `encryptApiKey` → `decryptApiKey` round-trip returns original value
- `decryptApiKey` with tampered packed value returns null (auth tag failure)
- `decryptApiKey` with plaintext (no `:`) returns null (legacy migration)
- `decryptApiKey` with empty/null returns null
- `config.js getApiKey()`: env var takes precedence over encrypted DB value
- `config.js getApiKey()`: encrypted DB value used when no env var
- `config.js getApiKey()`: failed decryption falls through to config table gracefully
- Input validation: empty key rejected, long key rejected, whitespace trimmed

### Integration Tests (~5)

- PUT api-key → provider list shows `stored` status + masked value
- PUT api-key → `getApiKey()` returns the plaintext key
- DELETE api-key → provider list shows `not_set`
- PUT api-key → async health check triggered (provider health updated)
- MCP tool round-trip: `set_provider_api_key` → `getApiKey()` → `clear_provider_api_key`

### Dashboard Tests (~2)

- Provider card renders key status for cloud-api providers
- "Add Key" button reveals input, Save triggers API call

---

## Files to Create

| File | Purpose |
|------|---------|
| `server/tests/provider-api-key.test.js` | Unit tests for encrypt/decrypt helpers and getApiKey resolution |
| `server/tests/provider-api-key-integration.test.js` | Integration tests for key management endpoints |

## Files to Modify

| File | Change |
|------|--------|
| `server/config.js` | `getApiKey()` adds encrypted key resolution step: query `provider_config.api_key_encrypted`, decrypt, use if valid |
| `server/handlers/provider-crud-handlers.js` | Add `encryptApiKey`/`decryptApiKey` helpers using `credential-crypto.js`. Add `handleSetApiKey`, `handleClearApiKey` handlers. Update `handleAddProvider` to encrypt `api_key` at insertion. |
| `server/tool-defs/provider-crud-defs.js` | Add `set_provider_api_key` and `clear_provider_api_key` tool definitions |
| `server/api/routes.js` | Add `PUT /api/v2/providers/:provider/api-key` and `DELETE /api/v2/providers/:provider/api-key` routes with handler names `handleV2CpSetProviderApiKey` and `handleV2CpClearProviderApiKey` |
| `server/api/v2-dispatch.js` | Add dispatch handlers `handleV2CpSetProviderApiKey` and `handleV2CpClearProviderApiKey` in `V2_CP_HANDLER_LOOKUP` |
| `server/api/v2-governance-handlers.js` | Enrich `handleListProviders` response with `api_key_status` and `api_key_masked` fields per provider |
| `dashboard/src/views/Providers.jsx` | Add key management row to provider cards (states: not_set, env, stored, validating) |
| `dashboard/src/api.js` | Add `providers.setApiKey(provider, key)` and `providers.clearApiKey(provider)` |

---

## Success Criteria

1. User opens Providers page, sees "No API key" on DeepInfra card, clicks "Add Key", pastes key, saves — card shows "Validating..." then green checkmark
2. DeepInfra tasks now route successfully (key resolved via `getApiKey()`)
3. User refreshes page — card shows masked key (e.g., `sk-a...<redacted>...xyz`), never raw
4. User clicks "Remove" — key cleared, provider shows "No API key" again
5. Sysadmin sets `TORQUE_SECRET_KEY` env var — keys encrypted with that secret, DB file alone is useless
6. Provider with key set via env var shows "Set via environment" — not editable
7. LLM calls `set_provider_api_key` via MCP — key stored, immediately usable
8. Encrypted value in DB is tampered — decryption fails gracefully, provider shows "No API key"
9. Existing plaintext values in `api_key_encrypted` — decryption returns null, falls through to config table. Re-encrypted on next dashboard save.
