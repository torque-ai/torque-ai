'use strict';

const { randomUUID } = require('crypto');

function parseUrlHost(rawUrl) {
  if (!rawUrl) {
    return { host: null, port: null };
  }

  const candidates = [rawUrl];
  if (!/^https?:\/\//i.test(rawUrl)) {
    candidates.unshift(`http://${rawUrl}`);
  }

  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate);
      const port = parsed.port ? Number.parseInt(parsed.port, 10) : null;
      return { host: parsed.hostname || null, port: Number.isNaN(port) ? null : port };
    } catch (_e) {
      void _e;
    }
  }

  return { host: null, port: null };
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (_e) {
    void _e;
    return '{}';
  }
}

function migrateOllamaHosts(db, insertWorkstation) {
  const rows = db.prepare('SELECT * FROM ollama_hosts').all();
  if (!rows.length) return 0;

  let count = 0;
  for (const row of rows) {
    const now = new Date().toISOString();
    const parsed = parseUrlHost(row.url);
    const port = parsed.port || 11434;
    const capabilities = safeStringify({
      ollama: {
        detected: true,
        port,
      },
    });
    const secret = `migrated-ollama-${randomUUID()}`;

    const result = insertWorkstation.run(
      /* 1  id                   */ randomUUID(),
      /* 2  name                 */ row.name,
      /* 3  host                 */ parsed.host || row.url,
      /* 4  agent_port           */ 3460,
      /* 5  platform             */ null,
      /* 6  arch                 */ null,
      /* 7  tls_cert             */ null,
      /* 8  tls_fingerprint      */ null,
      /* 9  secret               */ secret,
      /* 10 capabilities         */ capabilities,
      /* 11 ollama_port          */ port,
      /* 12 models_cache         */ row.models_cache || null,
      /* 13 memory_limit_mb      */ row.memory_limit_mb || null,
      /* 14 settings             */ row.settings || null,
      /* 15 last_model_used      */ null,
      /* 16 model_loaded_at      */ null,
      /* 17 gpu_metrics_port     */ row.gpu_metrics_port || null,
      /* 18 models_updated_at    */ row.models_updated_at || null,
      /* 19 gpu_name             */ null,
      /* 20 gpu_vram_mb          */ null,
      /* 21 status               */ row.status || 'unknown',
      /* 22 consecutive_failures */ row.consecutive_failures || 0,
      /* 23 last_health_check    */ row.last_health_check || null,
      /* 24 last_healthy         */ row.last_healthy || null,
      /* 25 max_concurrent       */ row.max_concurrent || 1,
      /* 26 running_tasks        */ row.running_tasks || 0,
      /* 27 priority             */ row.priority || 10,
      /* 28 enabled              */ row.enabled === undefined ? 1 : row.enabled,
      /* 29 is_default           */ 0,
      /* 30 created_at           */ row.created_at || now,
      /* 31 updated_at           */ now
    );

    if (result.changes > 0) count += 1;
  }

  return count;
}

function migratePeekHosts(db, insertWorkstation) {
  const rows = db.prepare('SELECT * FROM peek_hosts').all();
  if (!rows.length) return 0;

  let count = 0;
  for (const row of rows) {
    const now = new Date().toISOString();
    const parsed = parseUrlHost(row.url);
    const capabilities = safeStringify({
      ui_capture: {
        detected: true,
        has_display: true,
      },
    });
    const secret = `migrated-peek-${randomUUID()}`;

    const result = insertWorkstation.run(
      /* 1  id                   */ row.id || randomUUID(),
      /* 2  name                 */ row.name,
      /* 3  host                 */ parsed.host || row.url,
      /* 4  agent_port           */ 3460,
      /* 5  platform             */ null,
      /* 6  arch                 */ null,
      /* 7  tls_cert             */ null,
      /* 8  tls_fingerprint      */ null,
      /* 9  secret               */ secret,
      /* 10 capabilities         */ capabilities,
      /* 11 ollama_port          */ null,
      /* 12 models_cache         */ null,
      /* 13 memory_limit_mb      */ null,
      /* 14 settings             */ null,
      /* 15 last_model_used      */ null,
      /* 16 model_loaded_at      */ null,
      /* 17 gpu_metrics_port     */ null,
      /* 18 models_updated_at    */ null,
      /* 19 gpu_name             */ null,
      /* 20 gpu_vram_mb          */ null,
      /* 21 status               */ row.status || 'unknown',
      /* 22 consecutive_failures */ row.consecutive_failures || 0,
      /* 23 last_health_check    */ row.last_health_check || null,
      /* 24 last_healthy         */ row.last_healthy || null,
      /* 25 max_concurrent       */ row.max_concurrent || 3,
      /* 26 running_tasks        */ row.running_tasks || 0,
      /* 27 priority             */ row.priority || 10,
      /* 28 enabled              */ row.enabled === undefined ? 1 : row.enabled,
      /* 29 is_default           */ row.is_default || 0,
      /* 30 created_at           */ row.created_at || now,
      /* 31 updated_at           */ now
    );

    if (result.changes > 0) count += 1;
  }

  return count;
}

function migrateRemoteAgents(db, insertWorkstation) {
  const rows = db.prepare('SELECT * FROM remote_agents').all();
  if (!rows.length) return 0;

  let count = 0;
  for (const row of rows) {
    const now = new Date().toISOString();
    const capabilities = safeStringify({
      command_exec: true,
      git_sync: true,
    });

    const result = insertWorkstation.run(
      /* 1  id                   */ row.id || randomUUID(),
      /* 2  name                 */ row.name,
      /* 3  host                 */ row.host,
      /* 4  agent_port           */ row.port || 3460,
      /* 5  platform             */ null,
      /* 6  arch                 */ null,
      /* 7  tls_cert             */ null,
      /* 8  tls_fingerprint      */ null,
      /* 9  secret               */ row.secret || null,
      /* 10 capabilities         */ capabilities,
      /* 11 ollama_port          */ null,
      /* 12 models_cache         */ null,
      /* 13 memory_limit_mb      */ null,
      /* 14 settings             */ null,
      /* 15 last_model_used      */ null,
      /* 16 model_loaded_at      */ null,
      /* 17 gpu_metrics_port     */ null,
      /* 18 models_updated_at    */ null,
      /* 19 gpu_name             */ null,
      /* 20 gpu_vram_mb          */ null,
      /* 21 status               */ row.status || 'unknown',
      /* 22 consecutive_failures */ row.consecutive_failures || 0,
      /* 23 last_health_check    */ row.last_health_check || null,
      /* 24 last_healthy         */ row.last_healthy || null,
      /* 25 max_concurrent       */ row.max_concurrent || 3,
      /* 26 running_tasks        */ row.running_tasks || 0,
      /* 27 priority             */ 10,
      /* 28 enabled              */ row.enabled === undefined ? 1 : row.enabled,
      /* 29 is_default           */ 0,
      /* 30 created_at           */ row.created_at || now,
      /* 31 updated_at           */ now
    );

    if (result.changes > 0) count += 1;
  }

  return count;
}

function relaxHostCredentialsConstraint(db) {
  const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='host_credentials'").get();
  if (!tableInfo || !tableInfo.sql) return;
  if (String(tableInfo.sql).toLowerCase().includes('workstation')) return;

  const backup = `host_credentials_backup_${Date.now()}`;
  try {
    db.exec(`ALTER TABLE host_credentials RENAME TO ${backup}`);
    db.exec(`
      CREATE TABLE host_credentials (
        id TEXT PRIMARY KEY,
        host_name TEXT NOT NULL,
        host_type TEXT NOT NULL CHECK(host_type IN ('ollama', 'peek', 'workstation')),
        credential_type TEXT NOT NULL CHECK(credential_type IN ('ssh', 'http_auth', 'windows')),
        label TEXT,
        encrypted_value TEXT NOT NULL,
        iv TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_host_credentials_unique ON host_credentials (host_name, host_type, credential_type)`);
    db.prepare(`
      INSERT INTO host_credentials (id, host_name, host_type, credential_type, label, encrypted_value, iv, auth_tag, created_at, updated_at)
      SELECT id, host_name, host_type, credential_type, label, encrypted_value, iv, auth_tag, created_at, updated_at
      FROM ${backup}
    `).run();
    db.exec(`DROP TABLE ${backup}`);
    // SQLite keeps the index name attached to the renamed backup table, so
    // the first CREATE UNIQUE INDEX IF NOT EXISTS can be skipped accidentally.
    // Re-create it after the backup table is dropped to guarantee the upsert key.
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_host_credentials_unique ON host_credentials (host_name, host_type, credential_type)`);
  } catch (e) {
    const current = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='host_credentials'").get();
    const backupExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='${backup}'`).get();
    if (backupExists) {
      if (current) {
        db.exec('DROP TABLE host_credentials');
      }
      db.exec(`ALTER TABLE ${backup} RENAME TO host_credentials`);
    }
    throw e;
  }
}

function migrateExistingHostsToWorkstations(db) {
  const result = { migrated: 0 };
  const insertWorkstation = db.prepare(`
    INSERT OR IGNORE INTO workstations (
      id, name, host, agent_port, platform, arch, tls_cert, tls_fingerprint, secret, capabilities,
      ollama_port, models_cache, memory_limit_mb, settings, last_model_used, model_loaded_at, gpu_metrics_port, models_updated_at, gpu_name, gpu_vram_mb,
      status, consecutive_failures, last_health_check, last_healthy, max_concurrent, running_tasks, priority, enabled, is_default,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  try {
    result.migrated += migrateOllamaHosts(db, insertWorkstation);
  } catch (_e) {
    void _e;
  }

  try {
    result.migrated += migratePeekHosts(db, insertWorkstation);
  } catch (_e) {
    void _e;
  }

  try {
    result.migrated += migrateRemoteAgents(db, insertWorkstation);
  } catch (_e) {
    void _e;
  }

  try {
    relaxHostCredentialsConstraint(db);
  } catch (_e) {
    void _e;
  }

  return result;
}

module.exports = {
  migrateExistingHostsToWorkstations,
};
