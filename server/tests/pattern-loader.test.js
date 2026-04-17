'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { loadPatternsFromDir } = require('../patterns/pattern-loader');

describe('loadPatternsFromDir', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pat-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writePattern(name, files) {
    const patDir = path.join(dir, name);
    fs.mkdirSync(patDir);
    for (const [key, value] of Object.entries(files)) {
      fs.writeFileSync(path.join(patDir, key), value);
    }
  }

  it('loads a minimal pattern with just system.md', () => {
    writePattern('summarize', { 'system.md': '# Summarize\nGiven text, return 3 bullets.' });

    const patterns = loadPatternsFromDir(dir);

    expect(patterns).toHaveLength(1);
    expect(patterns[0].name).toBe('summarize');
    expect(patterns[0].system).toMatch(/3 bullets/);
  });

  it('loads user.md template', () => {
    writePattern('translate', {
      'system.md': 'You translate text',
      'user.md': 'Translate this: {{input}}',
    });

    const patterns = loadPatternsFromDir(dir);

    expect(patterns[0].user_template).toBe('Translate this: {{input}}');
  });

  it('loads metadata.json with description + tags', () => {
    writePattern('extract_wisdom', {
      'system.md': '...',
      'metadata.json': JSON.stringify({ description: 'Pulls insights', tags: ['summarize', 'wisdom'] }),
    });

    const patterns = loadPatternsFromDir(dir);

    expect(patterns[0].description).toBe('Pulls insights');
    expect(patterns[0].tags).toEqual(['summarize', 'wisdom']);
  });

  it('skips directories without system.md', () => {
    writePattern('broken', { 'user.md': 'no system' });

    expect(loadPatternsFromDir(dir)).toHaveLength(0);
  });

  it('returns empty list when dir does not exist', () => {
    expect(loadPatternsFromDir(path.join(dir, 'nope'))).toEqual([]);
  });

  it('returns patterns sorted by name', () => {
    writePattern('zebra', { 'system.md': 'x' });
    writePattern('apple', { 'system.md': 'y' });
    writePattern('mango', { 'system.md': 'z' });

    const names = loadPatternsFromDir(dir).map((pattern) => pattern.name);

    expect(names).toEqual(['apple', 'mango', 'zebra']);
  });
});
