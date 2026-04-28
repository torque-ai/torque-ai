'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { ensureSchema } = require('../schema');
const { createHandlers } = require('../handlers');
const { setupTinyRepo, destroyTinyRepo, git } = require('../test-helpers');

const data = (r) => r.structuredData;

describe('cg_search', () => {
  let db, repo, handlers;

  beforeEach(async () => {
    db = new Database(':memory:'); ensureSchema(db);
    repo = setupTinyRepo();
    // Add a richer fixture: a class with methods, an exported function,
    // some matching/non-matching names so search filters can be exercised.
    fs.writeFileSync(path.join(repo, 'create.js'),
      'export function createTask() {}\n' +
      'export function createWorkflow() {}\n' +
      'function helperPrivate() {}\n');
    fs.writeFileSync(path.join(repo, 'animal.js'),
      'class Animal {\n' +
      '  speak() {}\n' +
      '  bark() {}\n' +
      '}\n' +
      'class Plant {\n' +
      '  speak() {}\n' +
      '}\n');
    git(repo, ['add', '.']);
    git(repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'fixture']);
    handlers = createHandlers({ db });
    await handlers.cg_reindex({ repo_path: repo, async: false });
  });

  afterEach(() => { db.close(); destroyTinyRepo(repo); });

  it('matches a literal name', async () => {
    const r = data(await handlers.cg_search({ repo_path: repo, pattern: 'createTask' }));
    expect(r.results.map((s) => s.name)).toEqual(['createTask']);
    expect(r.results[0].kind).toBe('function');
    expect(r.results[0].file).toBe('create.js');
    expect(r.truncated).toBe(false);
  });

  it('matches a glob prefix pattern', async () => {
    const r = data(await handlers.cg_search({ repo_path: repo, pattern: 'create*' }));
    const names = r.results.map((s) => s.name).sort();
    expect(names).toEqual(['createTask', 'createWorkflow']);
  });

  it('matches a glob suffix pattern', async () => {
    const r = data(await handlers.cg_search({ repo_path: repo, pattern: '*Workflow' }));
    expect(r.results.map((s) => s.name)).toEqual(['createWorkflow']);
  });

  it('kind filter narrows to functions', async () => {
    const r = data(await handlers.cg_search({ repo_path: repo, pattern: '*', kind: 'function' }));
    const names = r.results.map((s) => s.name).sort();
    // Methods (speak, bark) excluded; classes (Animal, Plant) excluded; only functions remain.
    expect(names).toContain('createTask');
    expect(names).toContain('createWorkflow');
    expect(names).toContain('helperPrivate');
    expect(names).not.toContain('speak');
    expect(names).not.toContain('Animal');
  });

  it('container filter narrows to one class', async () => {
    const r = data(await handlers.cg_search({ repo_path: repo, pattern: 'speak', container: 'Animal' }));
    expect(r.results).toHaveLength(1);
    expect(r.results[0].name).toBe('speak');
    expect(r.results[0].container).toBe('Animal');
  });

  it('is_exported=true returns only exported symbols', async () => {
    const r = data(await handlers.cg_search({ repo_path: repo, pattern: '*', is_exported: true, kind: 'function' }));
    const names = r.results.map((s) => s.name).sort();
    expect(names).toContain('createTask');
    expect(names).toContain('createWorkflow');
    expect(names).not.toContain('helperPrivate');
    for (const s of r.results) expect(s.is_exported).toBe(true);
  });

  it('truncates with hint when limit is hit', async () => {
    const r = data(await handlers.cg_search({ repo_path: repo, pattern: '*', limit: 2 }));
    expect(r.results).toHaveLength(2);
    expect(r.truncated).toBe(true);
    expect(r.limit).toBe(2);
    expect(r.truncation_hint).toMatch(/2-result cap/);
  });

  it('returns empty results when pattern matches nothing', async () => {
    const r = data(await handlers.cg_search({ repo_path: repo, pattern: 'nope_doesnt_exist' }));
    expect(r.results).toHaveLength(0);
    expect(r.truncated).toBe(false);
  });

  it('sets staleness against current HEAD', async () => {
    const r = data(await handlers.cg_search({ repo_path: repo, pattern: '*' }));
    expect(r.staleness.indexed).toBe(true);
    expect(r.staleness.stale).toBe(false);
  });

  it('rejects when repo_path or pattern is missing', async () => {
    await expect(handlers.cg_search({ pattern: 'X' })).rejects.toThrow(/repo_path/);
    await expect(handlers.cg_search({ repo_path: repo })).rejects.toThrow(/pattern/);
  });

  it('caps limit at 1000 internally even when caller passes higher', async () => {
    const r = data(await handlers.cg_search({ repo_path: repo, pattern: '*', limit: 99999 }));
    expect(r.limit).toBe(1000);
  });

  it('disambiguates same-name methods across two classes via container filter', async () => {
    // 'speak' exists on both Animal and Plant.
    const both = data(await handlers.cg_search({ repo_path: repo, pattern: 'speak' }));
    expect(both.results).toHaveLength(2);
    const animalOnly = data(await handlers.cg_search({ repo_path: repo, pattern: 'speak', container: 'Animal' }));
    expect(animalOnly.results).toHaveLength(1);
    expect(animalOnly.results[0].container).toBe('Animal');
  });
});
