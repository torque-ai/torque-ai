'use strict';

const Database = require('better-sqlite3');
const {
  assignOpenRouterRoles,
  runOpenRouterScout,
  scoreOpenRouterModel,
  scoreOpenRouterModels,
} = require('../discovery/openrouter-scout');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE model_registry (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      host_id TEXT,
      model_name TEXT NOT NULL,
      status TEXT DEFAULT 'pending'
    );
    CREATE TABLE model_roles (
      provider TEXT NOT NULL,
      role TEXT NOT NULL,
      model_name TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (provider, role)
    );
  `);
  return db;
}

function insertApproved(db, modelName) {
  db.prepare(`
    INSERT INTO model_registry (id, provider, model_name, status)
    VALUES (?, 'openrouter', ?, 'approved')
  `).run(`id-${modelName}`, modelName);
}

describe('openrouter-scout', () => {
  let db;

  afterEach(() => {
    if (db) {
      db.close();
      db = null;
    }
  });

  it('scores free tool-capable chat models above paid or media-only models', () => {
    const scores = scoreOpenRouterModels([
      {
        id: 'minimax/minimax-m2.5:free',
        pricing: { prompt: '0', completion: '0' },
        supported_parameters: ['tools'],
        context_length: 65536,
      },
      {
        id: 'google/lyria-3-pro-preview',
        pricing: { prompt: '0', completion: '0' },
        supported_parameters: [],
      },
      {
        id: 'paid/model',
        pricing: { prompt: '0.01', completion: '0.02' },
        supported_parameters: ['tools'],
      },
    ]);

    expect(scores[0]).toMatchObject({
      model_name: 'minimax/minimax-m2.5:free',
      smoke_status: 'metadata_pass',
      tool_call_ok: 1,
      read_only_ok: 1,
    });
    expect(scores.find((row) => row.model_name === 'google/lyria-3-pro-preview').smoke_status).toBe('metadata_skip');
    expect(scores[0].score).toBeGreaterThan(scoreOpenRouterModel({ id: 'paid/model' }).score);
  });

  it('upserts scores and assigns OpenRouter roles from approved scored models', async () => {
    db = makeDb();
    insertApproved(db, 'minimax/minimax-m2.5:free');
    insertApproved(db, 'google/gemma-4-26b-a4b-it:free');
    insertApproved(db, 'liquid/lfm-2.5-1.2b-thinking:free');

    const result = await runOpenRouterScout({
      db,
      smokeLimit: 0,
      models: [
        {
          id: 'minimax/minimax-m2.5:free',
          pricing: { prompt: '0', completion: '0' },
          supported_parameters: ['tools'],
          context_length: 65536,
        },
        {
          id: 'google/gemma-4-26b-a4b-it:free',
          pricing: { prompt: '0', completion: '0' },
          supported_parameters: ['tools'],
          context_length: 32768,
        },
        {
          id: 'liquid/lfm-2.5-1.2b-thinking:free',
          pricing: { prompt: '0', completion: '0' },
          supported_parameters: [],
          context_length: 32768,
        },
      ],
    });

    const rows = db.prepare('SELECT model_name, score FROM provider_model_scores ORDER BY score DESC').all();
    const roles = db.prepare('SELECT role, model_name FROM model_roles WHERE provider = ? ORDER BY role').all('openrouter');

    expect(result.scored).toBe(3);
    expect(rows).toHaveLength(3);
    expect(roles.map((row) => row.role)).toEqual(expect.arrayContaining(['default', 'fallback', 'fast', 'quality', 'balanced']));
    expect(roles.find((row) => row.role === 'default').model_name).toBe('minimax/minimax-m2.5:free');
  });

  it('uses live smoke results when requested', async () => {
    db = makeDb();
    insertApproved(db, 'minimax/minimax-m2.5:free');
    const chatCompletion = vi.fn(async () => ({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{
          type: 'function',
          function: { name: 'list_directory', arguments: { path: '.' } },
        }],
      },
      usage: {},
    }));

    await runOpenRouterScout({
      db,
      apiKey: 'openrouter-key',
      chatCompletion,
      smokeLimit: 1,
      models: [{
        id: 'minimax/minimax-m2.5:free',
        pricing: { prompt: '0', completion: '0' },
        supported_parameters: ['tools'],
      }],
    });

    const row = db.prepare('SELECT smoke_status, tool_call_ok FROM provider_model_scores WHERE model_name = ?')
      .get('minimax/minimax-m2.5:free');
    expect(chatCompletion).toHaveBeenCalledOnce();
    expect(row).toMatchObject({ smoke_status: 'pass', tool_call_ok: 1 });
  });

  it('does not assign roles to unapproved scored models', () => {
    db = makeDb();
    db.prepare(`
      INSERT INTO model_registry (id, provider, model_name, status)
      VALUES ('pending-1', 'openrouter', 'pending/model:free', 'pending')
    `).run();

    const assignments = assignOpenRouterRoles(db, [{
      provider: 'openrouter',
      model_name: 'pending/model:free',
      score: 90,
      smoke_status: 'metadata_pass',
      rate_limited: 0,
      tool_call_ok: 1,
    }]);

    expect(assignments).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM model_roles').get().count).toBe(0);
  });
});
