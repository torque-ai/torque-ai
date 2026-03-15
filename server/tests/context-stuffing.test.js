/**
 * Unit Tests: utils/context-stuffing.js
 *
 * Tests context file reading, token estimation, budget enforcement,
 * and prompt formatting for context-stuffed providers.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const {
  stuffContext,
  estimateTokens,
  getContextBudget,
  PROVIDER_CONTEXT_BUDGETS,
  OPENROUTER_MODEL_BUDGETS,
  CONTEXT_STUFFING_PROVIDERS,
} = require('../utils/context-stuffing');

let testDir;

beforeEach(() => {
  testDir = path.join(os.tmpdir(), `torque-vtest-ctx-stuff-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── stuffContext ───────────────────────────────────────────────────────

describe('stuffContext', () => {
  it('prepends file contents to description with ### Project Context header', async () => {
    const filePath = path.join(testDir, 'example.js');
    fs.writeFileSync(filePath, 'const x = 1;\n');

    const result = await stuffContext({
      contextFiles: [filePath],
      workingDirectory: testDir,
      taskDescription: 'Fix the bug',
      provider: 'groq',
    });

    expect(result.enrichedDescription).toContain('### Project Context');
    expect(result.enrichedDescription).toContain('const x = 1;');
    expect(result.enrichedDescription).toContain('### Task');
    expect(result.enrichedDescription).toContain('Fix the bug');
    // Project Context should come before Task
    const ctxIdx = result.enrichedDescription.indexOf('### Project Context');
    const taskIdx = result.enrichedDescription.indexOf('### Task');
    expect(ctxIdx).toBeLessThan(taskIdx);
  });

  it('includes line count in file header', async () => {
    const filePath = path.join(testDir, 'three-lines.js');
    fs.writeFileSync(filePath, 'line1\nline2\nline3\n');

    const result = await stuffContext({
      contextFiles: [filePath],
      workingDirectory: testDir,
      taskDescription: 'task',
      provider: 'groq',
    });

    expect(result.enrichedDescription).toContain('(3 lines)');
  });

  it('uses relative paths with forward slashes in file headers', async () => {
    const subDir = path.join(testDir, 'src', 'utils');
    fs.mkdirSync(subDir, { recursive: true });
    const filePath = path.join(subDir, 'helper.js');
    fs.writeFileSync(filePath, 'module.exports = {};');

    const result = await stuffContext({
      contextFiles: [filePath],
      workingDirectory: testDir,
      taskDescription: 'task',
      provider: 'groq',
    });

    expect(result.enrichedDescription).toContain('--- FILE: src/utils/helper.js');
    // Should NOT contain backslashes in path
    expect(result.enrichedDescription).not.toMatch(/--- FILE:.*\\/);
  });

  it('rejects when estimated tokens exceed provider budget', async () => {
    // groq budget is 96000 tokens => ~384000 chars
    const filePath = path.join(testDir, 'huge.js');
    fs.writeFileSync(filePath, 'x'.repeat(500000));

    await expect(stuffContext({
      contextFiles: [filePath],
      workingDirectory: testDir,
      taskDescription: 'task',
      provider: 'groq',
    })).rejects.toThrow(/context too large/i);
  });

  it('respects custom contextBudget override', async () => {
    const filePath = path.join(testDir, 'small.js');
    fs.writeFileSync(filePath, 'const x = 1;\n'); // ~14 chars => ~4 tokens

    // Set a ridiculously low budget
    await expect(stuffContext({
      contextFiles: [filePath],
      workingDirectory: testDir,
      taskDescription: 'task',
      provider: 'groq',
      contextBudget: 1, // 1 token budget
    })).rejects.toThrow(/context too large/i);
  });

  it('allows google-ai larger context (600KB file fits in 800K budget)', async () => {
    const filePath = path.join(testDir, 'large.js');
    // 600KB => ~150K tokens, well under google-ai's 800K budget
    fs.writeFileSync(filePath, 'x'.repeat(600 * 1024));

    const result = await stuffContext({
      contextFiles: [filePath],
      workingDirectory: testDir,
      taskDescription: 'task',
      provider: 'google-ai',
    });

    expect(result.enrichedDescription).toContain('### Project Context');
    expect(result.enrichedDescription).toContain('### Task');
  });

  it('skips deleted/missing files gracefully', async () => {
    const goodFile = path.join(testDir, 'good.js');
    fs.writeFileSync(goodFile, 'const good = true;\n');
    const missingFile = path.join(testDir, 'missing.js');

    const result = await stuffContext({
      contextFiles: [goodFile, missingFile],
      workingDirectory: testDir,
      taskDescription: 'task',
      provider: 'groq',
    });

    expect(result.enrichedDescription).toContain('const good = true;');
    expect(result.enrichedDescription).toContain('### Project Context');
  });

  it('returns original description when contextFiles is empty', async () => {
    const result = await stuffContext({
      contextFiles: [],
      workingDirectory: testDir,
      taskDescription: 'original task',
      provider: 'groq',
    });

    expect(result.enrichedDescription).toBe('original task');
  });

  it('returns original description when all files are unreadable', async () => {
    const missing1 = path.join(testDir, 'gone1.js');
    const missing2 = path.join(testDir, 'gone2.js');

    const result = await stuffContext({
      contextFiles: [missing1, missing2],
      workingDirectory: testDir,
      taskDescription: 'original task',
      provider: 'groq',
    });

    expect(result.enrichedDescription).toBe('original task');
  });
});

// ─── estimateTokens ─────────────────────────────────────────────────────

describe('estimateTokens', () => {
  it('estimates ~4 chars per token (400 chars -> 100 tokens)', () => {
    const text = 'a'.repeat(400);
    expect(estimateTokens(text)).toBe(100);
  });

  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('returns 0 for null', () => {
    expect(estimateTokens(null)).toBe(0);
  });

  it('rounds up via Math.ceil', () => {
    // 5 chars / 4 = 1.25 => ceil => 2
    expect(estimateTokens('hello')).toBe(2);
  });
});

// ─── Exports ────────────────────────────────────────────────────────────

describe('PROVIDER_CONTEXT_BUDGETS', () => {
  it('has all 5 providers', () => {
    expect(PROVIDER_CONTEXT_BUDGETS).toHaveProperty('groq', 96000);
    expect(PROVIDER_CONTEXT_BUDGETS).toHaveProperty('cerebras', 6000);
    expect(PROVIDER_CONTEXT_BUDGETS).toHaveProperty('google-ai', 800000);
    expect(PROVIDER_CONTEXT_BUDGETS).toHaveProperty('openrouter', 96000);
    expect(PROVIDER_CONTEXT_BUDGETS).toHaveProperty('ollama-cloud', 200000);
  });
});

describe('CONTEXT_STUFFING_PROVIDERS', () => {
  it('is a Set with 5 entries', () => {
    expect(CONTEXT_STUFFING_PROVIDERS).toBeInstanceOf(Set);
    expect(CONTEXT_STUFFING_PROVIDERS.size).toBe(5);
    expect(CONTEXT_STUFFING_PROVIDERS.has('groq')).toBe(true);
    expect(CONTEXT_STUFFING_PROVIDERS.has('cerebras')).toBe(true);
    expect(CONTEXT_STUFFING_PROVIDERS.has('google-ai')).toBe(true);
    expect(CONTEXT_STUFFING_PROVIDERS.has('openrouter')).toBe(true);
    expect(CONTEXT_STUFFING_PROVIDERS.has('ollama-cloud')).toBe(true);
  });
});

describe('getContextBudget', () => {
  it('returns provider default for non-openrouter providers', () => {
    expect(getContextBudget('groq')).toBe(96000);
    expect(getContextBudget('google-ai')).toBe(800000);
    expect(getContextBudget('cerebras')).toBe(6000);
  });

  it('returns openrouter default when model is not specified', () => {
    expect(getContextBudget('openrouter')).toBe(96000);
    expect(getContextBudget('openrouter', null)).toBe(96000);
  });

  it('returns 200K for qwen3-coder on openrouter', () => {
    expect(getContextBudget('openrouter', 'qwen/qwen3-coder:free')).toBe(200000);
  });

  it('returns 190K for step-3.5-flash on openrouter', () => {
    expect(getContextBudget('openrouter', 'stepfun/step-3.5-flash:free')).toBe(190000);
  });

  it('returns 96K for trinity-large on openrouter', () => {
    expect(getContextBudget('openrouter', 'arcee-ai/trinity-large-preview:free')).toBe(96000);
  });

  it('returns 24K for gemma-3-12b on openrouter', () => {
    expect(getContextBudget('openrouter', 'google/gemma-3-12b-it:free')).toBe(24000);
  });

  it('returns 24K for gemma-3-27b on openrouter', () => {
    expect(getContextBudget('openrouter', 'google/gemma-3-27b-it:free')).toBe(24000);
  });

  it('returns openrouter default for unknown model', () => {
    expect(getContextBudget('openrouter', 'unknown/model:free')).toBe(96000);
  });

  it('returns fallback 96000 for unknown provider', () => {
    expect(getContextBudget('nonexistent')).toBe(96000);
  });
});

describe('stuffContext with model-aware budgets', () => {
  it('rejects large context for gemma-3-12b (24K budget)', async () => {
    const filePath = path.join(testDir, 'medium.js');
    // ~100K chars => ~25K tokens, exceeds gemma's 24K budget
    fs.writeFileSync(filePath, 'x'.repeat(100000));

    await expect(stuffContext({
      contextFiles: [filePath],
      workingDirectory: testDir,
      taskDescription: 'task',
      provider: 'openrouter',
      model: 'google/gemma-3-12b-it:free',
    })).rejects.toThrow(/context too large/i);
  });

  it('allows same context for qwen3-coder (200K budget)', async () => {
    const filePath = path.join(testDir, 'medium.js');
    fs.writeFileSync(filePath, 'x'.repeat(100000));

    const result = await stuffContext({
      contextFiles: [filePath],
      workingDirectory: testDir,
      taskDescription: 'task',
      provider: 'openrouter',
      model: 'qwen/qwen3-coder:free',
    });

    expect(result.enrichedDescription).toContain('### Project Context');
  });
});
