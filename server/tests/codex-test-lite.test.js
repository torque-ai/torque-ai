'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { wrapWithInstructions, TASK_TYPE_INSTRUCTIONS } = require('../providers/prompts');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'torque-test-lite-'));
}

describe('test-verification-lite injection', () => {
  it('exists in TASK_TYPE_INSTRUCTIONS', () => {
    expect(TASK_TYPE_INSTRUCTIONS['test-verification-lite']).toBeTruthy();
    expect(TASK_TYPE_INSTRUCTIONS['test-verification-lite']).toContain('Do NOT run the full project test suite');
    expect(TASK_TYPE_INSTRUCTIONS['test-verification-lite']).toContain('SPECIFIC test file');
  });

  it('is injected into codex prompts without a working_directory (conservative default)', () => {
    const wrapped = wrapWithInstructions('Fix the login bug', 'codex', null, {});
    expect(wrapped).toContain('Do NOT run the full project test suite');
  });

  it('is injected into codex-spark prompts without a working_directory', () => {
    const wrapped = wrapWithInstructions('Fix the login bug', 'codex-spark', null, {});
    expect(wrapped).toContain('Do NOT run the full project test suite');
  });

  it('is NOT injected into ollama prompts', () => {
    const wrapped = wrapWithInstructions('Fix the login bug', 'ollama', null, {});
    expect(wrapped).not.toContain('Do NOT run the full project test suite');
  });

  it('is NOT injected into claude-cli prompts', () => {
    const wrapped = wrapWithInstructions('Fix the login bug', 'claude-cli', null, {});
    expect(wrapped).not.toContain('Do NOT run the full project test suite');
  });

  it('is NOT injected when working_directory is a .NET project (.csproj present)', () => {
    const dir = makeTempDir();
    try {
      fs.writeFileSync(path.join(dir, 'SpudgetBooks.sln'), '');
      fs.writeFileSync(path.join(dir, 'Project.csproj'), '<Project />');
      const wrapped = wrapWithInstructions('Fix the login bug', 'codex', null, { workingDirectory: dir });
      expect(wrapped).not.toContain('Do NOT run the full project test suite');
      expect(wrapped).not.toContain('npx vitest');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is NOT injected when working_directory is a Rust project (Cargo.toml)', () => {
    const dir = makeTempDir();
    try {
      fs.writeFileSync(path.join(dir, 'Cargo.toml'), '[package]\nname = "demo"');
      const wrapped = wrapWithInstructions('Fix the login bug', 'codex', null, { workingDirectory: dir });
      expect(wrapped).not.toContain('Do NOT run the full project test suite');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is NOT injected when working_directory is a Go project (go.mod)', () => {
    const dir = makeTempDir();
    try {
      fs.writeFileSync(path.join(dir, 'go.mod'), 'module demo');
      const wrapped = wrapWithInstructions('Fix the login bug', 'codex', null, { workingDirectory: dir });
      expect(wrapped).not.toContain('Do NOT run the full project test suite');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('IS injected when working_directory is a Node project with vitest', () => {
    const dir = makeTempDir();
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        name: 'demo',
        devDependencies: { vitest: '^1.0.0' }
      }));
      const wrapped = wrapWithInstructions('Fix the login bug', 'codex', null, { workingDirectory: dir });
      expect(wrapped).toContain('Do NOT run the full project test suite');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is NOT injected when working_directory is a Node project without a JS test framework', () => {
    const dir = makeTempDir();
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        name: 'demo',
        dependencies: { express: '^4.0.0' }
      }));
      const wrapped = wrapWithInstructions('Fix the login bug', 'codex', null, { workingDirectory: dir });
      expect(wrapped).not.toContain('Do NOT run the full project test suite');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
