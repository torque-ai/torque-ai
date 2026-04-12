# Fabro #52: Connection Registry + Auth Lifecycle (Activepieces)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Promote credentials (API keys, OAuth tokens, basic-auth, custom auth) from scattered per-tool config fields into a **first-class connection registry** with type, scope (global/project), validation hooks, and reuse across workflows. Inspired by Activepieces.

**Architecture:** A new `connections` table stores named credentials with a typed schema. A `connection-registry.js` exposes `create`, `validate`, `get`, `list`, `redact`, and `use` — the `use` method returns a one-shot handle that decrypts the secret and passes it to the calling tool without the secret passing through workflow JSON. Per-plugin `auth_schema` declares what a connection needs; validation hooks call the target API to confirm credentials before first use.

**Tech Stack:** Node.js, better-sqlite3, existing secrets-at-rest encryption (or Node crypto AES-GCM via a key from `TORQUE_CONN_KEY`). Builds on plans 38 (domains), 50 (plugin catalog).

---

## File Structure

**New files:**
- `server/migrations/0NN-connections.sql`
- `server/connections/connection-registry.js`
- `server/connections/encryption.js` — AES-GCM at rest
- `server/connections/validator.js` — invokes plugin-supplied validator
- `server/tests/connection-registry.test.js`
- `server/tests/encryption.test.js`
- `dashboard/src/views/Connections.jsx`

**Modified files:**
- `server/handlers/mcp-tools.js` — `create_connection`, `list_connections`, `delete_connection`, `test_connection`
- `server/tool-defs/`

---

## Task 1: Encryption + migration

- [ ] **Step 1: Migration**

`server/migrations/0NN-connections.sql`:

```sql
CREATE TABLE IF NOT EXISTS connections (
  connection_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  auth_type TEXT NOT NULL,               -- 'api_key' | 'basic' | 'bearer' | 'oauth2' | 'custom'
  encrypted_payload BLOB NOT NULL,
  iv BLOB NOT NULL,
  auth_tag BLOB NOT NULL,
  scope TEXT NOT NULL DEFAULT 'project', -- 'global' | 'project' | 'user'
  domain_id TEXT,
  external_id TEXT,
  validated_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (name, domain_id)
);

CREATE INDEX IF NOT EXISTS idx_connections_plugin ON connections(plugin_id);
CREATE INDEX IF NOT EXISTS idx_connections_domain ON connections(domain_id);
```

- [ ] **Step 2: Encryption tests**

Create `server/tests/encryption.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { encrypt, decrypt, deriveKey } = require('../connections/encryption');

describe('connection encryption', () => {
  const key = deriveKey('test-secret-passphrase-that-is-long-enough');

  it('encrypt/decrypt roundtrip returns original plaintext', () => {
    const pt = JSON.stringify({ api_key: 'sk-123', note: 'keep secret' });
    const { encrypted, iv, authTag } = encrypt(pt, key);
    const decrypted = decrypt(encrypted, key, iv, authTag);
    expect(decrypted).toBe(pt);
  });

  it('wrong key fails to decrypt', () => {
    const wrongKey = deriveKey('different-passphrase-entirely-xx');
    const { encrypted, iv, authTag } = encrypt('hello', key);
    expect(() => decrypt(encrypted, wrongKey, iv, authTag)).toThrow();
  });

  it('tampered ciphertext fails authenticate', () => {
    const { encrypted, iv, authTag } = encrypt('hello', key);
    const tampered = Buffer.from(encrypted);
    tampered[0] ^= 0xff;
    expect(() => decrypt(tampered, key, iv, authTag)).toThrow();
  });
});
```

- [ ] **Step 3: Implement**

Create `server/connections/encryption.js`:

```js
'use strict';
const crypto = require('crypto');

function deriveKey(passphrase) {
  return crypto.scryptSync(passphrase, 'torque-conn-salt', 32);
}

function encrypt(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { encrypted, iv, authTag };
}

function decrypt(encrypted, key, iv, authTag) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

module.exports = { deriveKey, encrypt, decrypt };
```

Run tests → PASS. Commit: `feat(connections): AES-GCM at-rest encryption`.

---

## Task 2: Registry

- [ ] **Step 1: Tests**

Create `server/tests/connection-registry.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach, vi } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createConnectionRegistry } = require('../connections/connection-registry');

describe('connectionRegistry', () => {
  let db, reg;
  beforeEach(() => {
    db = setupTestDb();
    reg = createConnectionRegistry({ db, passphrase: 'test-passphrase-for-conn-keys' });
  });

  it('create stores encrypted payload', () => {
    const id = reg.create({
      name: 'my-github', pluginId: 'torque.tool.github',
      authType: 'api_key', payload: { token: 'gh_abc' }, scope: 'global',
    });
    expect(id).toMatch(/^conn_/);
    const row = db.prepare('SELECT * FROM connections WHERE connection_id = ?').get(id);
    expect(row.encrypted_payload.length).toBeGreaterThan(0);
    // Ciphertext is NOT the plaintext
    expect(row.encrypted_payload.toString()).not.toMatch(/gh_abc/);
  });

  it('get returns redacted view by default', () => {
    const id = reg.create({ name: 'x', pluginId: 'p', authType: 'api_key', payload: { token: 'secret' } });
    const got = reg.get(id);
    expect(got.name).toBe('x');
    expect(got.payload).toBeUndefined(); // redacted
  });

  it('use returns plaintext payload in a one-shot handle', () => {
    const id = reg.create({ name: 'x', pluginId: 'p', authType: 'api_key', payload: { token: 'secret-xyz' } });
    const handle = reg.use(id);
    expect(handle.payload.token).toBe('secret-xyz');
    // Mutates last_used_at
    const row = db.prepare('SELECT last_used_at FROM connections WHERE connection_id = ?').get(id);
    expect(row.last_used_at).not.toBeNull();
  });

  it('list returns all for a domain, redacted', () => {
    reg.create({ name: 'a', pluginId: 'p', authType: 'api_key', payload: { token: '1' }, domainId: 'd1' });
    reg.create({ name: 'b', pluginId: 'p', authType: 'api_key', payload: { token: '2' }, domainId: 'd1' });
    reg.create({ name: 'c', pluginId: 'p', authType: 'api_key', payload: { token: '3' }, domainId: 'd2' });
    const inD1 = reg.list({ domainId: 'd1' });
    expect(inD1.map(c => c.name).sort()).toEqual(['a', 'b']);
  });

  it('validate calls the validator fn + updates validated_at', async () => {
    const id = reg.create({ name: 'x', pluginId: 'p', authType: 'api_key', payload: { token: 't' } });
    const validatorFn = vi.fn(async (payload) => ({ ok: true }));
    const r = await reg.validate(id, validatorFn);
    expect(r.ok).toBe(true);
    expect(validatorFn).toHaveBeenCalledWith({ token: 't' });
    const row = db.prepare('SELECT validated_at FROM connections WHERE connection_id = ?').get(id);
    expect(row.validated_at).not.toBeNull();
  });

  it('delete removes from table', () => {
    const id = reg.create({ name: 'x', pluginId: 'p', authType: 'api_key', payload: { token: 't' } });
    reg.delete(id);
    expect(reg.get(id)).toBeNull();
  });
});
```

- [ ] **Step 2: Implement**

Create `server/connections/connection-registry.js`:

```js
'use strict';
const { randomUUID } = require('crypto');
const { deriveKey, encrypt, decrypt } = require('./encryption');

function createConnectionRegistry({ db, passphrase }) {
  const key = deriveKey(passphrase || process.env.TORQUE_CONN_KEY || 'default-insecure');

  function create({ name, pluginId, authType, payload, scope = 'project', domainId = null, externalId = null }) {
    const id = `conn_${randomUUID().slice(0, 12)}`;
    const { encrypted, iv, authTag } = encrypt(JSON.stringify(payload), key);
    db.prepare(`
      INSERT INTO connections (connection_id, name, plugin_id, auth_type, encrypted_payload, iv, auth_tag, scope, domain_id, external_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, pluginId, authType, encrypted, iv, authTag, scope, domainId, externalId);
    return id;
  }

  function get(connectionId) {
    const row = db.prepare('SELECT * FROM connections WHERE connection_id = ?').get(connectionId);
    if (!row) return null;
    // Return redacted view: no payload
    const { encrypted_payload, iv, auth_tag, ...redacted } = row;
    return redacted;
  }

  function use(connectionId) {
    const row = db.prepare('SELECT * FROM connections WHERE connection_id = ?').get(connectionId);
    if (!row) throw new Error(`Connection not found: ${connectionId}`);
    const plaintext = decrypt(row.encrypted_payload, key, row.iv, row.auth_tag);
    db.prepare(`UPDATE connections SET last_used_at = datetime('now') WHERE connection_id = ?`).run(connectionId);
    return {
      connection_id: connectionId,
      name: row.name,
      plugin_id: row.plugin_id,
      auth_type: row.auth_type,
      payload: JSON.parse(plaintext),
    };
  }

  function list({ domainId = null, pluginId = null, scope = null } = {}) {
    const filters = [];
    const params = [];
    if (domainId) { filters.push('domain_id = ?'); params.push(domainId); }
    if (pluginId) { filters.push('plugin_id = ?'); params.push(pluginId); }
    if (scope)    { filters.push('scope = ?');     params.push(scope); }
    const where = filters.length ? 'WHERE ' + filters.join(' AND ') : '';
    return db.prepare(`
      SELECT connection_id, name, plugin_id, auth_type, scope, domain_id, external_id, validated_at, last_used_at, created_at
      FROM connections ${where} ORDER BY name
    `).all(...params);
  }

  async function validate(connectionId, validatorFn) {
    const used = use(connectionId);
    const result = await validatorFn(used.payload);
    if (result?.ok) {
      db.prepare(`UPDATE connections SET validated_at = datetime('now') WHERE connection_id = ?`).run(connectionId);
    }
    return result;
  }

  function del(connectionId) {
    db.prepare('DELETE FROM connections WHERE connection_id = ?').run(connectionId);
  }

  return { create, get, use, list, validate, delete: del };
}

module.exports = { createConnectionRegistry };
```

Run tests → PASS. Commit: `feat(connections): registry with create/get/use/validate/delete`.

---

## Task 3: MCP tools + dashboard

- [ ] **Step 1: Tool defs**

In `server/tool-defs/`:

```js
create_connection: {
  description: 'Create a named credential for a plugin. Payload is encrypted at rest.',
  inputSchema: {
    type: 'object',
    required: ['name', 'plugin_id', 'auth_type', 'payload'],
    properties: {
      name: { type: 'string' },
      plugin_id: { type: 'string' },
      auth_type: { type: 'string', enum: ['api_key', 'basic', 'bearer', 'oauth2', 'custom'] },
      payload: { type: 'object' },
      scope: { type: 'string', enum: ['global', 'project', 'user'], default: 'project' },
      domain_id: { type: 'string' },
    },
  },
},
list_connections: {
  description: 'List connections (redacted).',
  inputSchema: { type: 'object', properties: { domain_id: {type:'string'}, plugin_id: {type:'string'}, scope: {type:'string'} } },
},
test_connection: {
  description: 'Validate a connection by calling the plugin\'s auth validator.',
  inputSchema: { type: 'object', required: ['connection_id'], properties: { connection_id: {type:'string'} } },
},
delete_connection: {
  description: 'Remove a connection. Any tasks referencing it will fail until reconfigured.',
  inputSchema: { type: 'object', required: ['connection_id'], properties: { connection_id: {type:'string'} } },
},
```

- [ ] **Step 2: Handlers**

```js
case 'create_connection':
  return { connection_id: defaultContainer.get('connectionRegistry').create(args) };
case 'list_connections':
  return { connections: defaultContainer.get('connectionRegistry').list(args) };
case 'test_connection': {
  const reg = defaultContainer.get('connectionRegistry');
  const catalog = defaultContainer.get('pluginCatalog');
  const conn = reg.get(args.connection_id);
  const plugin = catalog.getPlugin(conn.plugin_id);
  const validator = plugin?.provides?.authValidator;
  if (!validator) return { ok: false, error: 'plugin has no auth validator' };
  return await reg.validate(args.connection_id, validator);
}
case 'delete_connection':
  defaultContainer.get('connectionRegistry').delete(args.connection_id);
  return { ok: true };
```

- [ ] **Step 3: Container + dashboard**

```js
container.factory('connectionRegistry', (c) => {
  const { createConnectionRegistry } = require('./connections/connection-registry');
  return createConnectionRegistry({ db: c.get('db'), passphrase: process.env.TORQUE_CONN_KEY });
});
```

Dashboard: `Connections.jsx` lists all connections with redacted status, validate buttons, and a "New connection" form selecting plugin + auth type + payload fields from the plugin's auth schema.

`await_restart`. Smoke: `create_connection({name:'gh-prod', plugin_id:'torque.tool.github', auth_type:'api_key', payload:{token:'gh_xxx'}})`. Run `test_connection`. Confirm validated_at gets stamped. Delete, confirm gone.

Commit: `feat(connections): MCP tools + dashboard for connection lifecycle`.
