'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

let testDir, origDataDir, db, mod;
const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
let templateBuffer;

function setup() {
  testDir = path.join(os.tmpdir(), `torque-vtest-task-class-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;
  db = require('../database');
  if (!templateBuffer) templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
  db.resetForTest(templateBuffer);
  mod = require('../db/host-management');
  mod.setDb(db.getDb ? db.getDb() : db.getDbInstance());
}

function teardown() {
  if (db) try { db.close(); } catch {}
  if (testDir) {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
    if (origDataDir !== undefined) process.env.TORQUE_DATA_DIR = origDataDir;
    else delete process.env.TORQUE_DATA_DIR;
  }
}

describe('Task Classification', () => {
  beforeAll(() => setup());
  afterAll(() => teardown());

  describe('classifyTaskType', () => {
    it('detects testing tasks', () => {
      expect(mod.classifyTaskType('Write unit tests for the parser module')).toBe('testing');
      expect(mod.classifyTaskType('Add test coverage for auth')).toBe('testing');
    });

    it('detects refactoring tasks', () => {
      expect(mod.classifyTaskType('Refactor the database module')).toBe('refactoring');
      expect(mod.classifyTaskType('Extract helper functions from utils')).toBe('refactoring');
      expect(mod.classifyTaskType('Rename the getUserById function')).toBe('refactoring');
      expect(mod.classifyTaskType('Move the config parsing to its own file')).toBe('refactoring');
    });

    it('detects reasoning tasks', () => {
      expect(mod.classifyTaskType('Debug the login timeout issue')).toBe('reasoning');
      expect(mod.classifyTaskType('Find root cause of the crash')).toBe('reasoning');
      expect(mod.classifyTaskType('Analyze performance bottleneck')).toBe('reasoning');
      expect(mod.classifyTaskType('Why does the queue stall?')).toBe('reasoning');
    });

    it('detects docs tasks', () => {
      expect(mod.classifyTaskType('Document the API endpoints')).toBe('docs');
      expect(mod.classifyTaskType('Update the README with new setup steps')).toBe('docs');
      expect(mod.classifyTaskType('Add JSDoc comments to all public functions')).toBe('docs');
      expect(mod.classifyTaskType('Write changelog entry for v2.1')).toBe('docs');
    });

    it('detects scan/review/audit tasks', () => {
      expect(mod.classifyTaskType('Scan this file for security issues')).toBe('scan');
      expect(mod.classifyTaskType('Review the error handling in this module')).toBe('scan');
      expect(mod.classifyTaskType('Audit the authentication flow')).toBe('scan');
      expect(mod.classifyTaskType('Inspect the database queries for SQL injection')).toBe('scan');
      expect(mod.classifyTaskType('Check the code for potential race conditions')).toBe('scan');
      expect(mod.classifyTaskType('Find problems in the queue scheduler')).toBe('scan');
      expect(mod.classifyTaskType('Do a code review of the API handlers')).toBe('scan');
    });

    it('defaults to code_gen for everything else', () => {
      expect(mod.classifyTaskType('Implement user authentication')).toBe('code_gen');
      expect(mod.classifyTaskType('Add a new REST endpoint for /users')).toBe('code_gen');
      expect(mod.classifyTaskType('Create the dashboard component')).toBe('code_gen');
    });

    it('handles empty/null input', () => {
      expect(mod.classifyTaskType('')).toBe('code_gen');
      expect(mod.classifyTaskType(null)).toBe('code_gen');
      expect(mod.classifyTaskType(undefined)).toBe('code_gen');
    });
  });

  describe('detectTaskLanguage', () => {
    it('detects language from file extensions', () => {
      expect(mod.detectTaskLanguage('Fix the parser', ['src/parser.ts'])).toBe('typescript');
      expect(mod.detectTaskLanguage('Fix the parser', ['src/parser.py'])).toBe('python');
      expect(mod.detectTaskLanguage('Fix it', ['src/main.cs'])).toBe('csharp');
      expect(mod.detectTaskLanguage('Fix it', ['src/main.go'])).toBe('go');
      expect(mod.detectTaskLanguage('Fix it', ['src/main.rs'])).toBe('rust');
      expect(mod.detectTaskLanguage('Fix it', ['src/main.js'])).toBe('javascript');
      expect(mod.detectTaskLanguage('Fix it', ['src/App.jsx'])).toBe('javascript');
      expect(mod.detectTaskLanguage('Fix it', ['src/App.tsx'])).toBe('typescript');
      expect(mod.detectTaskLanguage('Fix it', ['src/App.vue'])).toBe('javascript');
      expect(mod.detectTaskLanguage('Fix it', ['src/App.svelte'])).toBe('javascript');
    });

    it('detects language from description keywords', () => {
      expect(mod.detectTaskLanguage('Write a Python script to parse CSV')).toBe('python');
      expect(mod.detectTaskLanguage('Create a TypeScript interface')).toBe('typescript');
      expect(mod.detectTaskLanguage('Implement in Go')).toBe('go');
      expect(mod.detectTaskLanguage('Write Rust module')).toBe('rust');
    });

    it('uses majority language with multiple files', () => {
      expect(mod.detectTaskLanguage('Fix bugs', [
        'src/a.ts', 'src/b.ts', 'src/c.js'
      ])).toBe('typescript');
    });

    it('falls back to general', () => {
      expect(mod.detectTaskLanguage('Do something')).toBe('general');
      expect(mod.detectTaskLanguage('Fix it', [])).toBe('general');
      expect(mod.detectTaskLanguage('', [])).toBe('general');
    });

    it('handles null/undefined inputs', () => {
      expect(mod.detectTaskLanguage(null, null)).toBe('general');
      expect(mod.detectTaskLanguage(undefined)).toBe('general');
    });
  });
});
