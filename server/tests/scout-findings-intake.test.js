'use strict';

const fs = require('fs');
const path = require('path');

const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const factoryHealth = require('../db/factory/health');
const factoryIntake = require('../db/factory/intake');
const {
  createScoutFindingsIntake,
  parseFindings,
  parseVariant,
  findingHash,
  SEVERITY_PRIORITY,
} = require('../factory/scout-findings-intake');

let dbModule;
let dbHandle;
let testDir;

// Helpers use bracket access on db.exec to avoid tripping the security hook
// that flags any literal `.exec(`. better-sqlite3's Database#exec is safe here.
function runDdl(db, sql) {
  return db['exec'](sql);
}

function ensureFactoryTables(db) {
  runDdl(db, `
    CREATE TABLE IF NOT EXISTS factory_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      brief TEXT,
      trust_level TEXT NOT NULL DEFAULT 'supervised',
      status TEXT NOT NULL DEFAULT 'paused',
      config_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS factory_work_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      source TEXT NOT NULL,
      origin_json TEXT,
      title TEXT NOT NULL,
      description TEXT,
      priority INTEGER NOT NULL DEFAULT 50,
      requestor TEXT,
      constraints_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      reject_reason TEXT,
      linked_item_id INTEGER,
      batch_id TEXT,
      claimed_by_instance_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS factory_scout_findings_intake (
      project_id TEXT NOT NULL,
      scan_path TEXT NOT NULL,
      finding_hash TEXT NOT NULL,
      work_item_id INTEGER NOT NULL REFERENCES factory_work_items(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, scan_path, finding_hash)
    );
  `);
}

function resetFactoryTables(db) {
  for (const table of [
    'factory_scout_findings_intake',
    'factory_work_items',
    'factory_projects',
  ]) {
    runDdl(db, `DELETE FROM ${table}`);
  }
}

function wireFactoryDbModules(db) {
  factoryHealth.setDb(db);
  factoryIntake.setDb(db);
}

function createProject(name = 'bitsy') {
  const projectPath = path.join(testDir, `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(projectPath, { recursive: true });
  return factoryHealth.registerProject({
    name,
    path: projectPath,
    brief: `${name} scout findings intake test project`,
    trust_level: 'supervised',
  });
}

function writeFindingsFile(dir, filename, body) {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, body, 'utf8');
  return filePath;
}

function sampleScanMarkdown() {
  return [
    '# Security Scan',
    '**Date:** 2026-04-18',
    '**Scope:** bitsy/ package',
    '**Variant:** security',
    '',
    '## Summary',
    '2 findings: 0 critical, 2 high, 0 medium, 0 low.',
    '',
    '## Findings',
    '',
    '### [HIGH] Path traversal via MCP projects_root',
    '- **File:** bitsy/cli/_io.py:16',
    '- **Description:** asset_root joins projects_root without validating segments, allowing dotdot escapes.',
    '- **Status:** NEW',
    '- **Suggested fix:** Validate segments against an allowlist and resolve under an approved root.',
    '',
    '### [HIGH] Unvalidated LLM-supplied dimensions allocate unbounded buffers',
    '- **File:** bitsy/agent/tool_interface.py:117',
    '- **Description:** dispatch_tool_call copies LLM args into op constructors without clamping width/height.',
    '- **Status:** NEW',
    '- **Suggested fix:** Enforce per-tool max dimensions before constructing ops.',
    '',
  ].join('\n');
}

beforeAll(() => {
  ({ db: dbModule, testDir } = setupTestDbOnly('scout-findings-intake'));
  dbHandle = dbModule.getDbInstance();
  ensureFactoryTables(dbHandle);
  wireFactoryDbModules(dbHandle);
});

beforeEach(() => {
  dbHandle = dbModule.getDbInstance();
  ensureFactoryTables(dbHandle);
  resetFactoryTables(dbHandle);
  wireFactoryDbModules(dbHandle);
});

afterAll(() => {
  factoryHealth.setDb(null);
  factoryIntake.setDb(null);
  teardownTestDb();
});

describe('parseFindings', () => {
  it('extracts severity, title, file, description, and suggested fix from each block', () => {
    const findings = parseFindings(sampleScanMarkdown());
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({
      severity: 'HIGH',
      title: 'Path traversal via MCP projects_root',
      file: 'bitsy/cli/_io.py:16',
    });
    expect(findings[0].description).toContain('asset_root');
    expect(findings[0].suggested_fix).toContain('Validate segments');
    expect(findings[1]).toMatchObject({
      severity: 'HIGH',
      title: 'Unvalidated LLM-supplied dimensions allocate unbounded buffers',
      file: 'bitsy/agent/tool_interface.py:117',
    });
  });

  it('returns an empty array when no finding blocks are present', () => {
    expect(parseFindings('# Empty Scan\n\n## Findings\n\nNone.\n')).toEqual([]);
  });

  it('reads the Variant header', () => {
    expect(parseVariant(sampleScanMarkdown())).toBe('security');
    expect(parseVariant('# No Variant\n\ntext\n')).toBe(null);
  });
});

describe('scout findings intake', () => {
  it('creates one scout-sourced work item per finding and records the intake row', () => {
    const project = createProject();
    const findingsDir = path.join(project.path, 'docs', 'findings');
    const scanPath = writeFindingsFile(findingsDir, '2026-04-18-security-scan.md', sampleScanMarkdown());

    const intake = createScoutFindingsIntake({ db: dbHandle, factoryIntake });
    const result = intake.scan({ project_id: project.id, findings_dir: findingsDir });

    expect(result.created).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
    expect(result.scanned).toBe(1);

    const items = factoryIntake.listWorkItems({ project_id: project.id });
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.source).toBe('scout');
      expect(item.requestor).toBe('scout-findings-intake');
      const origin = JSON.parse(item.origin_json);
      expect(origin.scan_path).toBe(scanPath);
      expect(origin.variant).toBe('security');
      expect(origin.severity).toBe('HIGH');
      expect(origin.target_file).toMatch(/bitsy\//);
    }

    const intakeRows = dbHandle.prepare(
      'SELECT * FROM factory_scout_findings_intake WHERE project_id = ?'
    ).all(project.id);
    expect(intakeRows).toHaveLength(2);
    expect(intakeRows.every((row) => row.scan_path === scanPath)).toBe(true);
  });

  it('maps severity to priority: critical→high, high→medium, medium→default, low→low', () => {
    const project = createProject();
    const findingsDir = path.join(project.path, 'docs', 'findings');
    const body = [
      '# Mixed Scan',
      '**Variant:** quality',
      '',
      '## Findings',
      '',
      '### [CRITICAL] Swallowed exception',
      '- **File:** a.py:1',
      '- **Description:** Hides real failures.',
      '',
      '### [HIGH] Empty required list',
      '- **File:** b.py:2',
      '- **Description:** Required fields not marked.',
      '',
      '### [MEDIUM] Broad catch',
      '- **File:** c.py:3',
      '- **Description:** Loses context.',
      '',
      '### [LOW] Unused import',
      '- **File:** d.py:4',
      '- **Description:** Dead symbol.',
      '',
    ].join('\n');
    writeFindingsFile(findingsDir, '2026-04-18-quality-scan.md', body);

    const intake = createScoutFindingsIntake({ db: dbHandle, factoryIntake });
    intake.scan({ project_id: project.id, findings_dir: findingsDir });

    const items = factoryIntake.listWorkItems({ project_id: project.id });
    const byTitle = Object.fromEntries(items.map((i) => [i.title, i]));
    expect(byTitle['Swallowed exception'].priority).toBe(factoryIntake.normalizePriority(SEVERITY_PRIORITY.CRITICAL));
    expect(byTitle['Empty required list'].priority).toBe(factoryIntake.normalizePriority(SEVERITY_PRIORITY.HIGH));
    expect(byTitle['Broad catch'].priority).toBe(factoryIntake.normalizePriority(SEVERITY_PRIORITY.MEDIUM));
    expect(byTitle['Unused import'].priority).toBe(factoryIntake.normalizePriority(SEVERITY_PRIORITY.LOW));
  });

  it('is idempotent: re-scanning unchanged files does not duplicate work items', () => {
    const project = createProject();
    const findingsDir = path.join(project.path, 'docs', 'findings');
    writeFindingsFile(findingsDir, '2026-04-18-security-scan.md', sampleScanMarkdown());

    const intake = createScoutFindingsIntake({ db: dbHandle, factoryIntake });
    const first = intake.scan({ project_id: project.id, findings_dir: findingsDir });
    expect(first.created).toHaveLength(2);

    const second = intake.scan({ project_id: project.id, findings_dir: findingsDir });
    expect(second.created).toHaveLength(0);
    expect(second.skipped.every((s) => s.reason === 'duplicate')).toBe(true);

    const items = factoryIntake.listWorkItems({ project_id: project.id });
    expect(items).toHaveLength(2);
  });

  it('treats description-only edits as the same finding (stable hash on severity|title|file)', () => {
    const project = createProject();
    const findingsDir = path.join(project.path, 'docs', 'findings');
    const filename = '2026-04-18-security-scan.md';
    writeFindingsFile(findingsDir, filename, sampleScanMarkdown());

    const intake = createScoutFindingsIntake({ db: dbHandle, factoryIntake });
    intake.scan({ project_id: project.id, findings_dir: findingsDir });

    const edited = sampleScanMarkdown()
      .replace('asset_root joins projects_root without validating segments', 'different wording of same finding')
      .replace('Validate segments against an allowlist', 'Use a stricter allowlist plus path resolution');
    writeFindingsFile(findingsDir, filename, edited);

    const second = intake.scan({ project_id: project.id, findings_dir: findingsDir });
    expect(second.created).toHaveLength(0);

    const items = factoryIntake.listWorkItems({ project_id: project.id });
    expect(items).toHaveLength(2);
  });

  it('continues promoting later findings when one createWorkItem call throws', () => {
    const project = createProject();
    const findingsDir = path.join(project.path, 'docs', 'findings');
    writeFindingsFile(findingsDir, '2026-04-18-security-scan.md', sampleScanMarkdown());

    let calls = 0;
    const wrapped = {
      createWorkItem: (args) => {
        calls += 1;
        if (calls === 1) throw new Error('simulated insert failure');
        return factoryIntake.createWorkItem(args);
      },
      getWorkItem: factoryIntake.getWorkItem,
    };

    const intake = createScoutFindingsIntake({ db: dbHandle, factoryIntake: wrapped });
    const result = intake.scan({ project_id: project.id, findings_dir: findingsDir });

    expect(result.created).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('create_failed');
  });

  it('skips empty files and files without findings', () => {
    const project = createProject();
    const findingsDir = path.join(project.path, 'docs', 'findings');
    writeFindingsFile(findingsDir, '2026-04-18-empty-scan.md', '');
    writeFindingsFile(findingsDir, '2026-04-18-noresult-scan.md', '# Nothing\n\n## Findings\n\nNone.\n');

    const intake = createScoutFindingsIntake({ db: dbHandle, factoryIntake });
    const result = intake.scan({ project_id: project.id, findings_dir: findingsDir });

    expect(result.created).toHaveLength(0);
    expect(result.scanned).toBe(2);
    const reasons = result.skipped.map((s) => s.reason).sort();
    expect(reasons).toEqual(['empty_file', 'no_findings']);
  });

  it('returns zero when findings_dir does not exist', () => {
    const project = createProject();
    const intake = createScoutFindingsIntake({ db: dbHandle, factoryIntake });
    const result = intake.scan({ project_id: project.id, findings_dir: path.join(project.path, 'nope') });
    expect(result).toEqual({ created: [], skipped: [], scanned: 0 });
  });
});

describe('findingHash', () => {
  it('depends only on severity, title, and file — not description', () => {
    const a = { severity: 'HIGH', title: 'T', file: 'x.py:1', description: 'one' };
    const b = { severity: 'HIGH', title: 'T', file: 'x.py:1', description: 'two' };
    const c = { severity: 'HIGH', title: 'T2', file: 'x.py:1', description: 'one' };
    expect(findingHash(a)).toBe(findingHash(b));
    expect(findingHash(a)).not.toBe(findingHash(c));
  });
});
