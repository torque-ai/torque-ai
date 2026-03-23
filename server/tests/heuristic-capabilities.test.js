'use strict';

/**
 * Unit Tests: heuristic-capabilities — model family → capability flags
 */

const {
  getHeuristicCapabilities,
  applyHeuristicCapabilities,
  FAMILY_CAPABILITIES,
} = require('../discovery/heuristic-capabilities');

// ---------------------------------------------------------------------------
// Helpers — lightweight in-memory SQLite DB for applyHeuristicCapabilities
// ---------------------------------------------------------------------------

function createTestDb() {
  const rows = new Map(); // model_name → row

  const db = {
    prepare(sql) {
      return {
        run(...args) {
          // Parse the INSERT ... ON CONFLICT DO UPDATE SQL
          // We extract the values from the positional args
          const [modelName, capHashline, capAgentic, capFileCreation, capMultiFile] = args;

          const existing = rows.get(modelName);

          if (!existing) {
            // No conflict — insert
            rows.set(modelName, {
              model_name: modelName,
              cap_hashline: capHashline,
              cap_agentic: capAgentic,
              cap_file_creation: capFileCreation,
              cap_multi_file: capMultiFile,
              capability_source: 'heuristic',
            });
          } else {
            // Conflict — only update if source is 'heuristic'
            if (existing.capability_source === 'heuristic') {
              existing.cap_hashline = capHashline;
              existing.cap_agentic = capAgentic;
              existing.cap_file_creation = capFileCreation;
              existing.cap_multi_file = capMultiFile;
              existing.capability_source = 'heuristic';
            }
            // else: probed / user — leave unchanged
          }
        },
      };
    },
    _rows: rows,
  };

  return db;
}

// ---------------------------------------------------------------------------
// getHeuristicCapabilities
// ---------------------------------------------------------------------------

describe('FAMILY_CAPABILITIES', () => {
  it('exports an object with known families', () => {
    expect(typeof FAMILY_CAPABILITIES).toBe('object');
    expect(FAMILY_CAPABILITIES).toHaveProperty('qwen3');
    expect(FAMILY_CAPABILITIES).toHaveProperty('llama');
    expect(FAMILY_CAPABILITIES).toHaveProperty('phi');
  });
});

describe('getHeuristicCapabilities', () => {
  it('returns correct capabilities for qwen3', () => {
    const caps = getHeuristicCapabilities('qwen3');
    expect(caps).toEqual({
      hashline: true,
      agentic: true,
      file_creation: true,
      multi_file: false,
      reasoning: true,
    });
  });

  it('returns correct capabilities for llama', () => {
    const caps = getHeuristicCapabilities('llama');
    expect(caps).toEqual({
      hashline: false,
      agentic: true,
      file_creation: false,
      multi_file: false,
      reasoning: true,
    });
  });

  it('returns all false for phi', () => {
    const caps = getHeuristicCapabilities('phi');
    expect(caps).toEqual({
      hashline: false,
      agentic: false,
      file_creation: false,
      multi_file: false,
      reasoning: false,
    });
  });

  it('returns all false for unknown family', () => {
    const caps = getHeuristicCapabilities('unknown');
    expect(caps).toEqual({
      hashline: false,
      agentic: false,
      file_creation: false,
      multi_file: false,
      reasoning: false,
    });
  });

  it('returns all false for nonexistent_family', () => {
    const caps = getHeuristicCapabilities('nonexistent_family');
    expect(caps).toEqual({
      hashline: false,
      agentic: false,
      file_creation: false,
      multi_file: false,
      reasoning: false,
    });
  });

  it('returns a fresh object (not a reference to the internal map)', () => {
    const caps1 = getHeuristicCapabilities('qwen3');
    const caps2 = getHeuristicCapabilities('qwen3');
    expect(caps1).not.toBe(caps2);
  });
});

// ---------------------------------------------------------------------------
// applyHeuristicCapabilities
// ---------------------------------------------------------------------------

describe('applyHeuristicCapabilities', () => {
  it('inserts a new row with correct flags for qwen3-coder:30b / qwen3', () => {
    const db = createTestDb();
    applyHeuristicCapabilities(db, 'qwen3-coder:30b', 'qwen3');

    const row = db._rows.get('qwen3-coder:30b');
    expect(row).toBeDefined();
    expect(row.cap_hashline).toBe(1);
    expect(row.cap_agentic).toBe(1);
    expect(row.cap_file_creation).toBe(1);
    expect(row.cap_multi_file).toBe(0);
    expect(row.capability_source).toBe('heuristic');
  });

  it('inserts all-zero flags for unknown family', () => {
    const db = createTestDb();
    applyHeuristicCapabilities(db, 'unknown-model:7b', 'unknown');

    const row = db._rows.get('unknown-model:7b');
    expect(row).toBeDefined();
    expect(row.cap_hashline).toBe(0);
    expect(row.cap_agentic).toBe(0);
    expect(row.cap_file_creation).toBe(0);
    expect(row.cap_multi_file).toBe(0);
  });

  it('updates an existing heuristic row', () => {
    const db = createTestDb();

    // First insert with llama flags
    applyHeuristicCapabilities(db, 'some-model:7b', 'llama');
    let row = db._rows.get('some-model:7b');
    expect(row.cap_hashline).toBe(0);

    // Now re-apply with qwen3 (simulates family reclassification)
    // Adjust the test: the SQL is a single upsert, so we simulate a second call
    // by directly manipulating the row back to heuristic source and re-running
    row.capability_source = 'heuristic';
    applyHeuristicCapabilities(db, 'some-model:7b', 'qwen3');
    row = db._rows.get('some-model:7b');
    expect(row.cap_hashline).toBe(1);
  });

  it('does NOT overwrite when capability_source is "probed"', () => {
    const db = createTestDb();

    // Seed a row with probed source
    db._rows.set('probed-model:7b', {
      model_name: 'probed-model:7b',
      cap_hashline: 1,
      cap_agentic: 1,
      cap_file_creation: 1,
      cap_multi_file: 1,
      capability_source: 'probed',
    });

    // Attempt to overwrite with phi (all false)
    applyHeuristicCapabilities(db, 'probed-model:7b', 'phi');

    const row = db._rows.get('probed-model:7b');
    // Should remain unchanged
    expect(row.cap_hashline).toBe(1);
    expect(row.cap_agentic).toBe(1);
    expect(row.cap_file_creation).toBe(1);
    expect(row.cap_multi_file).toBe(1);
    expect(row.capability_source).toBe('probed');
  });

  it('does NOT overwrite when capability_source is "user"', () => {
    const db = createTestDb();

    // Seed a row with user source
    db._rows.set('user-model:7b', {
      model_name: 'user-model:7b',
      cap_hashline: 1,
      cap_agentic: 0,
      cap_file_creation: 1,
      cap_multi_file: 0,
      capability_source: 'user',
    });

    // Attempt to overwrite with phi (all false)
    applyHeuristicCapabilities(db, 'user-model:7b', 'phi');

    const row = db._rows.get('user-model:7b');
    expect(row.cap_hashline).toBe(1);
    expect(row.cap_file_creation).toBe(1);
    expect(row.capability_source).toBe('user');
  });

  it('does overwrite when capability_source is "heuristic"', () => {
    const db = createTestDb();

    // Seed a row with heuristic source (phi = all false)
    db._rows.set('flex-model:7b', {
      model_name: 'flex-model:7b',
      cap_hashline: 0,
      cap_agentic: 0,
      cap_file_creation: 0,
      cap_multi_file: 0,
      capability_source: 'heuristic',
    });

    // Overwrite with qwen3 (all true except multi_file)
    applyHeuristicCapabilities(db, 'flex-model:7b', 'qwen3');

    const row = db._rows.get('flex-model:7b');
    expect(row.cap_hashline).toBe(1);
    expect(row.cap_agentic).toBe(1);
    expect(row.cap_file_creation).toBe(1);
    expect(row.cap_multi_file).toBe(0);
    expect(row.capability_source).toBe('heuristic');
  });
});
