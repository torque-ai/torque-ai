'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { ensureSchema } = require('../schema');
const { extractFromSource } = require('../extractors/javascript');
const { classHierarchy } = require('../queries/class-hierarchy');
const { createHandlers } = require('../handlers');

describe('class hierarchy extractor', () => {
  it('captures JS class extends', async () => {
    const r = await extractFromSource('class Dog extends Animal {}\n', 'javascript');
    expect(r.classEdges).toEqual([
      expect.objectContaining({ subtypeName: 'Dog', supertypeName: 'Animal', edgeKind: 'extends' }),
    ]);
  });

  it('captures TS class extends + implements', async () => {
    const r = await extractFromSource(
      'class Dog extends Animal implements IPet, ILoud { name = ""; volume = 0; }\n',
      'tsx'
    );
    const edges = r.classEdges.map(({ subtypeName, supertypeName, edgeKind }) =>
      ({ subtypeName, supertypeName, edgeKind }));
    expect(edges).toEqual(expect.arrayContaining([
      { subtypeName: 'Dog', supertypeName: 'Animal', edgeKind: 'extends' },
      { subtypeName: 'Dog', supertypeName: 'IPet',   edgeKind: 'implements' },
      { subtypeName: 'Dog', supertypeName: 'ILoud',  edgeKind: 'implements' },
    ]));
  });

  it('captures TS interface extends', async () => {
    const r = await extractFromSource('interface ILoud extends IPet { volume: number }\n', 'tsx');
    expect(r.classEdges).toEqual([
      expect.objectContaining({ subtypeName: 'ILoud', supertypeName: 'IPet', edgeKind: 'extends' }),
    ]);
  });

  it('handles member-expression supertypes (ns.Foo)', async () => {
    const r = await extractFromSource('class Dog extends ns.Animal {}\n', 'javascript');
    expect(r.classEdges).toEqual([
      expect.objectContaining({ subtypeName: 'Dog', supertypeName: 'Animal', edgeKind: 'extends' }),
    ]);
  });

  it('emits no edges for plain classes without heritage', async () => {
    const r = await extractFromSource('class Animal { speak() {} }\n', 'javascript');
    expect(r.classEdges).toEqual([]);
  });
});

describe('classHierarchy query', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureSchema(db);

    const insertSym = db.prepare(`
      INSERT INTO cg_symbols (repo_path, file_path, name, kind, start_line, start_col, end_line, end_col)
      VALUES ('/r', 'f.js', @name, @kind, 1, 0, 1, 0)
    `);
    const insertEdge = db.prepare(`
      INSERT INTO cg_class_edges (repo_path, file_path, subtype_name, supertype_name, edge_kind, line, col)
      VALUES ('/r', 'f.js', @sub, @sup, @kind, 1, 0)
    `);

    // Animal <- Dog <- Puppy; Animal <- Cat
    for (const [name, kind] of [
      ['Animal', 'class'], ['Dog', 'class'], ['Puppy', 'class'], ['Cat', 'class'],
    ]) insertSym.run({ name, kind });

    insertEdge.run({ sub: 'Dog',   sup: 'Animal', kind: 'extends' });
    insertEdge.run({ sub: 'Puppy', sup: 'Dog',    kind: 'extends' });
    insertEdge.run({ sub: 'Cat',   sup: 'Animal', kind: 'extends' });
  });

  afterEach(() => db.close());

  it('walks descendants by depth', () => {
    const r = classHierarchy({ db, repoPath: '/r', symbol: 'Animal', direction: 'descendants', depth: 1 });
    const subs = r.edges.map((e) => e.from).sort();
    expect(subs).toEqual(['Cat', 'Dog']); // depth=1 stops before Puppy
  });

  it('walks descendants transitively', () => {
    const r = classHierarchy({ db, repoPath: '/r', symbol: 'Animal', direction: 'descendants', depth: 3 });
    const subs = r.edges.map((e) => e.from).sort();
    expect(subs).toEqual(['Cat', 'Dog', 'Puppy']);
  });

  it('walks ancestors transitively', () => {
    const r = classHierarchy({ db, repoPath: '/r', symbol: 'Puppy', direction: 'ancestors', depth: 3 });
    const sups = r.edges.map((e) => e.to).sort();
    expect(sups).toEqual(['Animal', 'Dog']);
  });

  it('decorates nodes with kind from cg_symbols', () => {
    const r = classHierarchy({ db, repoPath: '/r', symbol: 'Animal', direction: 'descendants', depth: 3 });
    const dog = r.nodes.find((n) => n.name === 'Dog');
    expect(dog).toEqual({ name: 'Dog', kind: 'class' });
  });

  it('caps result and sets truncated=true', () => {
    const insertEdge = db.prepare(`
      INSERT INTO cg_class_edges (repo_path, file_path, subtype_name, supertype_name, edge_kind, line, col)
      VALUES ('/r', 'f.js', @sub, 'Base', 'extends', 1, 0)
    `);
    for (let i = 0; i < 150; i++) insertEdge.run({ sub: `Sub${i}` });
    const r = classHierarchy({ db, repoPath: '/r', symbol: 'Base', direction: 'descendants', depth: 2 });
    expect(r.truncated).toBe(true);
    expect(r.nodes.length).toBeLessThanOrEqual(r.max_nodes);
  });
});

describe('cg_class_hierarchy handler integration', () => {
  let repo, db, plugin;

  function git(cwd, args) {
    if (require('child_process')._realExecFileSync) {
      require('child_process').execFileSync = require('child_process')._realExecFileSync;
    }
    require('child_process').execFileSync('git', args, {
      cwd, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  }

  beforeEach(async () => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-hier-'));
    fs.writeFileSync(path.join(repo, 'a.js'), 'class Animal {}\nclass Dog extends Animal {}\n');
    git(repo, ['init', '--quiet']);
    git(repo, ['add', '.']);
    git(repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);

    db = new Database(':memory:');
    ensureSchema(db);
    const handlers = createHandlers({ db });
    await handlers.cg_reindex({ repo_path: repo, async: false });
    plugin = handlers;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('returns descendants with sparse hint when found', async () => {
    const r = await plugin.cg_class_hierarchy({ repo_path: repo, symbol: 'Animal' });
    expect(r.structuredData.edges).toEqual([
      expect.objectContaining({ from: 'Dog', to: 'Animal', kind: 'extends' }),
    ]);
    expect(r.structuredData.hint).toBeUndefined(); // no hint when there ARE results
  });

  it('emits hint when no edges found', async () => {
    const r = await plugin.cg_class_hierarchy({ repo_path: repo, symbol: 'Bogus' });
    expect(r.structuredData.edges).toEqual([]);
    expect(r.structuredData.hint).toMatch(/No descendants found/);
  });

  it('rejects invalid direction', async () => {
    await expect(plugin.cg_class_hierarchy({
      repo_path: repo, symbol: 'Animal', direction: 'sideways',
    })).rejects.toThrow(/direction must be/);
  });
});
