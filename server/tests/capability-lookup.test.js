'use strict';

/**
 * Unit Tests: capability-lookup — centralized model_capabilities table queries
 */

const { isHashlineCapable, isAgenticCapable, getModelCapabilities, hasCapability } =
  require('../discovery/capability-lookup');

// ---------------------------------------------------------------------------
// Helpers — lightweight in-memory SQLite DB
// ---------------------------------------------------------------------------

function createTestDb() {
  const rows = new Map(); // model_name → row

  return {
    prepare(sql) {
      return {
        get(...args) {
          const modelName = args[0];

          // LIKE query for base-name fallback — second arg is the LIKE pattern
          if (sql.includes('LIKE')) {
            const pattern = modelName; // already the LIKE pattern (e.g. 'qwen3-coder%')
            const basePrefix = pattern.replace('%', '');
            // Extract the column being checked for = 1
            const colMatch = sql.match(/AND (\w+) = 1/);
            const col = colMatch ? colMatch[1] : null;
            for (const row of rows.values()) {
              if (row.model_name.startsWith(basePrefix)) {
                if (!col || row[col] === 1) {
                  return row;
                }
              }
            }
            return undefined;
          }

          // Exact lookup
          return rows.get(modelName);
        },
      };
    },
    _rows: rows,
    _insert(row) {
      rows.set(row.model_name, row);
    },
  };
}

function buildDb() {
  const db = createTestDb();
  db._insert({
    model_name: 'qwen3-coder:30b',
    cap_hashline: 1,
    cap_agentic: 1,
    cap_file_creation: 1,
    cap_multi_file: 1,
    capability_source: 'heuristic',
  });
  db._insert({
    model_name: 'llama3:8b',
    cap_hashline: 0,
    cap_agentic: 1,
    cap_file_creation: 0,
    cap_multi_file: 0,
    capability_source: 'heuristic',
  });
  return db;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('isHashlineCapable', () => {
  let db;
  beforeEach(() => { db = buildDb(); });

  test('returns true for model with cap_hashline=1', () => {
    expect(isHashlineCapable(db, 'qwen3-coder:30b')).toBe(true);
  });

  test('returns false for model with cap_hashline=0', () => {
    expect(isHashlineCapable(db, 'llama3:8b')).toBe(false);
  });

  test('returns false for model not in DB', () => {
    expect(isHashlineCapable(db, 'unknown-model')).toBe(false);
  });

  test('returns false when db is null', () => {
    expect(isHashlineCapable(null, 'qwen3-coder:30b')).toBe(false);
  });

  test('returns false when modelName is null', () => {
    expect(isHashlineCapable(db, null)).toBe(false);
  });

  test('matches base name — qwen3-coder:7b resolves to qwen3-coder:30b entry', () => {
    // qwen3-coder:7b is not in DB, but base name qwen3-coder matches qwen3-coder:30b (cap_hashline=1)
    expect(isHashlineCapable(db, 'qwen3-coder:7b')).toBe(true);
  });
});

describe('isAgenticCapable', () => {
  let db;
  beforeEach(() => { db = buildDb(); });

  test('returns true for llama3:8b with cap_agentic=1', () => {
    expect(isAgenticCapable(db, 'llama3:8b')).toBe(true);
  });

  test('returns true for qwen3-coder:30b with cap_agentic=1', () => {
    expect(isAgenticCapable(db, 'qwen3-coder:30b')).toBe(true);
  });

  test('returns false for unknown model', () => {
    expect(isAgenticCapable(db, 'unknown-model')).toBe(false);
  });

  test('returns false when db is null', () => {
    expect(isAgenticCapable(null, 'llama3:8b')).toBe(false);
  });
});

describe('getModelCapabilities', () => {
  let db;
  beforeEach(() => { db = buildDb(); });

  test('returns full capability row for known model', () => {
    const caps = getModelCapabilities(db, 'qwen3-coder:30b');
    expect(caps).not.toBeNull();
    expect(caps.cap_hashline).toBe(1);
    expect(caps.cap_agentic).toBe(1);
    expect(caps.cap_file_creation).toBe(1);
    expect(caps.cap_multi_file).toBe(1);
    expect(caps.capability_source).toBe('heuristic');
  });

  test('returns null for nonexistent model', () => {
    expect(getModelCapabilities(db, 'nonexistent')).toBeNull();
  });

  test('returns null when db is null', () => {
    expect(getModelCapabilities(null, 'qwen3-coder:30b')).toBeNull();
  });

  test('returns null when modelName is null', () => {
    expect(getModelCapabilities(db, null)).toBeNull();
  });
});

describe('hasCapability (generic)', () => {
  let db;
  beforeEach(() => { db = buildDb(); });

  test('cap_hashline on qwen3-coder:30b → true', () => {
    expect(hasCapability(db, 'qwen3-coder:30b', 'cap_hashline')).toBe(true);
  });

  test('cap_hashline on llama3:8b → false', () => {
    expect(hasCapability(db, 'llama3:8b', 'cap_hashline')).toBe(false);
  });

  test('returns false when db is null', () => {
    expect(hasCapability(null, 'qwen3-coder:30b', 'cap_hashline')).toBe(false);
  });

  test('returns false when modelName is null', () => {
    expect(hasCapability(db, null, 'cap_hashline')).toBe(false);
  });
});
