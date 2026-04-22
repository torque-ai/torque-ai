'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { discoverSpecs } = require('../workflow-spec/discover');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-discover-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('workflow-spec discoverSpecs', () => {
  it('returns empty array when workflows dir does not exist', () => {
    const result = discoverSpecs(tmpDir);

    expect(result).toEqual([]);
  });

  it('lists .yaml and .yml files in workflows/', () => {
    const workflowsDir = path.join(tmpDir, 'workflows');
    fs.mkdirSync(workflowsDir);
    fs.writeFileSync(path.join(workflowsDir, 'a.yaml'), 'version: 1\nname: a\ntasks:\n  - node_id: x\n    task: y\n');
    fs.writeFileSync(path.join(workflowsDir, 'b.yml'), 'version: 1\nname: b\ntasks:\n  - node_id: x\n    task: y\n');
    fs.writeFileSync(path.join(workflowsDir, 'readme.md'), 'not a workflow');

    const result = discoverSpecs(tmpDir);
    const names = result.map((spec) => spec.name).sort();

    expect(names).toEqual(['a', 'b']);
  });

  it('marks invalid specs as invalid with error messages', () => {
    const workflowsDir = path.join(tmpDir, 'workflows');
    fs.mkdirSync(workflowsDir);
    fs.writeFileSync(path.join(workflowsDir, 'bad.yaml'), 'not: valid\nmissing_tasks: true\n');

    const result = discoverSpecs(tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].valid).toBe(false);
    expect(result[0].errors.length).toBeGreaterThan(0);
  });

  it('returns forward-slash relative paths from the project root', () => {
    const workflowsDir = path.join(tmpDir, 'workflows');
    fs.mkdirSync(workflowsDir);
    fs.writeFileSync(path.join(workflowsDir, 'a.yaml'), 'version: 1\nname: a\ntasks:\n  - node_id: x\n    task: y\n');

    const result = discoverSpecs(tmpDir);

    expect(result[0].relative_path).toBe('workflows/a.yaml');
  });
});
