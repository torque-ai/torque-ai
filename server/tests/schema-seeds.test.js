const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const { createTables } = require('../db/schema/tables');
const { seedDefaults } = require('../db/schema/seeds');

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const SEEDED_TABLES = [
  'artifact_config',
  'cache_config',
  'priority_config',
  'safeguard_tool_config',
  'failover_config',
  'config',
  'maintenance_schedule',
  'provider_config',
  'provider_rate_limits',
  'routing_rules',
  // model_capabilities seeds removed (model-agnostic: capabilities discovered at runtime)
  'rate_limits',
  'cost_budgets',
  'approval_rules',
  'failure_patterns',
  'governance_rules',
];

const EXPECTED_CONFIG_DEFAULTS = {
  default_provider: 'ollama',
  strategic_provider: 'ollama',
  smart_routing_enabled: '1',
  smart_routing_default_provider: 'ollama',
  ollama_auto_tuning_enabled: '1',
  codex_enabled: '1',
  max_per_host: '4',
  rate_limiting_enabled: '1',
  file_locking_enabled: '1',
  quota_auto_scale_enabled: 'false',
  reject_recovery_enabled: '1',
  reject_recovery_sweep_interval_ms: String(15 * 60 * 1000),
  reject_recovery_age_threshold_ms: String(60 * 60 * 1000),
  reject_recovery_max_reopens: '1',
  scheduling_mode: 'legacy',
};

const VALID_PROVIDER_NAMES = new Set([
  'codex',
  'codex-spark',
  'claude-cli',
  'claude-code-sdk',
  'claude-ollama',
  'ollama',
  'anthropic',
  'groq',
  'ollama-cloud',
  'cerebras',
  'google-ai',
  'openrouter',
  'hyperbolic',
  'deepinfra',
]);

const SCORE_COLUMNS = [
  'score_code_gen',
  'score_refactoring',
  'score_testing',
  'score_reasoning',
  'score_docs',
  'lang_typescript',
  'lang_javascript',
  'lang_python',
  'lang_csharp',
  'lang_go',
  'lang_rust',
  'lang_general',
];

function createSeededDb() {
  const db = new Database(':memory:');
  createTables(db, logger);

  const safeAddColumn = (table, colDef) => {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef}`);
    } catch {}
  };

  const setConfigDefault = (key, value) => {
    db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)').run(key, String(value));
  };

  const dataDir = path.join('/tmp', `schema-seeds-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  seedDefaults(db, logger, safeAddColumn, { DATA_DIR: dataDir, setConfigDefault });

  return { db, dataDir, safeAddColumn, setConfigDefault };
}

function getCount(db, tableName) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count;
}

function getConfigValue(db, key) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : null;
}

describe('db/schema/seeds', () => {
  let db;
  let safeAddColumn;
  let setConfigDefault;

  beforeEach(() => {
    ({ db, safeAddColumn, setConfigDefault } = createSeededDb());
  });

  afterEach(() => {
    if (db) {
      db.close();
      db = null;
    }
  });

  it.each(SEEDED_TABLES)('seeds rows into %s', (tableName) => {
    expect(getCount(db, tableName)).toBeGreaterThan(0);
  });

  it('is idempotent across all requested seed tables', () => {
    const countsBefore = Object.fromEntries(
      SEEDED_TABLES.map((tableName) => [tableName, getCount(db, tableName)]),
    );

    expect(() => {
      seedDefaults(db, logger, safeAddColumn, {
        DATA_DIR: '/tmp/test',
        setConfigDefault,
      });
    }).not.toThrow();

    const countsAfter = Object.fromEntries(
      SEEDED_TABLES.map((tableName) => [tableName, getCount(db, tableName)]),
    );

    expect(countsAfter).toEqual(countsBefore);
  });

  it('seeds the expected config defaults', () => {
    for (const [key, expectedValue] of Object.entries(EXPECTED_CONFIG_DEFAULTS)) {
      expect(getConfigValue(db, key)).toBe(expectedValue);
    }
  });

  it('seeds only valid provider names into provider_config', () => {
    const providers = db.prepare('SELECT provider FROM provider_config ORDER BY priority, provider').all();

    expect(providers.length).toBeGreaterThan(0);
    expect(new Set(providers.map((row) => row.provider)).size).toBe(providers.length);

    for (const { provider } of providers) {
      expect(VALID_PROVIDER_NAMES.has(provider)).toBe(true);
    }

    expect(providers.some((row) => row.provider === 'codex')).toBe(true);
    expect(providers.some((row) => row.provider === 'claude-cli')).toBe(true);
    expect(providers.some((row) => row.provider === 'claude-code-sdk')).toBe(true);
    expect(providers.some((row) => row.provider === 'ollama')).toBe(true);
  });

  it('seeds provider capability tags and quality bands', () => {
    const rows = db.prepare(`
      SELECT provider, capability_tags, quality_band
      FROM provider_config
      WHERE provider IN ('codex', 'claude-cli', 'claude-code-sdk', 'ollama', 'ollama-cloud', 'groq')
      ORDER BY provider
    `).all();
    const byProvider = Object.fromEntries(rows.map((row) => [row.provider, row]));

    expect(JSON.parse(byProvider.codex.capability_tags)).toEqual([
      'file_creation',
      'file_edit',
      'multi_file',
      'reasoning',
    ]);
    expect(byProvider.codex.quality_band).toBe('A');
    expect(JSON.parse(byProvider['claude-cli'].capability_tags)).toEqual([
      'file_creation',
      'file_edit',
      'multi_file',
      'reasoning',
    ]);
    expect(byProvider['claude-cli'].quality_band).toBe('A');
    expect(JSON.parse(byProvider['claude-code-sdk'].capability_tags)).toEqual([
      'file_creation',
      'file_edit',
      'multi_file',
      'reasoning',
    ]);
    expect(byProvider['claude-code-sdk'].quality_band).toBe('A');
    expect(JSON.parse(byProvider['ollama'].capability_tags)).toEqual([
      'file_edit',
      'reasoning',
      'code_review',
    ]);
    expect(byProvider['ollama'].quality_band).toBe('C');
    expect(JSON.parse(byProvider['ollama-cloud'].capability_tags)).toEqual([
      'file_creation',
      'file_edit',
      'multi_file',
      'reasoning',
      'large_context',
      'code_review',
    ]);
    expect(byProvider['ollama-cloud'].quality_band).toBe('B');
    expect(JSON.parse(byProvider.groq.capability_tags)).toEqual([]);
    expect(byProvider.groq.quality_band).toBe('D');
  });

  it('model_capabilities table exists but has no hardcoded seeds (model-agnostic)', () => {
    const rows = db.prepare(`
      SELECT model_name, ${SCORE_COLUMNS.join(', ')}
      FROM model_capabilities
    `).all();

    // Model-agnostic: no benchmark seeds — capabilities are discovered at runtime
    expect(rows.length).toBe(0);
  });

  it('seeds routing rules that target known providers', () => {
    const knownProviders = new Set(
      db.prepare('SELECT provider FROM provider_config').all().map((row) => row.provider),
    );
    const rules = db.prepare('SELECT name, target_provider FROM routing_rules').all();

    expect(rules.length).toBeGreaterThan(0);

    for (const rule of rules) {
      expect(knownProviders.has(rule.target_provider)).toBe(true);
    }
  });

  it('seeds builtin governance rules including batch-test-fixes', () => {
    const rule = db.prepare(`
      SELECT id, stage, mode, default_mode, checker_id
      FROM governance_rules
      WHERE id = ?
    `).get('batch-test-fixes');

    expect(rule).toMatchObject({
      id: 'batch-test-fixes',
      stage: 'pre-verify',
      mode: 'warn',
      default_mode: 'warn',
      checker_id: 'checkBatchTestFixes',
    });
  });

  it('seeds every task_type handled by runMaintenanceTask', () => {
    // Enumerate every non-aggregate `case '<name>':` in the scheduler switch and
    // require a matching maintenance_schedule row. Without this, a handler can
    // exist in code but never fire because no schedule row drives it (the cause
    // of 1.4 GB stream_chunks accumulation observed in production).
    const schedulerSrc = fs.readFileSync(
      path.resolve(__dirname, '..', 'maintenance', 'scheduler.js'),
      'utf8',
    );
    const runFnStart = schedulerSrc.indexOf('function runMaintenanceTask');
    expect(runFnStart).toBeGreaterThan(-1);
    // Scan only within runMaintenanceTask to avoid picking up unrelated switch statements.
    const runFnBody = schedulerSrc.slice(runFnStart, runFnStart + 5000);

    const handledTypes = new Set();
    for (const m of runFnBody.matchAll(/case\s+'([a-z_]+)'\s*:/g)) {
      if (m[1] !== 'all') handledTypes.add(m[1]);
    }
    expect(handledTypes.size).toBeGreaterThan(0);

    const scheduled = new Set(
      db.prepare('SELECT task_type FROM maintenance_schedule').all().map((r) => r.task_type),
    );

    const missing = [...handledTypes].filter((t) => !scheduled.has(t));
    expect(missing).toEqual([]);
  });
});
