# Fabro #99: Managed OAuth + Behavioral Tool Tags (Composio)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Layer **managed OAuth** on top of Plan 52's connection registry: split credentials into `auth_configs` (per-toolkit blueprints) and `connected_accounts` (per-user live sessions with refresh + enable/disable lifecycle). Add **behavioral tool tags** (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) so agents and policies can reason about safety before execution. Inspired by Composio.

**Architecture:** Two new tables (`auth_configs`, `connected_accounts`) extend the Plan 52 schema. An OAuth controller handles authorize-URL generation, token exchange, and refresh rotation. A `tool-behavioral-tags.js` module adds a standard tag shape onto every MCP tool registration. Session resolution picks a connected account by `(user_id, toolkit)` with explicit override support.

**Tech Stack:** Node.js, better-sqlite3, generic OAuth 2.0 code-flow. Builds on Plan 52.

---

## File Structure

**New files:**
- `server/migrations/0XX-managed-oauth-tables.sql`
- `server/auth/auth-config-store.js`
- `server/auth/connected-account-store.js`
- `server/auth/oauth-controller.js`
- `server/tools/behavioral-tags.js`
- `server/tests/auth-config-store.test.js`
- `server/tests/connected-account-store.test.js`
- `server/tests/behavioral-tags.test.js`

**Modified files:**
- `server/connections/registry.js` (Plan 52) — delegate auth lookups to new stores
- `server/handlers/mcp-tools.js` — `start_oauth_flow`, `complete_oauth_flow`, `list_connected_accounts`, `disable_account`, `delete_account`

---

## Task 1: Schema + stores

- [x] **Step 1: Migration**

Create `server/migrations/0XX-managed-oauth-tables.sql`:

```sql
CREATE TABLE auth_configs (
  id TEXT PRIMARY KEY,
  toolkit TEXT NOT NULL,
  auth_type TEXT NOT NULL CHECK (auth_type IN ('oauth2','api_key','basic','bearer')),
  client_id TEXT,
  client_secret_enc TEXT,
  authorize_url TEXT,
  token_url TEXT,
  scopes TEXT,
  redirect_uri TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (toolkit)
);

CREATE TABLE connected_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  toolkit TEXT NOT NULL,
  auth_config_id TEXT NOT NULL REFERENCES auth_configs(id),
  access_token_enc TEXT,
  refresh_token_enc TEXT,
  expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','revoked','expired')),
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_conn_accounts_user_toolkit ON connected_accounts(user_id, toolkit);
CREATE INDEX idx_conn_accounts_status ON connected_accounts(status);
```

- [x] **Step 2: Store tests**

Create `server/tests/auth-config-store.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/setup-test-db');
const { createAuthConfigStore } = require('../auth/auth-config-store');

describe('authConfigStore', () => {
  let db, store;
  beforeEach(() => {
    db = setupTestDb(['0XX-managed-oauth-tables.sql']);
    store = createAuthConfigStore({ db });
  });

  it('upsert + get', () => {
    store.upsert({ toolkit: 'github', auth_type: 'oauth2', client_id: 'cid', authorize_url: 'https://github.com/login/oauth/authorize', token_url: 'https://github.com/login/oauth/access_token', scopes: 'repo user' });
    const c = store.getByToolkit('github');
    expect(c.auth_type).toBe('oauth2');
    expect(c.scopes).toBe('repo user');
  });

  it('upsert replaces on same toolkit', () => {
    store.upsert({ toolkit: 'github', auth_type: 'oauth2', client_id: 'v1' });
    store.upsert({ toolkit: 'github', auth_type: 'oauth2', client_id: 'v2' });
    expect(store.getByToolkit('github').client_id).toBe('v2');
  });
});
```

Create `server/tests/connected-account-store.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/setup-test-db');
const { createAuthConfigStore } = require('../auth/auth-config-store');
const { createConnectedAccountStore } = require('../auth/connected-account-store');

describe('connectedAccountStore', () => {
  let db, configs, accounts;
  beforeEach(() => {
    db = setupTestDb(['0XX-managed-oauth-tables.sql']);
    configs = createAuthConfigStore({ db });
    configs.upsert({ toolkit: 'github', auth_type: 'oauth2', client_id: 'cid' });
    accounts = createConnectedAccountStore({ db });
  });

  it('create + find by user + toolkit', () => {
    const cfg = configs.getByToolkit('github');
    accounts.create({ user_id: 'alice', toolkit: 'github', auth_config_id: cfg.id, access_token: 'tok1', expires_at: Date.now() + 3600e3 });
    const a = accounts.findActive({ user_id: 'alice', toolkit: 'github' });
    expect(a.status).toBe('active');
    expect(a.access_token).toBe('tok1');
  });

  it('findActive returns most recent when multiple exist', () => {
    const cfg = configs.getByToolkit('github');
    accounts.create({ user_id: 'alice', toolkit: 'github', auth_config_id: cfg.id, access_token: 'old' });
    accounts.create({ user_id: 'alice', toolkit: 'github', auth_config_id: cfg.id, access_token: 'new' });
    expect(accounts.findActive({ user_id: 'alice', toolkit: 'github' }).access_token).toBe('new');
  });

  it('disable flips status without deleting tokens', () => {
    const cfg = configs.getByToolkit('github');
    const id = accounts.create({ user_id: 'alice', toolkit: 'github', auth_config_id: cfg.id, access_token: 'tok' });
    accounts.disable(id);
    expect(accounts.findActive({ user_id: 'alice', toolkit: 'github' })).toBeUndefined();
    expect(accounts.get(id).status).toBe('disabled');
  });

  it('delete removes the row', () => {
    const cfg = configs.getByToolkit('github');
    const id = accounts.create({ user_id: 'alice', toolkit: 'github', auth_config_id: cfg.id, access_token: 'tok' });
    accounts.delete(id);
    expect(accounts.get(id)).toBeUndefined();
  });
});
```

- [x] **Step 3: Implement stores**

Create `server/auth/auth-config-store.js`:

```js
'use strict';
const { randomUUID } = require('crypto');

function createAuthConfigStore({ db, crypto = require('./crypto-helper') }) {
  return {
    upsert({ toolkit, auth_type, client_id, client_secret, authorize_url, token_url, scopes, redirect_uri }) {
      const existing = db.prepare('SELECT id FROM auth_configs WHERE toolkit=?').get(toolkit);
      const id = existing?.id || `ac_${randomUUID().slice(0, 12)}`;
      const secret_enc = client_secret ? crypto.encrypt(client_secret) : null;
      db.prepare(`
        INSERT INTO auth_configs (id,toolkit,auth_type,client_id,client_secret_enc,authorize_url,token_url,scopes,redirect_uri,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(toolkit) DO UPDATE SET auth_type=excluded.auth_type, client_id=excluded.client_id, client_secret_enc=excluded.client_secret_enc, authorize_url=excluded.authorize_url, token_url=excluded.token_url, scopes=excluded.scopes, redirect_uri=excluded.redirect_uri
      `).run(id, toolkit, auth_type, client_id || null, secret_enc, authorize_url || null, token_url || null, scopes || null, redirect_uri || null, Date.now());
      return id;
    },
    getByToolkit(toolkit) {
      return db.prepare('SELECT * FROM auth_configs WHERE toolkit=?').get(toolkit);
    },
    list() { return db.prepare('SELECT * FROM auth_configs ORDER BY toolkit').all(); },
  };
}

module.exports = { createAuthConfigStore };
```

Create `server/auth/connected-account-store.js`:

```js
'use strict';
const { randomUUID } = require('crypto');

function createConnectedAccountStore({ db, crypto = require('./crypto-helper') }) {
  return {
    create({ user_id, toolkit, auth_config_id, access_token, refresh_token, expires_at, metadata = {} }) {
      const id = `ca_${randomUUID().slice(0, 12)}`;
      const now = Date.now();
      db.prepare(`
        INSERT INTO connected_accounts (id,user_id,toolkit,auth_config_id,access_token_enc,refresh_token_enc,expires_at,status,metadata_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run(id, user_id, toolkit, auth_config_id, crypto.encrypt(access_token || ''), refresh_token ? crypto.encrypt(refresh_token) : null, expires_at || null, 'active', JSON.stringify(metadata), now, now);
      return id;
    },
    get(id) {
      const row = db.prepare('SELECT * FROM connected_accounts WHERE id=?').get(id);
      return row ? decrypt(row, crypto) : undefined;
    },
    findActive({ user_id, toolkit }) {
      const row = db.prepare(`SELECT * FROM connected_accounts WHERE user_id=? AND toolkit=? AND status='active' ORDER BY updated_at DESC LIMIT 1`).get(user_id, toolkit);
      return row ? decrypt(row, crypto) : undefined;
    },
    disable(id) { db.prepare(`UPDATE connected_accounts SET status='disabled', updated_at=? WHERE id=?`).run(Date.now(), id); },
    delete(id) { db.prepare('DELETE FROM connected_accounts WHERE id=?').run(id); },
  };
}

function decrypt(row, crypto) {
  return {
    ...row,
    access_token: row.access_token_enc ? crypto.decrypt(row.access_token_enc) : null,
    refresh_token: row.refresh_token_enc ? crypto.decrypt(row.refresh_token_enc) : null,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
  };
}

module.exports = { createConnectedAccountStore };
```

Run tests → PASS. Commit: `feat(auth): managed-oauth tables + auth-config + connected-account stores`.

---

## Task 2: OAuth controller + behavioral tags

- [ ] **Step 1: OAuth controller**

Create `server/auth/oauth-controller.js`:

```js
'use strict';

function createOAuthController({ authConfigStore, connectedAccountStore, fetchFn = fetch }) {
  return {
    startFlow({ toolkit, state }) {
      const cfg = authConfigStore.getByToolkit(toolkit);
      if (!cfg) throw new Error(`no auth_config for ${toolkit}`);
      const params = new URLSearchParams({
        client_id: cfg.client_id,
        redirect_uri: cfg.redirect_uri,
        response_type: 'code',
        scope: cfg.scopes || '',
        state,
      });
      return `${cfg.authorize_url}?${params.toString()}`;
    },
    async exchangeCode({ toolkit, code, user_id }) {
      const cfg = authConfigStore.getByToolkit(toolkit);
      const res = await fetchFn(cfg.token_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ code, client_id: cfg.client_id, redirect_uri: cfg.redirect_uri, grant_type: 'authorization_code' }).toString(),
      });
      const tok = await res.json();
      if (!tok.access_token) throw new Error('no access_token in token response');
      const expires_at = tok.expires_in ? Date.now() + tok.expires_in * 1000 : null;
      const id = connectedAccountStore.create({
        user_id, toolkit, auth_config_id: cfg.id,
        access_token: tok.access_token,
        refresh_token: tok.refresh_token,
        expires_at,
      });
      return { connected_account_id: id };
    },
  };
}

module.exports = { createOAuthController };
```

- [ ] **Step 2: Behavioral tags tests**

Create `server/tests/behavioral-tags.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { applyBehavioralTags, filterByTags, BEHAVIORAL_TAG_KEYS } = require('../tools/behavioral-tags');

describe('behavioralTags', () => {
  it('applyBehavioralTags fills defaults for missing hints', () => {
    const tool = applyBehavioralTags({ name: 'read_file' }, { readOnlyHint: true });
    expect(tool.readOnlyHint).toBe(true);
    expect(tool.destructiveHint).toBe(false);
    expect(tool.idempotentHint).toBe(true);
    expect(tool.openWorldHint).toBe(false);
  });

  it('destructiveHint implies non-idempotent by default', () => {
    const tool = applyBehavioralTags({ name: 'delete_file' }, { destructiveHint: true });
    expect(tool.destructiveHint).toBe(true);
    expect(tool.idempotentHint).toBe(false);
  });

  it('filterByTags keeps tools matching ALL hints', () => {
    const tools = [
      { name: 'a', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      { name: 'b', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      { name: 'c', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    ];
    expect(filterByTags(tools, { readOnlyHint: true, openWorldHint: false }).map(t => t.name)).toEqual(['a']);
  });

  it('BEHAVIORAL_TAG_KEYS exposes the canonical tag names', () => {
    expect(BEHAVIORAL_TAG_KEYS).toEqual(['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']);
  });
});
```

- [ ] **Step 3: Implement tags**

Create `server/tools/behavioral-tags.js`:

```js
'use strict';

const BEHAVIORAL_TAG_KEYS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];

function applyBehavioralTags(tool, hints = {}) {
  const t = { ...tool };
  t.readOnlyHint = hints.readOnlyHint ?? false;
  t.destructiveHint = hints.destructiveHint ?? false;
  t.idempotentHint = hints.idempotentHint ?? (t.destructiveHint ? false : true);
  t.openWorldHint = hints.openWorldHint ?? false;
  return t;
}

function filterByTags(tools, hints) {
  return tools.filter(t => BEHAVIORAL_TAG_KEYS.every(k => hints[k] === undefined || t[k] === hints[k]));
}

module.exports = { applyBehavioralTags, filterByTags, BEHAVIORAL_TAG_KEYS };
```

Run tests → PASS. Commit: `feat(auth): oauth-controller + behavioral tool tags`.

---

## Task 3: MCP surface + registry wiring

- [ ] **Step 1: MCP tools**

In `server/handlers/mcp-tools.js`:

```js
start_oauth_flow: {
  description: 'Begin an OAuth flow for a toolkit. Returns an authorize_url the user must visit.',
  inputSchema: { type: 'object', required: ['toolkit', 'user_id'], properties: { toolkit: { type: 'string' }, user_id: { type: 'string' } } },
},
complete_oauth_flow: {
  description: 'Exchange an authorization code for tokens and create a connected_account.',
  inputSchema: { type: 'object', required: ['toolkit', 'user_id', 'code'], properties: { toolkit: { type: 'string' }, user_id: { type: 'string' }, code: { type: 'string' } } },
},
list_connected_accounts: {
  description: 'List connected_accounts for a user (optionally filtered by toolkit).',
  inputSchema: { type: 'object', required: ['user_id'], properties: { user_id: { type: 'string' }, toolkit: { type: 'string' } } },
},
disable_account: {
  description: 'Disable a connected_account without deleting tokens.',
  inputSchema: { type: 'object', required: ['account_id'], properties: { account_id: { type: 'string' } } },
},
delete_account: {
  description: 'Hard-delete a connected_account.',
  inputSchema: { type: 'object', required: ['account_id'], properties: { account_id: { type: 'string' } } },
},
list_tools_by_hints: {
  description: 'Filter registered tools by behavioral hints (readOnlyHint, destructiveHint, idempotentHint, openWorldHint).',
  inputSchema: { type: 'object', properties: { readOnlyHint: { type: 'boolean' }, destructiveHint: { type: 'boolean' }, idempotentHint: { type: 'boolean' }, openWorldHint: { type: 'boolean' } } },
},
```

- [ ] **Step 2: Delegate Plan 52 registry + apply tags on tool registration**

In `server/connections/registry.js`: replace the old credential-lookup path with `connectedAccountStore.findActive({ user_id, toolkit })`.

In every place TORQUE registers an MCP tool, wrap with `applyBehavioralTags(tool, hints)` using hints stored alongside tool metadata (new `behavioral_hints_json` column on `tools` table or in-code annotations).

Smoke: set an auth_config for a fake OAuth toolkit, run `start_oauth_flow` → URL returned; simulate `complete_oauth_flow` with a fake fetch → account created. Run `list_tools_by_hints { readOnlyHint: true }` → only read tools returned.

Commit: `feat(auth): MCP surface + Plan 52 integration + tool-registration tagging`.
