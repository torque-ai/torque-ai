'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { afterEach, beforeEach, describe, expect, it } = require('vitest');

const { createPatternsStore } = require('../patterns/store');

describe('patterns/store', () => {
  let rootDir;
  let patternsDir;
  let store;

  function writePattern(name, files) {
    const patternDir = path.join(patternsDir, name);
    fs.mkdirSync(patternDir, { recursive: true });

    for (const [fileName, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(patternDir, fileName), content, 'utf8');
    }
  }

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patterns-store-'));
    patternsDir = path.join(rootDir, '.torque', 'patterns');
    fs.mkdirSync(patternsDir, { recursive: true });
  });

  afterEach(() => {
    if (store) {
      store.shutdown();
      store = null;
    }

    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('lists and gets patterns from the configured source directory', () => {
    writePattern('extract_wisdom', {
      'system.md': 'You extract insights.',
      'metadata.json': JSON.stringify({ description: 'Pull insights', tags: ['summary'] }),
    });

    store = createPatternsStore({ dir: patternsDir, cwd: rootDir });

    expect(store.sourceDir).toBe(path.resolve(patternsDir));
    expect(store.list()).toEqual([
      expect.objectContaining({
        name: 'extract_wisdom',
        description: 'Pull insights',
        tags: ['summary'],
      }),
    ]);
    expect(store.get('extract_wisdom')).toEqual(expect.objectContaining({
      name: 'extract_wisdom',
      system: 'You extract insights.',
    }));
  });

  it('reloads patterns after filesystem changes', () => {
    writePattern('summarize', { 'system.md': 'Summarize input.' });

    store = createPatternsStore({ dir: patternsDir, cwd: rootDir });
    expect(store.list()).toHaveLength(1);

    writePattern('classify', {
      'system.md': 'Classify input.',
      'metadata.json': JSON.stringify({ description: 'Classify text' }),
    });

    expect(store.reload()).toBe(2);
    expect(store.get('classify')).toEqual(expect.objectContaining({
      name: 'classify',
      description: 'Classify text',
    }));
  });

  it('returns cloned pattern objects so callers cannot mutate store state', () => {
    writePattern('summarize', {
      'system.md': 'Summarize input.',
      'metadata.json': JSON.stringify({ tags: ['one'] }),
    });

    store = createPatternsStore({ dir: patternsDir, cwd: rootDir });

    const listedPattern = store.list()[0];
    listedPattern.tags.push('two');

    expect(store.get('summarize').tags).toEqual(['one']);
  });
});
