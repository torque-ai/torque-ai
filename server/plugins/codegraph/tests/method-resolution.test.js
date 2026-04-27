'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { ensureSchema } = require('../schema');
const { createHandlers } = require('../handlers');
const { destroyTinyRepo, git } = require('../test-helpers');

const data = (r) => r.structuredData;

describe('method-call resolution (Slice B.1, JS/TS)', () => {
  let repo, db, handlers;

  beforeEach(async () => {
    db = new Database(':memory:');
    ensureSchema(db);

    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-method-'));
    fs.writeFileSync(path.join(repo, 'animal.ts'),
      'export class Animal {\n' +
      '  speak(): string { return "noise"; }\n' +
      '}\n');
    fs.writeFileSync(path.join(repo, 'dog.ts'),
      'import { Animal } from "./animal";\n' +
      'class Dog {\n' +
      '  bark(d: Animal): string { return d.speak(); }\n' +
      '  newOne(): string { const a: Animal = new Animal(); return a.speak(); }\n' +
      '}\n');
    fs.writeFileSync(path.join(repo, 'unrelated.ts'),
      'class Other {\n' +
      '  speak(): string { return "x"; }\n' +
      '}\n' +
      'function caller(o: Other) { return o.speak(); }\n');
    git(repo, ['init', '--quiet']);
    git(repo, ['add', '.']);
    git(repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);

    handlers = createHandlers({ db });
    await handlers.cg_reindex({ repo_path: repo, async: false });
  });

  afterEach(() => {
    db.close();
    destroyTinyRepo(repo);
  });

  it('extractor records container_name on methods', async () => {
    const rows = db.prepare(
      "SELECT name, kind, container_name FROM cg_symbols WHERE kind = 'method' ORDER BY name"
    ).all();
    const map = Object.fromEntries(rows.map((r) => [r.name + '@' + r.container_name, r]));
    expect(map['speak@Animal']).toBeTruthy();
    expect(map['speak@Other']).toBeTruthy();
    expect(map['bark@Dog']).toBeTruthy();
  });

  it('extractor records receiver_name on member-call references', async () => {
    const rows = db.prepare(
      "SELECT target_name, receiver_name FROM cg_references WHERE target_name = 'speak' ORDER BY receiver_name"
    ).all();
    const recvs = rows.map((r) => r.receiver_name);
    // d.speak (bark) + a.speak (newOne) + o.speak (caller) → 3 refs.
    expect(recvs.sort()).toEqual(['a', 'd', 'o']);
  });

  it('captures TS variable type annotations as cg_locals', async () => {
    const rows = db.prepare(
      "SELECT local_name, type_name FROM cg_locals ORDER BY local_name"
    ).all();
    // d (param), a (typed const), o (param) all get Animal/Other type bindings.
    const map = Object.fromEntries(rows.map((r) => [r.local_name, r.type_name]));
    expect(map.d).toBe('Animal');
    expect(map.a).toBe('Animal');
    expect(map.o).toBe('Other');
  });

  it('pass 2 resolves method calls to the right container', async () => {
    const rows = db.prepare(
      `SELECT r.file_path, r.line, r.receiver_name, s.name AS resolved_to, s.container_name AS resolved_container
       FROM cg_references r
       LEFT JOIN cg_symbols s ON s.id = r.resolved_symbol_id
       WHERE r.target_name = 'speak'
       ORDER BY r.file_path, r.line`
    ).all();
    expect(rows).toEqual([
      expect.objectContaining({ file_path: 'dog.ts',       receiver_name: 'd', resolved_container: 'Animal' }),
      expect.objectContaining({ file_path: 'dog.ts',       receiver_name: 'a', resolved_container: 'Animal' }),
      expect.objectContaining({ file_path: 'unrelated.ts', receiver_name: 'o', resolved_container: 'Other' }),
    ]);
  });

  it('strict scope returns all resolved methods sharing a name', async () => {
    const r = await handlers.cg_find_references({ repo_path: repo, symbol: 'speak', scope: 'strict' });
    expect(data(r).references).toHaveLength(3);
  });

  it('strict scope + container filter narrows to one class', async () => {
    const onAnimal = await handlers.cg_find_references({
      repo_path: repo, symbol: 'speak', scope: 'strict', container: 'Animal',
    });
    expect(data(onAnimal).references.map((x) => x.file).sort()).toEqual(['dog.ts', 'dog.ts']);
    expect(data(onAnimal).container).toBe('Animal');

    const onOther = await handlers.cg_find_references({
      repo_path: repo, symbol: 'speak', scope: 'strict', container: 'Other',
    });
    expect(data(onOther).references).toHaveLength(1);
    expect(data(onOther).references[0].file).toBe('unrelated.ts');
  });

  it('container filter rejected without scope=strict', async () => {
    await expect(handlers.cg_find_references({
      repo_path: repo, symbol: 'speak', container: 'Animal',
    })).rejects.toThrow(/container filter requires scope/);
  });

  it('constructor inference: const x = new Foo() binds x to Foo', async () => {
    const aRow = db.prepare(
      "SELECT type_name FROM cg_locals WHERE local_name = 'a' LIMIT 1"
    ).get();
    expect(aRow.type_name).toBe('Animal');
  });
});
