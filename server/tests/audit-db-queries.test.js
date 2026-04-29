'use strict';

// Lightweight regression guards for scripts/audit-db-queries.js.
// The script is exported by name, so we can drive its parsers from
// vitest without spawning the CLI. Each test pins one observed
// false-positive class — bumping the audit's signal-to-noise ratio
// requires that none of these regress quietly.

const path = require('path');

const audit = require(path.join(__dirname, '..', '..', 'scripts', 'audit-db-queries.js'));

describe('scripts/audit-db-queries', () => {
  describe('extractIndexColumns', () => {
    it('parses CREATE INDEX with column list', () => {
      const schema = `CREATE INDEX idx_tasks_status ON tasks (status, created_at);`;
      const m = audit.extractIndexColumns(schema);
      expect(m.get('tasks')).toEqual([['status', 'created_at']]);
    });

    it('treats column-level INTEGER PRIMARY KEY as covering the id column', () => {
      const schema = `
        CREATE TABLE IF NOT EXISTS factory_projects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          status TEXT
        );
      `;
      const m = audit.extractIndexColumns(schema);
      // The PK must register as an index on (id) so a `WHERE id = ?`
      // lookup against this table is no longer flagged as a full scan.
      const idxs = m.get('factory_projects') || [];
      expect(idxs.some((cols) => cols.includes('id'))).toBe(true);
    });

    it('treats TEXT PRIMARY KEY as covering its column', () => {
      const schema = `
        CREATE TABLE IF NOT EXISTS config (
          key TEXT PRIMARY KEY,
          value TEXT
        );
      `;
      const m = audit.extractIndexColumns(schema);
      const idxs = m.get('config') || [];
      expect(idxs.some((cols) => cols.includes('key'))).toBe(true);
    });

    it('parses table-level composite PRIMARY KEY', () => {
      const schema = `
        CREATE TABLE IF NOT EXISTS task_claims (
          task_id TEXT NOT NULL,
          claimer TEXT NOT NULL,
          PRIMARY KEY (task_id, claimer)
        );
      `;
      const m = audit.extractIndexColumns(schema);
      const idxs = m.get('task_claims') || [];
      expect(idxs.some((cols) => cols.includes('task_id') && cols.includes('claimer'))).toBe(true);
    });
  });

  describe('scanFiles + checkViolations (case-sensitive SQL keywords)', () => {
    const fs = require('fs');
    const os = require('os');

    let tmpDir;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-db-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('does not match prose "from … the …" inside JSDoc/comments', () => {
      // The pre-fix audit flagged this as table=the with col=value.
      // After the case-sensitive switch, the lowercase prose is
      // ignored and the real `FROM ollama_hosts` farther up the
      // context is what gets matched.
      const file = path.join(tmpDir, 'sample.js');
      fs.writeFileSync(file, [
        '/**',
        ' * Periodic worker. Called from the health check cycle.',
        ' */',
        "function down() {",
        "  return db.prepare(`SELECT id, name FROM ollama_hosts WHERE status = 'down'`).all();",
        '}',
      ].join('\n'));

      const findings = audit.scanFiles([tmpDir]);
      // Whatever findings we produce must reference the real table,
      // not the prose word that used to leak through.
      for (const f of findings) {
        expect(f.table).not.toBe('the');
      }
    });
  });
});
