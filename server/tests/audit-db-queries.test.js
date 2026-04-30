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

    it('parses PK from JS-array DDL pattern (no trailing semicolon after closing paren)', () => {
      // server/db/migrations.js builds DDL via [...].join('\n'). The
      // closing `)` is followed by `,` then `]` in JS source — no `;`.
      // The previous regex required `\)\s*;` to terminate the body
      // capture, so it either skipped these tables entirely or absorbed
      // unrelated content. The new line-based scanner stops at any line
      // that's effectively just the closing paren.
      const schema = [
        '        \'CREATE TABLE IF NOT EXISTS factory_architect_cycles (\',',
        '        \'  id INTEGER PRIMARY KEY AUTOINCREMENT,\',',
        '        \'  project_id TEXT NOT NULL,\',',
        '        \'  created_at TEXT NOT NULL\',',
        '        \')\',',
        '      ].join(\'\\n\'),',
      ].join('\n');
      const m = audit.extractIndexColumns(schema);
      const idxs = m.get('factory_architect_cycles') || [];
      expect(idxs.some((cols) => cols.includes('id'))).toBe(true);
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

  describe('readAllDbSchema', () => {
    const fs = require('fs');
    const os = require('os');

    let tmpDir;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-db-schema-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('reads CREATE TABLE blocks across every server/db/*.js file', () => {
      // Per-feature db modules carry their own schema (factory_decisions
      // in db/migrations.js, factory_worktrees in db/factory-worktrees.js,
      // etc.). The original audit only loaded schema-tables.js + schema.js,
      // so those tables looked schema-less and every WHERE against them
      // was reported as a full scan.
      const tasksDdl = 'CREATE TABLE tasks (id INTEGER PRIMARY KEY);';
      const worktreesDdl = 'CREATE TABLE factory_worktrees (id INTEGER PRIMARY KEY, project_id TEXT NOT NULL);';
      fs.writeFileSync(path.join(tmpDir, 'schema-tables.js'), `const ddl = ${JSON.stringify(tasksDdl)};`);
      fs.writeFileSync(path.join(tmpDir, 'factory-worktrees.js'), `const ddl = ${JSON.stringify(worktreesDdl)};`);

      const text = audit.readAllDbSchema(tmpDir);
      const m = audit.extractIndexColumns(text);
      // Both tables must register from independent files, including the
      // per-feature module name pattern.
      expect(m.has('tasks')).toBe(true);
      expect(m.has('factory_worktrees')).toBe(true);
    });
  });

  describe('SYSTEM_TABLES allowlist', () => {
    it('does not flag SELECT … FROM sqlite_master as a full scan', () => {
      // sqlite_master is a SQLite metadata table — it has no user-defined
      // index and the "WHERE name = …" pattern is the standard idiom.
      // Flagging this would push every reflection helper into the
      // false-positive bucket forever.
      const findings = [
        { file: 'a.js', line: 1, table: 'sqlite_master', cols: ['name'], sql: 'SELECT name FROM sqlite_master WHERE name = ?' },
      ];
      const idxMap = new Map();
      const viols = audit.checkViolations(findings, idxMap);
      expect(viols).toEqual([]);
    });

    it('also allows pragma_table_info', () => {
      const findings = [
        { file: 'a.js', line: 1, table: 'pragma_table_info', cols: ['name'], sql: 'SELECT name FROM pragma_table_info(...) WHERE name = ?' },
      ];
      const idxMap = new Map();
      const viols = audit.checkViolations(findings, idxMap);
      expect(viols).toEqual([]);
    });

    it('still flags real tables that lack a covering index', () => {
      const findings = [
        { file: 'a.js', line: 1, table: 'tasks', cols: ['unindexed_col'], sql: 'WHERE unindexed_col = ?' },
      ];
      const idxMap = new Map([['tasks', [['id']]]]);
      const viols = audit.checkViolations(findings, idxMap);
      expect(viols).toHaveLength(1);
    });
  });

  describe('extractWhereColumns word-boundary handling', () => {
    it('does not extract a column fragment from inside a string literal containing IN', () => {
      // Canonical bug: `WHERE t.status IN ('pending', 'queued')` parsed
      // as columns `[status, pend]` because the regex matched the
      // substring `IN` at position 5 of `pending`, treating `pend` as
      // a column. With \b boundaries on IN/LIKE/IS, only the real
      // `status IN` pair matches.
      const cols = audit.extractWhereColumns("t.status IN ('pending', 'queued')");
      expect(cols).toContain('status');
      expect(cols).not.toContain('pend');
      expect(cols).not.toContain('queue');
    });

    it('does not extract a fragment from a string literal containing LIKE', () => {
      // `name LIKE 'unliked%'` previously could have matched `unli` as
      // column=`unli` operator=`LIKE` against position 2 of `unliked`.
      const cols = audit.extractWhereColumns("name LIKE 'unliked%'");
      expect(cols).toContain('name');
      expect(cols).not.toContain('unli');
    });

    it('does not extract a fragment from a string literal containing IS', () => {
      // `tag = 'permissionless'` should give just `tag`, not `permiss`.
      const cols = audit.extractWhereColumns("tag = 'permissionless'");
      expect(cols).toContain('tag');
      expect(cols).not.toContain('permiss');
    });

    it('still parses standard IN/LIKE/IS clauses correctly', () => {
      const inCols = audit.extractWhereColumns('status IN (?,?,?)');
      expect(inCols).toEqual(['status']);
      const likeCols = audit.extractWhereColumns("name LIKE ?");
      expect(likeCols).toEqual(['name']);
      const isCols = audit.extractWhereColumns("deleted_at IS NULL");
      expect(isCols).toEqual(['deleted_at']);
    });

    it('handles compound operators (<=, >=, !=, <>) without splitting them', () => {
      const cols = audit.extractWhereColumns('created_at >= ? AND updated_at <= ? AND status != ? AND id <> ?');
      expect(cols.sort()).toEqual(['created_at', 'id', 'status', 'updated_at']);
    });
  });

  describe('trimWhereClauseToSqlBoundary + extractWhereColumns boundary handling', () => {
    it('trims at first quote so JS code after the SQL string is ignored', () => {
      // Real codebase pattern that produced false positive `r`:
      //   db.prepare('SELECT * FROM x WHERE enabled = 1').all().map(r => ...)
      // The line-based scanner captured everything after `WHERE`, so the
      // arrow-fn arg `r =` looked like another column comparison.
      const cols = audit.extractWhereColumns("enabled = 1').all().map(r => {");
      expect(cols).toEqual(['enabled']);
      expect(cols).not.toContain('r');
    });

    it("trims at the closing backtick of a template literal", () => {
      const trimmed = audit.trimWhereClauseToSqlBoundary("col = ?` ).all().map(x => x)");
      expect(trimmed).toBe('col = ?');
    });

    it('skips numeric "columns" like the 1=1 idiom', () => {
      // `WHERE 1=1` is a common no-op used to make AND-chain code generation
      // simpler. The audit used to extract `1` as a column.
      const cols = audit.extractWhereColumns('1=1');
      expect(cols).toEqual([]);
    });

    it('still rejects column names starting with a digit but accepts mixed alphanumerics', () => {
      // Underscore-leading and letter-leading identifiers are valid SQLite
      // column names; pure numeric isn't.
      const cols = audit.extractWhereColumns("_internal_id = ? AND col2 = ? AND 99 > 0");
      expect(cols.sort()).toEqual(['_internal_id', 'col2']);
    });
  });

  describe('checkViolations coverage semantics', () => {
    it('treats a multi-column WHERE as covered when ANY column has an index', () => {
      // SQLite uses the indexed column to drive the seek and filters the
      // remaining columns in memory. Reporting these as "full scan
      // candidates" was wrong — old logic flagged them whenever any
      // single column was uncovered.
      const findings = [
        { file: 'a.js', line: 1, table: 'distributed_locks', cols: ['lock_name', 'holder_id'], sql: 'WHERE lock_name = ? AND holder_id = ?' },
      ];
      const idxMap = new Map([['distributed_locks', [['lock_name']]]]);
      const viols = audit.checkViolations(findings, idxMap);
      expect(viols).toEqual([]);
    });

    it('still flags queries where NO column is indexed', () => {
      const findings = [
        { file: 'a.js', line: 1, table: 'tasks', cols: ['col_a', 'col_b'], sql: 'WHERE col_a = ? AND col_b = ?' },
      ];
      const idxMap = new Map([['tasks', [['id']]]]);
      const viols = audit.checkViolations(findings, idxMap);
      expect(viols).toHaveLength(1);
    });

    it('handles a single uncovered column the same as before', () => {
      const findings = [
        { file: 'a.js', line: 1, table: 'tasks', cols: ['unindexed_col'], sql: 'WHERE unindexed_col = ?' },
      ];
      const idxMap = new Map([['tasks', [['id']]]]);
      const viols = audit.checkViolations(findings, idxMap);
      expect(viols).toHaveLength(1);
    });
  });
});
