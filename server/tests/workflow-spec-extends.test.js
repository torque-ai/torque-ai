'use strict';

const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveExtends } = require('../workflow-spec/extends');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-extends-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(rel, content) {
  const full = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

describe('resolveExtends', () => {
  it('returns the same spec when no extends', async () => {
    const specPath = write('a.yaml', `
version: 1
name: a
tasks:
  - node_id: x
    task: hi
`);

    const result = await resolveExtends(specPath);

    expect(result.ok).toBe(true);
    expect(result.spec.name).toBe('a');
    expect(result.spec.tasks).toHaveLength(1);
  });

  it('merges base and child top-level fields with child precedence', async () => {
    write('templates/base.yaml', `
version: 1
name: base
description: base description
project: base-project
tasks:
  - node_id: x
    task: base-x
`);
    const childPath = write('child.yaml', `
version: 1
name: child
extends: templates/base.yaml
description: child description
tasks:
  - node_id: x
    task: child-x
`);

    const result = await resolveExtends(childPath);

    expect(result.ok).toBe(true);
    expect(result.spec.name).toBe('child');
    expect(result.spec.description).toBe('child description');
    expect(result.spec.project).toBe('base-project');
    expect(result.spec.tasks).toHaveLength(1);
    expect(result.spec.tasks[0].task).toBe('child-x');
  });

  it('adds new child tasks while preserving inherited base tasks', async () => {
    write('templates/base.yaml', `
version: 1
name: base
tasks:
  - node_id: a
    task: a
  - node_id: b
    task: b
`);
    const childPath = write('child.yaml', `
version: 1
name: child
extends: templates/base.yaml
tasks:
  - node_id: c
    task: c
    depends_on: [b]
`);

    const result = await resolveExtends(childPath);

    expect(result.ok).toBe(true);
    expect(result.spec.tasks.map((task) => task.node_id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('removes inherited tasks when __remove is true', async () => {
    write('templates/base.yaml', `
version: 1
name: base
tasks:
  - node_id: a
    task: a
  - node_id: b
    task: b
`);
    const childPath = write('child.yaml', `
version: 1
name: child
extends: templates/base.yaml
tasks:
  - node_id: a
    __remove: true
`);

    const result = await resolveExtends(childPath);

    expect(result.ok).toBe(true);
    expect(result.spec.tasks.map((task) => task.node_id)).toEqual(['b']);
  });

  it('detects extends cycles', async () => {
    write('a.yaml', 'version: 1\nname: a\nextends: b.yaml\ntasks:\n  - node_id: x\n    task: x\n');
    write('b.yaml', 'version: 1\nname: b\nextends: a.yaml\ntasks:\n  - node_id: y\n    task: y\n');

    const result = await resolveExtends(path.join(tmpDir, 'a.yaml'));

    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/cycle/i);
  });

  it('caps extends depth', async () => {
    for (let index = 0; index < 12; index += 1) {
      const next = index + 1;
      write(
        `level-${index}.yaml`,
        `version: 1\nname: l${index}\nextends: level-${next}.yaml\ntasks:\n  - node_id: x\n    task: x\n`
      );
    }
    write('level-12.yaml', 'version: 1\nname: l12\ntasks:\n  - node_id: x\n    task: x\n');

    const result = await resolveExtends(path.join(tmpDir, 'level-0.yaml'));

    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/depth|too many/i);
  });

  it('reports missing template files', async () => {
    const childPath = write('child.yaml', `
version: 1
name: child
extends: templates/does-not-exist.yaml
tasks:
  - node_id: x
    task: x
`);

    const result = await resolveExtends(childPath);

    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/cannot read|not exist/i);
  });
});
