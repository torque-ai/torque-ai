# Fabro #81: Workspaces + Synced Data Sources (Dust)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Layer a **Workspace / Spaces** model above Plan 38 domains — workspaces hold team members + Spaces (open/restricted); Spaces own shared data, workflows, agents, and permissions. Add a **synced data source registry** that periodically ingests from external sources (Notion, Slack, GitHub, Google Drive, URLs, uploaded folders) into spaces. Permissions on spaces gate what data, workflows, and agents each member sees. Inspired by Dust.

**Architecture:** Three layers:
- **Workspaces + Spaces** — `workspaces`, `spaces`, `space_members`. Domains (Plan 38) become defaults; spaces are the tighter boundary.
- **Data source registry** — `data_sources` with `kind` (notion/slack/github/drive/folder/url), `connection_id` (Plan 52), `sync_config`, `last_synced_at`. Chunks are stored in `data_source_chunks` with `space_id` scope.
- **Sync engine** — a scheduler pulls from each source on its configured cadence, diffs new/changed chunks, updates the chunk index (vector index reuses Plan 47's archival embeddings).

**Tech Stack:** Node.js, better-sqlite3, Plan 47 archival memory, Plan 48 Firecrawl, Plan 52 connections. Builds on plans 38, 47, 52.

---

## File Structure

**New files:**
- `server/migrations/0NN-workspaces-data-sources.sql`
- `server/workspace/workspace-store.js`
- `server/workspace/space-permissions.js`
- `server/data-sources/registry.js`
- `server/data-sources/sync-engine.js`
- `server/data-sources/connectors/folder.js`
- `server/data-sources/connectors/url.js`
- `server/data-sources/connectors/github.js`
- `server/tests/workspace-store.test.js`
- `server/tests/space-permissions.test.js`
- `server/tests/sync-engine.test.js`

**Modified files:**
- `server/handlers/mcp-tools.js` — `create_space`, `invite_member`, `add_data_source`, `sync_now`

---

## Task 1: Workspaces + permissions

- [ ] **Step 1: Migration**

`server/migrations/0NN-workspaces-data-sources.sql`:

```sql
CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  owner_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS spaces (
  space_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'open',   -- 'open' | 'restricted'
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (workspace_id, name),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS space_members (
  space_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',  -- 'member' | 'builder' | 'admin'
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (space_id, user_id),
  FOREIGN KEY (space_id) REFERENCES spaces(space_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS data_sources (
  source_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- 'folder' | 'url' | 'github' | 'notion' | 'slack' | 'drive'
  connection_id TEXT,                  -- FK into connections (Plan 52)
  sync_config_json TEXT,
  sync_cron TEXT,                      -- e.g., '0 */6 * * *'
  last_synced_at TEXT,
  last_sync_status TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (space_id) REFERENCES spaces(space_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS data_source_chunks (
  chunk_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  external_id TEXT,                    -- source-native id (page, file, message, commit)
  content TEXT NOT NULL,
  metadata_json TEXT,
  embedding_json TEXT,
  chunk_hash TEXT NOT NULL,
  synced_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (source_id) REFERENCES data_sources(source_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chunks_space ON data_source_chunks(space_id);
CREATE INDEX IF NOT EXISTS idx_chunks_external ON data_source_chunks(source_id, external_id);
```

- [ ] **Step 2: Permissions tests**

Create `server/tests/space-permissions.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createSpacePermissions } = require('../workspace/space-permissions');

describe('spacePermissions', () => {
  let db, perms;
  beforeEach(() => {
    db = setupTestDb();
    db.prepare(`INSERT INTO workspaces (workspace_id, name) VALUES ('ws-1','acme')`).run();
    db.prepare(`INSERT INTO spaces (space_id, workspace_id, name, kind) VALUES ('sp-open','ws-1','engineering','open'),('sp-restricted','ws-1','finance','restricted')`).run();
    db.prepare(`INSERT INTO space_members (space_id, user_id, role) VALUES ('sp-restricted','alice','admin'),('sp-restricted','bob','member')`).run();
    perms = createSpacePermissions({ db });
  });

  it('open space: any workspace member can view', () => {
    expect(perms.canView({ userId: 'any', spaceId: 'sp-open' })).toBe(true);
  });

  it('restricted space: only explicit members can view', () => {
    expect(perms.canView({ userId: 'alice', spaceId: 'sp-restricted' })).toBe(true);
    expect(perms.canView({ userId: 'charlie', spaceId: 'sp-restricted' })).toBe(false);
  });

  it('canBuild requires builder or admin role', () => {
    expect(perms.canBuild({ userId: 'alice', spaceId: 'sp-restricted' })).toBe(true);
    expect(perms.canBuild({ userId: 'bob', spaceId: 'sp-restricted' })).toBe(false);
  });

  it('canManage requires admin role', () => {
    expect(perms.canManage({ userId: 'alice', spaceId: 'sp-restricted' })).toBe(true);
    expect(perms.canManage({ userId: 'bob', spaceId: 'sp-restricted' })).toBe(false);
  });

  it('listVisibleSpaces returns open spaces + spaces user is member of', () => {
    const visible = perms.listVisibleSpaces({ workspaceId: 'ws-1', userId: 'bob' });
    const ids = visible.map(s => s.space_id).sort();
    expect(ids).toEqual(['sp-open', 'sp-restricted']);
    const charlie = perms.listVisibleSpaces({ workspaceId: 'ws-1', userId: 'charlie' });
    expect(charlie.map(s => s.space_id)).toEqual(['sp-open']);
  });
});
```

- [ ] **Step 3: Implement**

Create `server/workspace/space-permissions.js`:

```js
'use strict';

function createSpacePermissions({ db }) {
  function getSpace(spaceId) {
    return db.prepare('SELECT * FROM spaces WHERE space_id = ?').get(spaceId);
  }
  function memberRole(spaceId, userId) {
    const row = db.prepare('SELECT role FROM space_members WHERE space_id = ? AND user_id = ?').get(spaceId, userId);
    return row?.role || null;
  }

  function canView({ userId, spaceId }) {
    const space = getSpace(spaceId);
    if (!space) return false;
    if (space.kind === 'open') return true;
    return memberRole(spaceId, userId) !== null;
  }

  function canBuild({ userId, spaceId }) {
    const role = memberRole(spaceId, userId);
    return role === 'builder' || role === 'admin';
  }

  function canManage({ userId, spaceId }) {
    return memberRole(spaceId, userId) === 'admin';
  }

  function listVisibleSpaces({ workspaceId, userId }) {
    return db.prepare(`
      SELECT s.* FROM spaces s
      WHERE s.workspace_id = ?
        AND (s.kind = 'open' OR EXISTS (
          SELECT 1 FROM space_members m WHERE m.space_id = s.space_id AND m.user_id = ?
        ))
      ORDER BY s.name
    `).all(workspaceId, userId);
  }

  return { canView, canBuild, canManage, listVisibleSpaces };
}

module.exports = { createSpacePermissions };
```

Run tests → PASS. Commit: `feat(workspace): permissions with open/restricted + role hierarchy`.

---

## Task 2: Workspace store + data source registry

- [ ] **Step 1: Workspace store tests**

Create `server/tests/workspace-store.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createWorkspaceStore } = require('../workspace/workspace-store');

describe('workspaceStore', () => {
  let db, store;
  beforeEach(() => { db = setupTestDb(); store = createWorkspaceStore({ db }); });

  it('createWorkspace + createSpace', () => {
    const wsId = store.createWorkspace({ name: 'acme' });
    const spaceId = store.createSpace({ workspaceId: wsId, name: 'engineering', kind: 'open' });
    expect(spaceId).toMatch(/^space_/);
    const spaces = store.listSpaces(wsId);
    expect(spaces).toHaveLength(1);
  });

  it('addMember + getMembers', () => {
    const wsId = store.createWorkspace({ name: 'x' });
    const sId = store.createSpace({ workspaceId: wsId, name: 'y', kind: 'restricted' });
    store.addMember({ spaceId: sId, userId: 'alice', role: 'admin' });
    store.addMember({ spaceId: sId, userId: 'bob', role: 'member' });
    const members = store.getMembers(sId);
    expect(members).toHaveLength(2);
  });

  it('removeMember', () => {
    const wsId = store.createWorkspace({ name: 'x' });
    const sId = store.createSpace({ workspaceId: wsId, name: 'y', kind: 'restricted' });
    store.addMember({ spaceId: sId, userId: 'alice' });
    store.removeMember({ spaceId: sId, userId: 'alice' });
    expect(store.getMembers(sId)).toHaveLength(0);
  });

  it('createWorkspace name is unique', () => {
    store.createWorkspace({ name: 'dup' });
    expect(() => store.createWorkspace({ name: 'dup' })).toThrow();
  });
});
```

- [ ] **Step 2: Implement**

Create `server/workspace/workspace-store.js`:

```js
'use strict';
const { randomUUID } = require('crypto');

function createWorkspaceStore({ db }) {
  function createWorkspace({ name, ownerUserId = null }) {
    const id = `ws_${randomUUID().slice(0, 12)}`;
    db.prepare(`INSERT INTO workspaces (workspace_id, name, owner_user_id) VALUES (?,?,?)`).run(id, name, ownerUserId);
    return id;
  }
  function listWorkspaces() { return db.prepare('SELECT * FROM workspaces ORDER BY name').all(); }
  function createSpace({ workspaceId, name, kind = 'open', description = null }) {
    const id = `space_${randomUUID().slice(0, 12)}`;
    db.prepare(`INSERT INTO spaces (space_id, workspace_id, name, kind, description) VALUES (?,?,?,?,?)`)
      .run(id, workspaceId, name, kind, description);
    return id;
  }
  function listSpaces(workspaceId) {
    return db.prepare('SELECT * FROM spaces WHERE workspace_id = ? ORDER BY name').all(workspaceId);
  }
  function addMember({ spaceId, userId, role = 'member' }) {
    db.prepare(`INSERT OR REPLACE INTO space_members (space_id, user_id, role) VALUES (?,?,?)`).run(spaceId, userId, role);
  }
  function removeMember({ spaceId, userId }) {
    db.prepare('DELETE FROM space_members WHERE space_id = ? AND user_id = ?').run(spaceId, userId);
  }
  function getMembers(spaceId) {
    return db.prepare('SELECT * FROM space_members WHERE space_id = ? ORDER BY user_id').all(spaceId);
  }

  return { createWorkspace, listWorkspaces, createSpace, listSpaces, addMember, removeMember, getMembers };
}

module.exports = { createWorkspaceStore };
```

Run tests → PASS. Commit: `feat(workspace): store with workspaces/spaces/members`.

---

## Task 3: Data source sync engine

- [ ] **Step 1: Tests**

Create `server/tests/sync-engine.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach, vi } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createSyncEngine } = require('../data-sources/sync-engine');

describe('syncEngine.syncSource', () => {
  let db, engine, connectorMock;
  beforeEach(() => {
    db = setupTestDb();
    db.prepare(`INSERT INTO workspaces (workspace_id, name) VALUES ('w','x')`).run();
    db.prepare(`INSERT INTO spaces (space_id, workspace_id, name, kind) VALUES ('s','w','y','open')`).run();
    db.prepare(`INSERT INTO data_sources (source_id, space_id, name, kind) VALUES ('ds-1','s','notes','folder')`).run();
    connectorMock = {
      fetchAll: vi.fn(async () => [
        { external_id: 'f1', content: 'hello' },
        { external_id: 'f2', content: 'world' },
      ]),
    };
    engine = createSyncEngine({ db, connectors: { folder: connectorMock } });
  });

  it('syncSource ingests chunks + sets last_synced_at', async () => {
    const r = await engine.syncSource('ds-1');
    expect(r.added).toBe(2);
    const ds = db.prepare('SELECT last_synced_at FROM data_sources WHERE source_id = ?').get('ds-1');
    expect(ds.last_synced_at).not.toBeNull();
  });

  it('re-sync with unchanged content is a no-op (hash match)', async () => {
    await engine.syncSource('ds-1');
    const r = await engine.syncSource('ds-1');
    expect(r.added).toBe(0);
    expect(r.unchanged).toBe(2);
  });

  it('re-sync with modified content updates chunk', async () => {
    await engine.syncSource('ds-1');
    connectorMock.fetchAll.mockResolvedValueOnce([
      { external_id: 'f1', content: 'hello CHANGED' },
      { external_id: 'f2', content: 'world' },
    ]);
    const r = await engine.syncSource('ds-1');
    expect(r.updated).toBe(1);
    expect(r.unchanged).toBe(1);
  });

  it('deleted externals are removed', async () => {
    await engine.syncSource('ds-1');
    connectorMock.fetchAll.mockResolvedValueOnce([{ external_id: 'f1', content: 'hello' }]);
    const r = await engine.syncSource('ds-1');
    expect(r.deleted).toBe(1);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM data_source_chunks WHERE source_id = ?`).get('ds-1').n).toBe(1);
  });

  it('unknown source kind fails cleanly', async () => {
    db.prepare(`INSERT INTO data_sources (source_id, space_id, name, kind) VALUES ('bad','s','z','unknown')`).run();
    const r = await engine.syncSource('bad');
    expect(r.error).toMatch(/unknown/i);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/data-sources/sync-engine.js`:

```js
'use strict';
const crypto = require('crypto');
const { randomUUID } = require('crypto');

function hashContent(s) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function createSyncEngine({ db, connectors, embed = null, logger = console }) {
  async function syncSource(sourceId) {
    const ds = db.prepare('SELECT * FROM data_sources WHERE source_id = ?').get(sourceId);
    if (!ds) return { error: `unknown source: ${sourceId}` };
    const connector = connectors[ds.kind];
    if (!connector) {
      db.prepare(`UPDATE data_sources SET last_sync_status = 'error', last_synced_at = datetime('now') WHERE source_id = ?`).run(sourceId);
      return { error: `unknown kind: ${ds.kind}` };
    }

    let items;
    try {
      items = await connector.fetchAll({ config: ds.sync_config_json ? JSON.parse(ds.sync_config_json) : {}, connectionId: ds.connection_id });
    } catch (err) {
      db.prepare(`UPDATE data_sources SET last_sync_status = ?, last_synced_at = datetime('now') WHERE source_id = ?`).run(`error: ${err.message}`, sourceId);
      return { error: err.message };
    }

    const existing = new Map(db.prepare('SELECT external_id, chunk_id, chunk_hash FROM data_source_chunks WHERE source_id = ?').all(sourceId).map(r => [r.external_id, r]));
    let added = 0, updated = 0, unchanged = 0, deleted = 0;
    const seen = new Set();
    for (const item of items) {
      seen.add(item.external_id);
      const hash = hashContent(item.content);
      const existingRow = existing.get(item.external_id);
      if (existingRow && existingRow.chunk_hash === hash) { unchanged++; continue; }
      const embedding = embed ? JSON.stringify(await embed(item.content)) : null;
      if (existingRow) {
        db.prepare(`UPDATE data_source_chunks SET content = ?, chunk_hash = ?, embedding_json = ?, synced_at = datetime('now'), metadata_json = ? WHERE chunk_id = ?`)
          .run(item.content, hash, embedding, item.metadata ? JSON.stringify(item.metadata) : null, existingRow.chunk_id);
        updated++;
      } else {
        const id = `chunk_${randomUUID().slice(0, 12)}`;
        db.prepare(`INSERT INTO data_source_chunks (chunk_id, source_id, space_id, external_id, content, chunk_hash, embedding_json, metadata_json) VALUES (?,?,?,?,?,?,?,?)`)
          .run(id, sourceId, ds.space_id, item.external_id, item.content, hash, embedding, item.metadata ? JSON.stringify(item.metadata) : null);
        added++;
      }
    }
    // Delete chunks that no longer exist upstream
    for (const [extId, row] of existing) {
      if (!seen.has(extId)) {
        db.prepare('DELETE FROM data_source_chunks WHERE chunk_id = ?').run(row.chunk_id);
        deleted++;
      }
    }
    db.prepare(`UPDATE data_sources SET last_synced_at = datetime('now'), last_sync_status = 'ok' WHERE source_id = ?`).run(sourceId);
    return { source_id: sourceId, added, updated, unchanged, deleted };
  }

  return { syncSource };
}

module.exports = { createSyncEngine };
```

Run tests → PASS. Commit: `feat(data-sources): sync engine with add/update/unchanged/delete diff`.

---

## Task 4: Connectors + MCP + scheduler

- [ ] **Step 1: Folder + URL connectors**

Create `server/data-sources/connectors/folder.js`:

```js
'use strict';
const fs = require('fs');
const path = require('path');

async function fetchAll({ config }) {
  const root = config.root_path;
  const globs = config.file_extensions || ['.md', '.txt'];
  const results = [];
  walk(root);
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (globs.some(ext => full.endsWith(ext))) {
        results.push({
          external_id: path.relative(root, full),
          content: fs.readFileSync(full, 'utf8'),
          metadata: { size: fs.statSync(full).size },
        });
      }
    }
  }
  return results;
}

module.exports = { fetchAll };
```

Create `server/data-sources/connectors/url.js`: fetches a list of URLs (config.urls or via Plan 74 Firecrawl) and returns chunked markdown.

Create `server/data-sources/connectors/github.js`: uses a connection for the GitHub token, pulls issues + PRs + README from configured repos.

- [ ] **Step 2: MCP tools**

```js
create_workspace: { description: 'Create a workspace.', inputSchema: {...} },
create_space: { description: 'Create a space within a workspace.', inputSchema: {...} },
invite_member: { description: 'Add a user to a space with a role.', inputSchema: {...} },
add_data_source: { description: 'Register a data source in a space and optionally start first sync.', inputSchema: {...} },
sync_now: { description: 'Trigger an immediate sync for a data source.', inputSchema: { type: 'object', required: ['source_id'], properties: { source_id: { type: 'string' } } } },
list_space_chunks: { description: 'List chunks visible in a space (optionally filtered by source).', inputSchema: {...} },
```

- [ ] **Step 3: Scheduler tick**

In `server/index.js` after init:

```js
const engine = defaultContainer.get('syncEngine');
setInterval(async () => {
  const due = db.prepare(`SELECT source_id FROM data_sources WHERE sync_cron IS NOT NULL`).all();
  for (const s of due) {
    if (isDue(s.source_id)) await engine.syncSource(s.source_id);
  }
}, 60 * 1000);
```

`await_restart`. Smoke: `create_workspace({name:'acme'})`, `create_space({name:'eng', kind:'open'})`, `add_data_source({kind:'folder', config:{root_path:'./docs'}})`, `sync_now`. Confirm chunks appear. Modify a doc, sync again, confirm the chunk updates.

Commit: `feat(workspace): connectors + scheduler + MCP surface for data sources`.
