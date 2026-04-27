'use strict';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { computeLockHashes } = require('../coord/lock-hashes');

describe('coord lock-hashes', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-locks-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty object when no package-lock.json files exist', () => {
    const hashes = computeLockHashes(tmpDir);
    expect(hashes).toEqual({});
  });

  it('hashes a single root package-lock.json', () => {
    fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), '{"lockfileVersion":3}');
    const hashes = computeLockHashes(tmpDir);
    expect(Object.keys(hashes)).toEqual(['package-lock.json']);
    expect(hashes['package-lock.json']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes multiple subdir package-lock.json files (depth ≤ 3)', () => {
    fs.mkdirSync(path.join(tmpDir, 'server'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'dashboard'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), 'a');
    fs.writeFileSync(path.join(tmpDir, 'server', 'package-lock.json'), 'b');
    fs.writeFileSync(path.join(tmpDir, 'dashboard', 'package-lock.json'), 'c');
    const hashes = computeLockHashes(tmpDir);
    expect(Object.keys(hashes).sort()).toEqual([
      'dashboard/package-lock.json',
      'package-lock.json',
      'server/package-lock.json',
    ]);
  });

  it('skips package-lock.json inside node_modules', () => {
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'foo'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'foo', 'package-lock.json'), 'inner');
    fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), 'root');
    const hashes = computeLockHashes(tmpDir);
    expect(Object.keys(hashes)).toEqual(['package-lock.json']);
  });

  it('skips files deeper than 3 levels from root', () => {
    const deep = path.join(tmpDir, 'a', 'b', 'c', 'd');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'package-lock.json'), 'too deep');
    const hashes = computeLockHashes(tmpDir);
    expect(hashes).toEqual({});
  });

  it('returns deterministic hashes (same content → same hash)', () => {
    fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), 'identical content');
    const a = computeLockHashes(tmpDir);
    const b = computeLockHashes(tmpDir);
    expect(a).toEqual(b);
  });

  it('uses POSIX-style relative paths even on Windows', () => {
    fs.mkdirSync(path.join(tmpDir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'sub', 'package-lock.json'), 'x');
    const hashes = computeLockHashes(tmpDir);
    const keys = Object.keys(hashes);
    expect(keys).toContain('sub/package-lock.json');
    for (const k of keys) {
      expect(k).not.toContain('\\');
    }
  });
});
