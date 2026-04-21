'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createAutoRecoveryServices, detectTechStack, cleanupPaths } =
  require('../factory/auto-recovery/services');

describe('detectTechStack', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-tech-')); });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

  it('detects dotnet from csproj', () => {
    fs.writeFileSync(path.join(tmp, 'Foo.csproj'), '<Project/>');
    expect(detectTechStack(tmp)).toContain('dotnet');
  });
  it('detects node from package.json', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), '{}');
    expect(detectTechStack(tmp)).toContain('node');
  });
  it('detects python from pyproject.toml', () => {
    fs.writeFileSync(path.join(tmp, 'pyproject.toml'), '');
    expect(detectTechStack(tmp)).toContain('python');
  });
  it('detects rust from Cargo.toml', () => {
    fs.writeFileSync(path.join(tmp, 'Cargo.toml'), '');
    expect(detectTechStack(tmp)).toContain('rust');
  });
  it('detects go from go.mod', () => {
    fs.writeFileSync(path.join(tmp, 'go.mod'), '');
    expect(detectTechStack(tmp)).toContain('go');
  });
  it('returns empty for unknown project', () => {
    expect(detectTechStack(tmp)).toEqual([]);
  });
});

describe('cleanupPaths', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-clean-')); });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

  it('deletes existing paths recursively and reports them', () => {
    const obj = path.join(tmp, 'obj', 'Debug');
    fs.mkdirSync(obj, { recursive: true });
    fs.writeFileSync(path.join(obj, 'a.json'), '{}');
    const deleted = cleanupPaths(tmp, ['obj', 'bin']);
    expect(deleted).toContain(path.join(tmp, 'obj'));
    expect(fs.existsSync(path.join(tmp, 'obj'))).toBe(false);
  });
  it('is idempotent when paths are absent', () => {
    expect(cleanupPaths(tmp, ['obj'])).toEqual([]);
  });
  it('refuses paths outside the project root', () => {
    expect(cleanupPaths(tmp, ['../../../etc'])).toEqual([]);
  });
});

describe('createAutoRecoveryServices bundle shape', () => {
  it('includes the expected keys', () => {
    const s = createAutoRecoveryServices({
      db: {}, eventBus: {}, logger: { warn: () => {}, info: () => {}, error: () => {} },
    });
    expect(typeof s.cleanupWorktreeBuildArtifacts).toBe('function');
    expect(s.db).toBeTruthy();
    expect(s.eventBus).toBeTruthy();
    expect(s.logger).toBeTruthy();
  });
});
