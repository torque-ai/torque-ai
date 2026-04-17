'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseSpec, parseSpecString } = require('../workflow-spec/parse');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-parse-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(relPath, content) {
  const fullPath = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
  return fullPath;
}

describe('workflow-spec parseSpecString', () => {
  it('parses a minimal valid spec', () => {
    const yamlText = `
version: 1
name: my-workflow
tasks:
  - node_id: step-1
    task: Do something
`;

    const result = parseSpecString(yamlText);

    expect(result.ok).toBe(true);
    expect(result.spec.name).toBe('my-workflow');
    expect(result.spec.tasks).toHaveLength(1);
    expect(result.spec.tasks[0].node_id).toBe('step-1');
    expect(result.spec.tasks[0].task_description).toBe('Do something');
  });

  it('rejects missing required fields', () => {
    const result = parseSpecString('version: 1\nname: x');

    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/tasks/i);
  });

  it('rejects unknown top-level keys', () => {
    const yamlText = `
version: 1
name: x
unknown: value
tasks:
  - node_id: a
    task: b
`;

    const result = parseSpecString(yamlText);

    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/additional|unknown/i);
  });

  it('rejects unknown version', () => {
    const yamlText = `
version: 2
name: x
tasks:
  - node_id: a
    task: b
`;

    const result = parseSpecString(yamlText);

    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/version/i);
  });

  it('rejects invalid YAML syntax', () => {
    const result = parseSpecString('version: 1\nname: [unclosed');

    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/yaml|parse/i);
  });

  it('accepts authored template directives in raw specs', () => {
    const yamlText = `
version: 1
name: child
extends: templates/base.yaml
tasks:
  - node_id: remove-me
    __remove: true
  - node_id: keep-me
    task: Keep me
`;

    const result = parseSpecString(yamlText);

    expect(result.ok).toBe(true);
    expect(result.spec.extends).toBe('templates/base.yaml');
    expect(result.spec.tasks).toEqual([
      { node_id: 'remove-me', __remove: true },
      { node_id: 'keep-me', task: 'Keep me', task_description: 'Keep me' },
    ]);
  });
});

describe('workflow-spec parseSpec', () => {
  it('resolves extends before validation', async () => {
    write('templates/base.yaml', `
version: 1
name: base
project: inherited-project
tasks:
  - node_id: base-step
    task: Base task
`);
    const childPath = write('child.yaml', `
version: 1
name: child
extends: templates/base.yaml
tasks:
  - node_id: base-step
    task: Override base task
  - node_id: child-step
    task: Child task
    depends_on: [base-step]
`);

    const result = await parseSpec(childPath);

    expect(result.ok).toBe(true);
    expect(result.spec.project).toBe('inherited-project');
    expect(result.spec.tasks.map((task) => task.node_id)).toEqual(['base-step', 'child-step']);
    expect(result.spec.tasks[0]).toMatchObject({
      node_id: 'base-step',
      task: 'Override base task',
      task_description: 'Override base task',
    });
  });

  it('supports removing inherited tasks before validation', async () => {
    write('templates/base.yaml', `
version: 1
name: base
tasks:
  - node_id: remove-me
    task: Remove me
  - node_id: keep-me
    task: Keep me
`);
    const childPath = write('child.yaml', `
version: 1
name: child
extends: templates/base.yaml
tasks:
  - node_id: remove-me
    __remove: true
`);

    const result = await parseSpec(childPath);

    expect(result.ok).toBe(true);
    expect(result.spec.tasks).toHaveLength(1);
    expect(result.spec.tasks[0].node_id).toBe('keep-me');
  });

  it('returns resolver errors when extends fails', async () => {
    const childPath = write('child.yaml', `
version: 1
name: child
extends: templates/missing.yaml
tasks:
  - node_id: step
    task: Run
`);

    const result = await parseSpec(childPath);

    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/cannot read|not exist/i);
  });
});
