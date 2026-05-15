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

  it('normalizes task field: task -> task_description for workflow engine', () => {
    const yamlText = `
version: 1
name: x
tasks:
  - node_id: a
    task: Write a function
`;

    const result = parseSpecString(yamlText);

    expect(result.ok).toBe(true);
    expect(result.spec.tasks[0].task_description).toBe('Write a function');
  });

  it('accepts per-task verification fields', () => {
    const yamlText = `
version: 1
name: per-task-verify
tasks:
  - node_id: docs
    task: Update docs
    verify_command: markdownlint docs/
  - node_id: skip
    task: Skip verify
    verify_skip: true
`;

    const result = parseSpecString(yamlText);

    expect(result.ok).toBe(true);
    expect(result.spec.tasks[0]).toMatchObject({
      node_id: 'docs',
      verify_command: 'markdownlint docs/',
    });
    expect(result.spec.tasks[1]).toMatchObject({
      node_id: 'skip',
      verify_skip: true,
    });
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

  it('accepts task with typed signature (input + output)', () => {
    const yamlText = `
version: 1
name: typed-workflow
tasks:
  - node_id: generate
    task: Generate report data
    signature:
      input:
        type: object
        required: [project_name]
        properties:
          project_name:
            type: string
          max_items:
            type: integer
      output:
        type: object
        required: [items]
        properties:
          items:
            type: array
            items:
              type: object
          summary:
            type: string
`;

    const result = parseSpecString(yamlText);

    expect(result.ok).toBe(true);
    expect(result.spec.tasks[0].signature).toEqual({
      input: {
        type: 'object',
        required: ['project_name'],
        properties: {
          project_name: { type: 'string' },
          max_items: { type: 'integer' },
        },
      },
      output: {
        type: 'object',
        required: ['items'],
        properties: {
          items: { type: 'array', items: { type: 'object' } },
          summary: { type: 'string' },
        },
      },
    });
  });

  it('accepts task with signature input only', () => {
    const yamlText = `
version: 1
name: input-only
tasks:
  - node_id: step
    task: Process input
    signature:
      input:
        type: object
        properties:
          path:
            type: string
`;

    const result = parseSpecString(yamlText);

    expect(result.ok).toBe(true);
    expect(result.spec.tasks[0].signature).toEqual({
      input: {
        type: 'object',
        properties: { path: { type: 'string' } },
      },
    });
    expect(result.spec.tasks[0].signature.output).toBeUndefined();
  });

  it('accepts task with signature output only', () => {
    const yamlText = `
version: 1
name: output-only
tasks:
  - node_id: step
    task: Produce output
    signature:
      output:
        type: object
        properties:
          result:
            type: boolean
`;

    const result = parseSpecString(yamlText);

    expect(result.ok).toBe(true);
    expect(result.spec.tasks[0].signature).toEqual({
      output: {
        type: 'object',
        properties: { result: { type: 'boolean' } },
      },
    });
    expect(result.spec.tasks[0].signature.input).toBeUndefined();
  });

  it('accepts task with empty signature object', () => {
    const yamlText = `
version: 1
name: empty-sig
tasks:
  - node_id: step
    task: No constraints
    signature: {}
`;

    const result = parseSpecString(yamlText);

    expect(result.ok).toBe(true);
    expect(result.spec.tasks[0].signature).toEqual({});
  });

  it('rejects signature with unknown keys', () => {
    const yamlText = `
version: 1
name: bad-sig
tasks:
  - node_id: step
    task: Bad signature
    signature:
      input:
        type: object
      unknown_key:
        type: string
`;

    const result = parseSpecString(yamlText);

    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/additional|unknown/i);
  });

  it('rejects non-object signature', () => {
    const yamlText = `
version: 1
name: bad-sig-type
tasks:
  - node_id: step
    task: Wrong type
    signature: just-a-string
`;

    const result = parseSpecString(yamlText);

    expect(result.ok).toBe(false);
  });

  it('preserves signature through task normalization', () => {
    const yamlText = `
version: 1
name: normalize-sig
tasks:
  - node_id: a
    task: Do work
    signature:
      input:
        type: object
        properties:
          file:
            type: string
      output:
        type: object
        properties:
          changed:
            type: boolean
`;

    const result = parseSpecString(yamlText);

    expect(result.ok).toBe(true);
    expect(result.spec.tasks[0].task_description).toBe('Do work');
    expect(result.spec.tasks[0].signature.input.properties.file).toEqual({ type: 'string' });
    expect(result.spec.tasks[0].signature.output.properties.changed).toEqual({ type: 'boolean' });
  });

  it('accepts crew tasks with router configuration', () => {
    const yamlText = `
version: 1
name: crew-workflow
tasks:
  - node_id: crew-plan
    kind: crew
    crew:
      objective: Coordinate a planner and critic
      roles:
        - name: planner
        - name: critic
      max_rounds: 8
      router:
        mode: hybrid
        code_fn: |
          if (turn.turn_count === 0) return ['planner'];
          return ['critic'];
        agent_model: gpt-5.3-codex-spark
`;

    const result = parseSpecString(yamlText);

    expect(result.ok).toBe(true);
    expect(result.spec.tasks).toEqual([
      {
        node_id: 'crew-plan',
        kind: 'crew',
        crew: {
          objective: 'Coordinate a planner and critic',
          roles: [{ name: 'planner' }, { name: 'critic' }],
          max_rounds: 8,
          router: {
            mode: 'hybrid',
            code_fn: "if (turn.turn_count === 0) return ['planner'];\nreturn ['critic'];\n",
            agent_model: 'gpt-5.3-codex-spark',
          },
        },
      },
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
