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

    it('treats a column-level UNIQUE constraint as a covering index', () => {
      // SQLite auto-creates a covering index for any UNIQUE column. The
      // audit was missing this and flagging `WHERE name = ?` against
      // `cost_budgets` as a full scan even though the column is unique.
      const schema = `
        CREATE TABLE IF NOT EXISTS cost_budgets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          limit_cents INTEGER
        );
      `;
      const m = audit.extractIndexColumns(schema);
      const idxs = m.get('cost_budgets') || [];
      // PK index (id) + UNIQUE index (name) both register.
      expect(idxs.some((cols) => cols.length === 1 && cols[0] === 'name')).toBe(true);
    });

    it('does not flag a WHERE on a UNIQUE column as a full scan', () => {
      // End-to-end: extract + checkViolations on the cost_budgets pattern.
      const schema = `
        CREATE TABLE IF NOT EXISTS cost_budgets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE
        );
      `;
      const idxMap = audit.extractIndexColumns(schema);
      const findings = [
        { file: 'a.js', line: 1, table: 'cost_budgets', cols: ['name'], sql: 'WHERE name = ?' },
      ];
      expect(audit.checkViolations(findings, idxMap)).toEqual([]);
    });

    it('treats a table-level UNIQUE (col1, col2) as a composite covering index', () => {
      const schema = `
        CREATE TABLE IF NOT EXISTS factory_branches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id TEXT NOT NULL,
          branch TEXT NOT NULL,
          UNIQUE (project_id, branch)
        );
      `;
      const m = audit.extractIndexColumns(schema);
      const idxs = m.get('factory_branches') || [];
      expect(idxs.some((cols) => cols.includes('project_id') && cols.includes('branch'))).toBe(true);
    });

    it('keeps PK and UNIQUE indexes as separate entries (not merged)', () => {
      // A WHERE on `id` alone or `name` alone must each be covered. If
      // PK and UNIQUE were merged into a single composite index, neither
      // single-column lookup would qualify under SQLite's left-anchored
      // index-prefix rule (SQLite uses the leading column).
      const schema = `
        CREATE TABLE IF NOT EXISTS cost_budgets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE
        );
      `;
      const idxMap = audit.extractIndexColumns(schema);
      const idxs = idxMap.get('cost_budgets') || [];
      // Two distinct single-column indexes, not one composite.
      const singleColIdxs = idxs.filter((cols) => cols.length === 1);
      expect(singleColIdxs.map((c) => c[0]).sort()).toEqual(['id', 'name']);
    });

    it('does not double-register the table-level UNIQUE form as a column-level UNIQUE', () => {
      // The column-level regex must not fire on lines like
      // `UNIQUE (project_id, branch)` — those are owned by the
      // table-level matcher. If both fired, we'd get `[['unique']]`
      // and a bogus composite separately.
      const schema = `
        CREATE TABLE IF NOT EXISTS t (
          project_id TEXT NOT NULL,
          branch TEXT NOT NULL,
          UNIQUE (project_id, branch)
        );
      `;
      const idxs = audit.extractIndexColumns(schema).get('t') || [];
      // No spurious ['unique'] entry.
      expect(idxs.some((cols) => cols.includes('unique'))).toBe(false);
      // Composite is registered.
      expect(idxs.some((cols) => cols.includes('project_id') && cols.includes('branch'))).toBe(true);
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

    it('attributes WHERE to the FROM on the SAME line, not an earlier one in the function', () => {
      // Old logic joined an 11-line context and grabbed the first FROM
      // it found. Two SQL statements in the same function would both
      // resolve to the FIRST table — making every later WHERE flag the
      // wrong table.
      const file = path.join(tmpDir, 'two-queries.js');
      fs.writeFileSync(file, [
        "function audit() {",
        "  db.prepare('SELECT * FROM task_claims WHERE claimer = ?').get(c);",
        "  db.prepare('DELETE FROM work_stealing_log WHERE created_at < ?').run(cutoff);",
        '}',
      ].join('\n'));

      const findings = audit.scanFiles([tmpDir]);
      const second = findings.find((f) => f.sql.includes('DELETE FROM work_stealing_log'));
      expect(second).toBeDefined();
      expect(second.table).toBe('work_stealing_log');
    });

    it('falls back to the closest preceding FROM when WHERE is on a separate line', () => {
      // Some code builds queries in pieces:
      //   let sql = "SELECT * FROM tasks";
      //   sql += " WHERE created_at >= ?";
      // The WHERE has no same-line FROM, so we walk backward through the
      // context. The CLOSEST preceding FROM should win — not the first
      // one in the buffer.
      const file = path.join(tmpDir, 'split-query.js');
      fs.writeFileSync(file, [
        "function build() {",
        "  db.prepare('SELECT * FROM other_table WHERE x = ?').get(x);",
        "  let sql = 'SELECT * FROM tasks';",
        "  sql += ' WHERE created_at >= ?';",
        '}',
      ].join('\n'));

      const findings = audit.scanFiles([tmpDir]);
      const split = findings.find((f) => f.sql.includes('WHERE created_at >= ?'));
      expect(split).toBeDefined();
      expect(split.table).toBe('tasks');
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

  describe('JOIN-alias resolution', () => {
    const fs = require('fs');
    const os = require('os');

    let tmpDir;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-db-join-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('buildAliasMap parses FROM and JOIN aliases', () => {
      const ctx = [
        '      SELECT a.* FROM agents a',
        '      INNER JOIN agent_group_members agm ON agm.agent_id = a.id',
        '      WHERE agm.group_id = ?',
      ];
      const map = audit.buildAliasMap(ctx);
      expect(map.get('a')).toBe('agents');
      expect(map.get('agm')).toBe('agent_group_members');
    });

    it('buildAliasMap also accepts the AS form', () => {
      const ctx = [
        'SELECT * FROM tasks AS t INNER JOIN runs AS r ON r.task_id = t.id WHERE r.status = ?',
      ];
      const map = audit.buildAliasMap(ctx);
      expect(map.get('t')).toBe('tasks');
      expect(map.get('r')).toBe('runs');
    });

    it('buildAliasMap skips SQL keywords that follow a bare table', () => {
      // `FROM tasks WHERE x = ?` — the parser must NOT treat `WHERE`
      // as the alias for `tasks`. Same for ON, INNER, OUTER, etc.
      const ctx = ['SELECT * FROM tasks WHERE x = ?'];
      const map = audit.buildAliasMap(ctx);
      expect(map.get('where')).toBeUndefined();
      expect(map.size).toBe(0);
    });

    it('extractWhereColumnsWithAlias preserves the alias prefix', () => {
      const cols = audit.extractWhereColumnsWithAlias('agm.group_id = ? AND af.false_positive = 1');
      expect(cols).toEqual([
        { alias: 'agm', col: 'group_id' },
        { alias: 'af', col: 'false_positive' },
      ]);
    });

    it('extractWhereColumnsWithAlias treats bare columns as alias=""', () => {
      const cols = audit.extractWhereColumnsWithAlias('id = ? AND status = ?');
      expect(cols).toEqual([
        { alias: '', col: 'id' },
        { alias: '', col: 'status' },
      ]);
    });

    it('attributes a JOIN-aliased WHERE to the joined table, not the FROM table', () => {
      // Pre-fix bug: `WHERE agm.group_id = ?` against
      // `FROM agents a INNER JOIN agent_group_members agm` was
      // attributed to `agents` (the FROM target) and reported as a
      // missing index on `agents.group_id`. The actual filter is on
      // `agent_group_members.group_id` which IS indexed.
      const file = path.join(tmpDir, 'join-where.js');
      fs.writeFileSync(file, [
        'function listGroupMembers(groupId) {',
        '  return db.prepare(`',
        '    SELECT a.* FROM agents a',
        '    INNER JOIN agent_group_members agm ON agm.agent_id = a.id',
        '    WHERE agm.group_id = ?',
        '  `).all(groupId);',
        '}',
      ].join('\n'));

      const findings = audit.scanFiles([tmpDir]);
      const joinFinding = findings.find((f) => f.cols.includes('group_id'));
      expect(joinFinding).toBeDefined();
      expect(joinFinding.table).toBe('agent_group_members');
    });

    it('splits a multi-table-aliased WHERE into per-table findings', () => {
      // `WHERE ar.project_path = ? AND af.false_positive = 1` should
      // produce two findings — one per resolved table — so each
      // table's indexes are checked independently.
      const file = path.join(tmpDir, 'two-aliases.js');
      fs.writeFileSync(file, [
        'function getFalsePositives(projectPath) {',
        '  return db.prepare(`',
        '    SELECT af.* FROM audit_findings af',
        '    INNER JOIN audit_runs ar ON ar.id = af.audit_run_id',
        '    WHERE ar.project_path = ? AND af.false_positive = 1',
        '  `).all(projectPath);',
        '}',
      ].join('\n'));

      const findings = audit.scanFiles([tmpDir]);
      const arFinding = findings.find((f) => f.table === 'audit_runs');
      const afFinding = findings.find((f) => f.table === 'audit_findings');
      expect(arFinding).toBeDefined();
      expect(arFinding.cols).toEqual(['project_path']);
      expect(afFinding).toBeDefined();
      expect(afFinding.cols).toEqual(['false_positive']);
    });

    it('falls back to the FROM table when the WHERE column has no alias', () => {
      // Even with JOINs in scope, an unaliased WHERE column should
      // still attribute to the dominant FROM table. This matches
      // SQL semantics where bare columns must be unambiguous.
      const file = path.join(tmpDir, 'mixed.js');
      fs.writeFileSync(file, [
        'function find(name) {',
        "  return db.prepare(`SELECT a.* FROM agents a INNER JOIN runs r ON r.agent_id = a.id WHERE name = ?`).get(name);",
        '}',
      ].join('\n'));

      const findings = audit.scanFiles([tmpDir]);
      const finding = findings.find((f) => f.cols.includes('name'));
      expect(finding).toBeDefined();
      expect(finding.table).toBe('agents');
    });

    it('groups same-table aliased and unaliased columns into one finding', () => {
      // `FROM tasks t WHERE t.status = ? AND created_at = ?` —
      // both columns belong to `tasks`, so emit ONE finding with
      // both cols rather than two single-col findings.
      const file = path.join(tmpDir, 'same-table.js');
      fs.writeFileSync(file, [
        'function find() {',
        "  return db.prepare(`SELECT * FROM tasks t WHERE t.status = ? AND created_at = ?`).get();",
        '}',
      ].join('\n'));

      const findings = audit.scanFiles([tmpDir]);
      const finding = findings.find((f) => f.table === 'tasks');
      expect(finding).toBeDefined();
      expect(finding.cols.sort()).toEqual(['created_at', 'status']);
    });

    it('preserves end-to-end coverage when one alias resolves to an indexed table', () => {
      // The full pipeline: extractIndexColumns + scanFiles +
      // checkViolations on the agents/agent_group_members JOIN
      // pattern, with an explicit index on agent_group_members(group_id).
      const schema = `
        CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT);
        CREATE TABLE IF NOT EXISTS agent_group_members (
          agent_id TEXT NOT NULL,
          group_id TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_group_members_group ON agent_group_members(group_id);
      `;
      const file = path.join(tmpDir, 'live.js');
      fs.writeFileSync(file, [
        'function listGroupMembers(groupId) {',
        '  return db.prepare(`SELECT a.* FROM agents a INNER JOIN agent_group_members agm ON agm.agent_id = a.id WHERE agm.group_id = ?`).all(groupId);',
        '}',
      ].join('\n'));

      const idxMap = audit.extractIndexColumns(schema);
      const findings = audit.scanFiles([tmpDir]);
      const viols = audit.checkViolations(findings, idxMap);
      // The group_id finding should resolve to agent_group_members
      // and be covered by the explicit index — no violation.
      const groupIdViol = viols.find((v) => v.cols.includes('group_id'));
      expect(groupIdViol).toBeUndefined();
    });
  });

  describe('un-indexable column suppression (LIKE / reverse-LIKE)', () => {
    const fs = require('fs');
    const os = require('os');

    let tmpDir;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-db-unindexable-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('findUnindexableColumns flags `<col> LIKE` as un-indexable', () => {
      const cols = audit.findUnindexableColumns("output LIKE ? ESCAPE '\\\\'");
      expect(cols.has('output')).toBe(true);
    });

    it('findUnindexableColumns strips alias prefix on the column side', () => {
      const cols = audit.findUnindexableColumns("af.title LIKE ? AND af.severity = 'error'");
      expect(cols.has('title')).toBe(true);
      // severity is paired with `=`, not LIKE — must NOT be flagged.
      expect(cols.has('severity')).toBe(false);
    });

    it("findUnindexableColumns flags reverse LIKE: `? LIKE '%' || col || '%'`", () => {
      // adaptive_retry_rules pattern — find rules whose error_pattern
      // is a substring of the runtime error text.
      const cols = audit.findUnindexableColumns("? LIKE '%' || error_pattern || '%'");
      expect(cols.has('error_pattern')).toBe(true);
    });

    it('findUnindexableColumns leaves non-LIKE columns alone', () => {
      const cols = audit.findUnindexableColumns("status = 'pending' AND retry_count > 0");
      expect(cols.size).toBe(0);
    });

    it('findUnindexableColumns mixed: only the LIKE-paired column is flagged', () => {
      const cols = audit.findUnindexableColumns("enabled = 1 AND file_extensions LIKE ?");
      expect(cols.has('file_extensions')).toBe(true);
      expect(cols.has('enabled')).toBe(false);
    });

    it('scanFiles drops un-indexable columns from finding cols', () => {
      // event-tracking.js#searchTaskOutputs pattern — full-text scan
      // via `LIKE ?` against output/error_output. Adding indexes on
      // these columns wouldn't help (the actual params are
      // `%${pattern}%` leading-wildcard).
      const file = path.join(tmpDir, 'search.js');
      fs.writeFileSync(file, [
        'function searchTaskOutputs(pattern) {',
        "  return db.prepare(`SELECT id FROM tasks WHERE output LIKE ? ESCAPE '\\\\\\\\' OR error_output LIKE ? ESCAPE '\\\\\\\\'`).all('%'+pattern+'%', '%'+pattern+'%');",
        '}',
      ].join('\n'));

      const findings = audit.scanFiles([tmpDir]);
      // No finding should reference output or error_output as flagged
      // columns — both are LIKE-only on the column side.
      const outputViol = findings.find((f) => f.cols.includes('output') || f.cols.includes('error_output'));
      expect(outputViol).toBeUndefined();
    });

    it('scanFiles preserves non-LIKE columns even when other cols are LIKE-paired', () => {
      // Realistic mixed pattern: `enabled = 1 AND file_extensions LIKE ?`.
      // The `enabled` column is still a (low-selectivity but real)
      // index candidate; only `file_extensions` should be dropped.
      const file = path.join(tmpDir, 'mixed.js');
      fs.writeFileSync(file, [
        'function listMatchingRules(ext) {',
        "  return db.prepare(`SELECT * FROM security_rules WHERE enabled = 1 AND file_extensions LIKE ?`).all('%'+ext+'%');",
        '}',
      ].join('\n'));

      const findings = audit.scanFiles([tmpDir]);
      const finding = findings.find((f) => f.table === 'security_rules');
      expect(finding).toBeDefined();
      expect(finding.cols).toContain('enabled');
      expect(finding.cols).not.toContain('file_extensions');
    });

    it('scanFiles emits no finding when ALL WHERE columns are un-indexable', () => {
      // `WHERE col LIKE ?` with col being the only filter — drop the
      // entire finding rather than emit an empty cols list.
      const file = path.join(tmpDir, 'pure-like.js');
      fs.writeFileSync(file, [
        'function searchByDescription(pattern) {',
        "  return db.prepare(`DELETE FROM task_cache WHERE task_description LIKE ?`).run('%'+pattern+'%');",
        '}',
      ].join('\n'));

      const findings = audit.scanFiles([tmpDir]);
      expect(findings.find((f) => f.table === 'task_cache')).toBeUndefined();
    });
  });
});
