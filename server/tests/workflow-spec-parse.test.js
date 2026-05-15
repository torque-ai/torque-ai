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

  it('accepts signature with deeply nested JSON Schema types', () => {
    const yamlText = `
version: 1
name: deep-sig
tasks:
  - node_id: deep
    task: Deep nesting
    signature:
      input:
        type: object
        required: [records]
        properties:
          records:
            type: array
            items:
              type: object
              properties:
                id:
                  type: integer
                tags:
                  type: array
                  items:
                    type: string
      output:
        type: object
        properties:
          stats:
            type: object
            properties:
              count:
                type: integer
              categories:
                type: array
                items:
                  type: string
`;

    const result = parseSpecString(yamlText);

    expect(result.ok).toBe(true);
    const sig = result.spec.tasks[0].signature;
    expect(sig.input.required).toEqual(['records']);
    expect(sig.input.properties.records).toEqual({
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
    });
    expect(sig.output.properties.stats.properties.count).toEqual({ type: 'integer' });
    expect(sig.output.properties.stats.properties.categories).toEqual({
      type: 'array',
      items: { type: 'string' },
    });
  });

  it('accepts mixed tasks where some have signatures and some do not', () => {
    const yamlText = `
version: 1
name: mixed-sig
tasks:
  - node_id: unsigned
    task: No signature here
  - node_id: signed
    task: Has a signature
    signature:
      input:
        type: object
        properties:
          name:
            type: string
  - node_id: also-unsigned
    task: Also no signature
`;

    const result = parseSpecString(yamlText);

    expect(result.ok).toBe(true);
    expect(result.spec.tasks).toHaveLength(3);
    expect(result.spec.tasks[0].signature).toBeUndefined();
    expect(result.spec.tasks[1].signature).toEqual({
      input: {
        type: 'object',
        properties: { name: { type: 'string' } },
      },
    });
    expect(result.spec.tasks[2].signature).toBeUndefined();
  });

  it('accepts signature alongside other task fields', () => {
    const yamlText = `
version: 1
name: sig-with-extras
tasks:
  - node_id: first
    task: Setup
  - node_id: second
    task: Process
    depends_on: [first]
    provider: codex
    tags: [data, processing]
    verify_command: npm test
    timeout_minutes: 30
    signature:
      input:
        type: object
        properties:
          source:
            type: string
      output:
        type: object
        properties:
          processed:
            type: boolean
`;

    const result = parseSpecString(yamlText);

    expect(result.ok).toBe(true);
    const task = result.spec.tasks[1];
    expect(task.node_id).toBe('second');
    expect(task.depends_on).toEqual(['first']);
    expect(task.provider).toBe('codex');
    expect(task.tags).toEqual(['data', 'processing']);
    expect(task.verify_command).toBe('npm test');
    expect(task.timeout_minutes).toBe(30);
    expect(task.signature.input.properties.source).toEqual({ type: 'string' });
    expect(task.signature.output.properties.processed).toEqual({ type: 'boolean' });
  });

  it('rejects signature as an array', () => {
    const yamlText = `
version: 1
name: sig-array
tasks:
  - node_id: step
    task: Bad type
    signature:
      - input
      - output
`;

    const result = parseSpecString(yamlText);

    expect(result.ok).toBe(false);
  });

  it('rejects signature as null', () => {
    const yamlText = `
version: 1
name: sig-null
tasks:
  - node_id: step
    task: Null sig
    signature: null
`;

    const result = parseSpecString(yamlText);

    expect(result.ok).toBe(false);
  });

  it('rejects signature as a number', () => {
    const yamlText = `
version: 1
name: sig-num
tasks:
  - node_id: step
    task: Numeric sig
    signature: 42
`;

    const result = parseSpecString(yamlText);

    expect(result.ok).toBe(false);
  });

  it('accepts signature with input/output that use additional JSON Schema keywords', () => {
    const yamlText = `
version: 1
name: extra-keywords
tasks:
  - node_id: step
    task: Schema keywords
    signature:
      input:
        type: object
        properties:
          count:
            type: integer
            minimum: 0
            maximum: 100
          label:
            type: string
            minLength: 1
            maxLength: 50
          mode:
            type: string
            enum: [fast, slow, balanced]
`;

    const result = parseSpecString(yamlText);

    expect(result.ok).toBe(true);
    const inp = result.spec.tasks[0].signature.input;
    expect(inp.properties.count).toEqual({ type: 'integer', minimum: 0, maximum: 100 });
    expect(inp.properties.label).toEqual({ type: 'string', minLength: 1, maxLength: 50 });
    expect(inp.properties.mode).toEqual({ type: 'string', enum: ['fast', 'slow', 'balanced'] });
  });

  it('accepts multiple tasks each with their own signatures', () => {
    const yamlText = `
version: 1
name: multi-sig
tasks:
  - node_id: fetch
    task: Fetch data
    signature:
      output:
        type: object
        properties:
          data:
            type: array
  - node_id: transform
    task: Transform data
    depends_on: [fetch]
    signature:
      input:
        type: object
        properties:
          data:
            type: array
      output:
        type: object
        properties:
          result:
            type: object
  - node_id: report
    task: Generate report
    depends_on: [transform]
    signature:
      input:
        type: object
        required: [result]
        properties:
          result:
            type: object
`;

    const result = parseSpecString(yamlText);

    expect(result.ok).toBe(true);
    expect(result.spec.tasks).toHaveLength(3);
    expect(result.spec.tasks[0].signature.output.properties.data).toEqual({ type: 'array' });
    expect(result.spec.tasks[1].signature.input.properties.data).toEqual({ type: 'array' });
    expect(result.spec.tasks[1].signature.output.properties.result).toEqual({ type: 'object' });
    expect(result.spec.tasks[2].signature.input.required).toEqual(['result']);
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
