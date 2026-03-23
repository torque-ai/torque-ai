'use strict';

const { setupTestDbModule, teardownTestDb, rawDb, resetTables } = require('./vitest-setup');
const { createFamilyTemplates } = require('../db/family-templates');

let mod;

beforeAll(() => {
  setupTestDbModule('../db/family-templates', 'family-templates');
  mod = createFamilyTemplates({ db: rawDb() });
});

afterAll(() => { teardownTestDb(); });

beforeEach(() => {
  resetTables('model_family_templates');
});

// ── CRUD ─────────────────────────────────────────────────────────────────────

describe('upsert + get', () => {
  it('upsert then get returns correct stored data', () => {
    mod.upsert('qwen3', {
      systemPrompt: 'You are Qwen3, a code-focused model.',
      tuning: { temperature: 0.2, num_ctx: 8192, top_k: 30, repeat_penalty: 1.15 },
      sizeOverrides: { small: { num_ctx: 4096 }, large: { num_ctx: 16384 } }
    });

    const result = mod.get('qwen3');
    expect(result).not.toBeNull();
    expect(result.family).toBe('qwen3');
    expect(result.system_prompt).toBe('You are Qwen3, a code-focused model.');
    expect(result.tuning).toEqual({ temperature: 0.2, num_ctx: 8192, top_k: 30, repeat_penalty: 1.15 });
    expect(result.size_overrides).toEqual({ small: { num_ctx: 4096 }, large: { num_ctx: 16384 } });
  });

  it('upsert replaces existing record for same family', () => {
    mod.upsert('qwen3', { systemPrompt: 'first', tuning: { temperature: 0.1 } });
    mod.upsert('qwen3', { systemPrompt: 'second', tuning: { temperature: 0.3 } });

    const result = mod.get('qwen3');
    expect(result.system_prompt).toBe('second');
    expect(result.tuning.temperature).toBe(0.3);
  });

  it('get returns null for nonexistent family', () => {
    const result = mod.get('nonexistent');
    expect(result).toBeNull();
  });

  it('upsert without sizeOverrides stores null', () => {
    mod.upsert('llama', { systemPrompt: 'Llama code model.', tuning: { temperature: 0.2 } });
    const result = mod.get('llama');
    expect(result.size_overrides).toBeNull();
  });
});

describe('list', () => {
  it('list returns all inserted templates', () => {
    mod.upsert('qwen3', { systemPrompt: 'qwen3 prompt', tuning: { temperature: 0.2 } });
    mod.upsert('llama', { systemPrompt: 'llama prompt', tuning: { temperature: 0.3 } });
    mod.upsert('gemma', { systemPrompt: 'gemma prompt', tuning: { temperature: 0.35 } });

    const results = mod.list();
    expect(results).toHaveLength(3);
    const families = results.map(r => r.family).sort();
    expect(families).toEqual(['gemma', 'llama', 'qwen3']);
  });

  it('list returns empty array when no templates exist', () => {
    expect(mod.list()).toEqual([]);
  });

  it('list parses tuning and size_overrides as objects', () => {
    mod.upsert('deepseek', {
      systemPrompt: 'DeepSeek code model.',
      tuning: { temperature: 0.2, num_ctx: 8192 },
      sizeOverrides: { large: { num_ctx: 16384 } }
    });
    const [row] = mod.list();
    expect(typeof row.tuning).toBe('object');
    expect(typeof row.size_overrides).toBe('object');
  });
});

// ── resolvePrompt ─────────────────────────────────────────────────────────────

describe('resolvePrompt', () => {
  beforeEach(() => {
    mod.upsert('qwen3', {
      systemPrompt: 'You are Qwen3, a specialized code model.',
      tuning: { temperature: 0.2 }
    });
  });

  it('returns model override when provided', () => {
    const result = mod.resolvePrompt('qwen3', 'Override system prompt for this model.');
    expect(result).toBe('Override system prompt for this model.');
  });

  it('returns family template prompt when no model override', () => {
    const result = mod.resolvePrompt('qwen3', null);
    expect(result).toBe('You are Qwen3, a specialized code model.');
  });

  it('returns family template prompt when model override is empty string', () => {
    const result = mod.resolvePrompt('qwen3', '');
    expect(result).toBe('You are Qwen3, a specialized code model.');
  });

  it('falls back to universal fallback for unknown family', () => {
    const result = mod.resolvePrompt('nonexistent', null);
    expect(result).toContain('code-focused');
  });

  it('model override wins over family template', () => {
    const result = mod.resolvePrompt('qwen3', 'Custom override takes priority.');
    expect(result).toBe('Custom override takes priority.');
    expect(result).not.toContain('Qwen3');
  });
});

// ── resolveTuning ─────────────────────────────────────────────────────────────

describe('resolveTuning', () => {
  beforeEach(() => {
    mod.upsert('qwen3', {
      systemPrompt: 'Qwen3.',
      tuning: { temperature: 0.2, num_ctx: 8192, top_k: 30, repeat_penalty: 1.15 },
      sizeOverrides: {
        small: { num_ctx: 4096, top_k: 40 },
        large: { num_ctx: 16384, top_k: 25 }
      }
    });
  });

  it('role defaults are the base layer', () => {
    const result = mod.resolveTuning({ family: 'nonexistent', role: 'fast' });
    expect(result.temperature).toBe(0.3);
    expect(result.num_ctx).toBe(4096);
    expect(result.top_k).toBe(40);
    expect(result.repeat_penalty).toBe(1.1);
  });

  it('family template overrides role defaults', () => {
    const result = mod.resolveTuning({ family: 'qwen3', role: 'fast' });
    // family template temperature (0.2) overrides fast role default (0.3)
    expect(result.temperature).toBe(0.2);
    // family template num_ctx (8192) overrides fast role default (4096)
    expect(result.num_ctx).toBe(8192);
  });

  it('size overrides applied on top of family template when sizeBucket matches', () => {
    const result = mod.resolveTuning({ family: 'qwen3', sizeBucket: 'large', role: 'balanced' });
    expect(result.num_ctx).toBe(16384);
    expect(result.top_k).toBe(25);
  });

  it('small size overrides narrow context', () => {
    const result = mod.resolveTuning({ family: 'qwen3', sizeBucket: 'small', role: 'quality' });
    expect(result.num_ctx).toBe(4096);
    expect(result.top_k).toBe(40);
  });

  it('modelTuning overrides family+size', () => {
    const result = mod.resolveTuning({
      family: 'qwen3',
      sizeBucket: 'large',
      role: 'balanced',
      modelTuning: { temperature: 0.1, num_ctx: 12288 }
    });
    expect(result.temperature).toBe(0.1);
    expect(result.num_ctx).toBe(12288);
  });

  it('taskTuning is the highest priority override', () => {
    const result = mod.resolveTuning({
      family: 'qwen3',
      sizeBucket: 'large',
      role: 'quality',
      modelTuning: { temperature: 0.1 },
      taskTuning: { temperature: 0.05, num_ctx: 32768 }
    });
    expect(result.temperature).toBe(0.05);
    expect(result.num_ctx).toBe(32768);
  });

  it('merge order: task > model > family+size > role defaults', () => {
    // role default: temperature=0.15 (quality)
    // family: temperature=0.2 → overrides role
    // size large: top_k=25
    // modelTuning: top_k=28 → overrides size
    // taskTuning: repeat_penalty=1.2 → highest priority
    const result = mod.resolveTuning({
      family: 'qwen3',
      sizeBucket: 'large',
      role: 'quality',
      modelTuning: { top_k: 28 },
      taskTuning: { repeat_penalty: 1.2 }
    });
    expect(result.temperature).toBe(0.2);    // from family (overrides role default 0.15)
    expect(result.top_k).toBe(28);           // from modelTuning (overrides size 25)
    expect(result.repeat_penalty).toBe(1.2); // from taskTuning
    expect(result.num_ctx).toBe(16384);      // from size large
  });

  it('defaults to "default" role when role is not provided', () => {
    const result = mod.resolveTuning({ family: 'nonexistent' });
    expect(result.temperature).toBe(0.2);
    expect(result.num_ctx).toBe(8192);
    expect(result.top_k).toBe(30);
    expect(result.repeat_penalty).toBe(1.1);
  });

  it('unknown sizeBucket is ignored, family tuning remains', () => {
    const result = mod.resolveTuning({ family: 'qwen3', sizeBucket: 'xlarge', role: 'balanced' });
    // size override not applied — family template values stand
    expect(result.num_ctx).toBe(8192);
  });
});
