'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { buildDataset } = require('../fine-tune/dataset-builder');

describe('buildDataset', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-'));
    fs.writeFileSync(path.join(dir, 'a.js'), 'function hello() { return 1; }');
    fs.writeFileSync(path.join(dir, 'b.py'), 'def world():\n    return 2');
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'node_modules', 'junk.js'), 'ignore me');
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('outputs one JSONL line per matched file', async () => {
    const outPath = path.join(dir, 'train.jsonl');
    await buildDataset({
      workingDir: dir,
      globs: ['**/*.js', '**/*.py'],
      outputPath: outPath,
      ignore: ['node_modules/**'],
    });
    const lines = fs.readFileSync(outPath, 'utf8').trim().split('\n');
    expect(lines.length).toBe(2);
    const parsed = lines.map(l => JSON.parse(l));
    expect(parsed.every(r => r.prompt && r.completion)).toBe(true);
  });

  it('skips files matching ignore globs', async () => {
    const outPath = path.join(dir, 'train.jsonl');
    await buildDataset({ workingDir: dir, globs: ['**/*.js'], outputPath: outPath, ignore: ['node_modules/**'] });
    const lines = fs.readFileSync(outPath, 'utf8').trim().split('\n');
    expect(lines.length).toBe(1);
    expect(lines[0]).not.toMatch(/ignore me/);
  });

  it('skips files larger than maxFileBytes', async () => {
    fs.writeFileSync(path.join(dir, 'big.js'), 'x'.repeat(200 * 1024));
    const outPath = path.join(dir, 'train.jsonl');
    await buildDataset({ workingDir: dir, globs: ['**/*.js'], outputPath: outPath, maxFileBytes: 100 * 1024 });
    const contents = fs.readFileSync(outPath, 'utf8');
    expect(contents).not.toMatch(/big\.js/);
  });
});
