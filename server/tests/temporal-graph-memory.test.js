'use strict';

const Database = require('better-sqlite3');
const { createTemporalGraphMemoryStore } = require('../db/temporal-graph-memory');

describe('temporal-graph-memory', () => {
  let db;
  let store;

  beforeEach(() => {
    db = new Database(':memory:');
    store = createTemporalGraphMemoryStore({
      db,
      now: () => Date.parse('2026-01-01T00:00:00.000Z'),
    });
  });

  afterEach(() => {
    db.close();
  });

  it('creates the temporal graph schema on a minimal database', () => {
    const localDb = new Database(':memory:');
    try {
      const localStore = createTemporalGraphMemoryStore({
        db: localDb,
        now: () => Date.parse('2026-01-01T00:00:00.000Z'),
      });
      localStore.upsertEntity({ entity_type: 'person', entity_id: 'u1' });
      expect(localStore.getEntity({ entity_type: 'person', entity_id: 'u1' })).toMatchObject({
        entity_type: 'person',
        entity_id: 'u1',
      });

      const tables = localDb.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('temporal_graph_entities', 'temporal_graph_fact_edges')",
      ).all().map((row) => row.name);
      expect(tables).toEqual(expect.arrayContaining([
        'temporal_graph_entities',
        'temporal_graph_fact_edges',
      ]));
    } finally {
      localDb.close();
    }
  });

  it('inserts entities and a fact edge', () => {
    const city = store.upsertEntity({
      entity_type: 'location',
      entity_id: 'l-seattle',
    });
    const alice = store.upsertEntity({
      entity_type: 'person',
      entity_id: 'p-alice',
    });

    const edge = store.insertFactEdge({
      subject_entity_type: 'person',
      subject_entity_id: 'p-alice',
      edge_type: 'lives_in',
      object_entity_type: 'location',
      object_entity_id: 'l-seattle',
      value: 'primary_home',
      valid_from: Date.parse('2026-05-01T12:00:00.000Z'),
      payload: { confidence: 0.9 },
    });

    expect(city).toMatchObject({ entity_type: 'location', entity_id: 'l-seattle' });
    expect(alice).toMatchObject({ entity_type: 'person', entity_id: 'p-alice' });
    expect(edge.edge_type).toBe('lives_in');
    expect(edge.value).toBe('primary_home');
    expect(edge.payload).toMatchObject({ confidence: 0.9 });

    const rows = store.readFactEdgesAt({
      timestamp: Date.parse('2026-05-01T12:00:00.000Z'),
      subject_entity_type: 'person',
      subject_entity_id: 'p-alice',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].object_entity_id).toBe('l-seattle');
  });

  it('preserves old contradictory facts with invalidation metadata', () => {
    store.upsertEntity({
      entity_type: 'person',
      entity_id: 'p-alice',
    });
    store.upsertEntity({
      entity_type: 'location',
      entity_id: 'l-london',
    });
    store.upsertEntity({
      entity_type: 'location',
      entity_id: 'l-paris',
    });

    const first = store.insertFactEdge({
      subject_entity_type: 'person',
      subject_entity_id: 'p-alice',
      edge_type: 'lives_in',
      object_entity_type: 'location',
      object_entity_id: 'l-london',
      valid_from: 1000,
    });
    const second = store.insertFactEdge({
      subject_entity_type: 'person',
      subject_entity_id: 'p-alice',
      edge_type: 'lives_in',
      object_entity_type: 'location',
      object_entity_id: 'l-paris',
      valid_from: 2000,
    });

    const rows = db
      .prepare('SELECT * FROM temporal_graph_fact_edges ORDER BY id ASC')
      .all()
      .map((row) => ({
        ...row,
        value: row.value_json ? JSON.parse(row.value_json) : null,
        payload: row.payload_json ? JSON.parse(row.payload_json) : null,
      }));

    expect(rows).toHaveLength(2);
    expect(rows[0].valid_to).toBe(2000);
    expect(rows[0].invalidated_by_edge_id).toBe(second.id);
    expect(rows[0].object_entity_id).toBe('l-london');
    expect(rows[1].valid_to).toBeNull();
    expect(rows[1].invalidated_by_edge_id).toBeNull();
    expect(rows[1].object_entity_id).toBe('l-paris');
    expect(first.id).not.toBe(second.id);
  });

  it('reads point-in-time facts before and after contradiction replacement', () => {
    store.upsertEntity({
      entity_type: 'person',
      entity_id: 'p-bob',
    });
    store.upsertEntity({
      entity_type: 'team',
      entity_id: 't-alpha',
    });
    store.upsertEntity({
      entity_type: 'team',
      entity_id: 't-beta',
    });

    store.insertFactEdge({
      subject_entity_type: 'person',
      subject_entity_id: 'p-bob',
      edge_type: 'belongs_to',
      object_entity_type: 'team',
      object_entity_id: 't-alpha',
      valid_from: Date.parse('2026-05-01T00:00:00.000Z'),
    });
    store.insertFactEdge({
      subject_entity_type: 'person',
      subject_entity_id: 'p-bob',
      edge_type: 'belongs_to',
      object_entity_type: 'team',
      object_entity_id: 't-beta',
      valid_from: Date.parse('2026-06-01T00:00:00.000Z'),
    });

    const before = store.readFactEdgesAt({
      timestamp: Date.parse('2026-05-15T00:00:00.000Z'),
      subject_entity_type: 'person',
      subject_entity_id: 'p-bob',
      edge_type: 'belongs_to',
    });
    const after = store.readFactEdgesAt({
      timestamp: Date.parse('2026-07-01T00:00:00.000Z'),
      subject_entity_type: 'person',
      subject_entity_id: 'p-bob',
      edge_type: 'belongs_to',
    });

    expect(before).toHaveLength(1);
    expect(before[0].object_entity_id).toBe('t-alpha');
    expect(after).toHaveLength(1);
    expect(after[0].object_entity_id).toBe('t-beta');
  });

  it('stores multiple entity and edge types', () => {
    store.upsertEntity({ entity_type: 'person', entity_id: 'p-charlie', payload: { name: 'charlie' } });
    store.upsertEntity({ entity_type: 'person', entity_id: 'p-dana', payload: { name: 'dana' } });
    store.upsertEntity({ entity_type: 'org', entity_id: 'org-omega', payload: { public: true } });

    store.insertFactEdge({
      subject_entity_type: 'person',
      subject_entity_id: 'p-charlie',
      edge_type: 'works_for',
      object_entity_type: 'org',
      object_entity_id: 'org-omega',
      valid_from: 1100,
    });
    store.insertFactEdge({
      subject_entity_type: 'person',
      subject_entity_id: 'p-dana',
      edge_type: 'works_for',
      object_entity_type: 'org',
      object_entity_id: 'org-omega',
      valid_from: 1200,
    });
    store.insertFactEdge({
      subject_entity_type: 'person',
      subject_entity_id: 'p-charlie',
      edge_type: 'alias',
      value: 'char',
      valid_from: 1300,
    });

    const allPersonFacts = store.readFactEdgesAt({
      timestamp: 2000,
      subject_entity_type: 'person',
      subject_entity_id: 'p-charlie',
    });
    const orgFacts = store.readFactEdgesAt({
      timestamp: 2000,
      subject_entity_type: 'person',
      subject_entity_id: 'p-charlie',
      edge_type: 'works_for',
    });
    const aliasFacts = store.readFactEdgesAt({
      timestamp: 2000,
      subject_entity_type: 'person',
      subject_entity_id: 'p-charlie',
      edge_type: 'alias',
    });

    expect(allPersonFacts).toHaveLength(2);
    expect(allPersonFacts.map((row) => row.edge_type).sort()).toEqual(['alias', 'works_for']);
    expect(orgFacts).toHaveLength(1);
    expect(orgFacts[0].object_entity_type).toBe('org');
    expect(aliasFacts).toHaveLength(1);
    expect(aliasFacts[0].value).toBe('char');
    expect(aliasFacts[0].edge_type).toBe('alias');
  });

  it('rejects malformed timestamps and missing entity references', () => {
    store.upsertEntity({ entity_type: 'person', entity_id: 'p-orphan' });

    expect(() => store.insertFactEdge({
      subject_entity_type: 'person',
      subject_entity_id: 'p-orphan',
      edge_type: 'knows',
      object_entity_type: 'person',
      object_entity_id: 'p-missing',
      valid_from: Date.parse('2026-05-01T00:00:00.000Z'),
    })).toThrow('missing entity');

    expect(() => store.insertFactEdge({
      subject_entity_type: 'person',
      subject_entity_id: 'p-orphan',
      edge_type: 'knows',
      valid_from: 'not-a-timestamp',
    })).toThrow('valid_from is not a valid timestamp');
  });
});
