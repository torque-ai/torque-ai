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
    const secret = `migrated-ollama-${Date.now()}`;

    const result = insertWorkstation.run(
      randomUUID(),
      row.name,
      parsed.host || row.url,
      3460,
      null,
      null,
      null,
      null,
      secret,
      capabilities,
      port,
      row.models_cache || null,
      row.memory_limit_mb || null,
      row.settings || null,
      null,
      null,
      row.gpu_metrics_port || null,
      row.models_updated_at || null,
      null,
      null,
      row.status || 'unknown',
      row.consecutive_failures || 0,
      row.last_health_check || null,
      row.last_healthy || null,
      row.max_concurrent || 1,
      row.running_tasks || 0,
      row.priority || 10,
      row.enabled === undefined ? 1 : row.enabled,
      0,
      row.created_at || now,
      now
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

    const result = insertWorkstation.run(
      row.id || randomUUID(),
      row.name,
      parsed.host || row.url,
      3460,
      null,
      null,
      null,
      null,
      null,
      capabilities,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      row.status || 'unknown',
      row.consecutive_failures || 0,
      row.last_health_check || null,
      row.last_healthy || null,
      row.max_concurrent || 3,
      row.running_tasks || 0,
      row.priority || 10,
      row.enabled === undefined ? 1 : row.enabled,
      row.is_default || 0,
      row.created_at || now,
      now
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
      row.id || randomUUID(),
      row.name,
      row.host,
      row.port || 3460,
      null,
      null,
      null,
      null,
      row.secret || null,
      capabilities,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      row.status || 'unknown',
      row.consecutive_failures || 0,
      row.last_health_check || null,
      row.last_healthy || null,
      row.max_concurrent || 3,
      row.running_tasks || 0,
      10,
      row.enabled === undefined ? 1 : row.enabled,
      0,
      row.created_at || now,
      now
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
