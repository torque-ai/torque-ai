/**
 * Safeguards & Validation Tests
 *
 * Tests for validation rules, baselines, quality safeguards:
 * validate_task_output, capture_file_baselines, compare_file_baseline,
 * run_syntax_check, list_validation_rules, add_validation_rule.
 */

const { setupTestDb, teardownTestDb, safeTool } = require('./vitest-setup');
const { uniqueId, extractTaskId } = require('./test-helpers');
const path = require('path');
const os = require('os');
const fs = require('fs');

describe('Safeguards & Validation', () => {
  let testDir;

  beforeAll(() => {
    setupTestDb('safeguards');
    testDir = path.join(os.tmpdir(), `torque-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(path.join(testDir, 'sample.js'), 'function test() {\n  return 42;\n}\n');
    fs.writeFileSync(path.join(testDir, 'sample.cs'), 'public class Test {\n  public int GetValue() { return 42; }\n}\n');
    fs.writeFileSync(path.join(testDir, 'sample.ts'), 'function test(): number {\n  return 42;\n}\n');
    fs.writeFileSync(path.join(testDir, 'sample.py'), 'def test():\n    return 42\n');
  });

  afterAll(() => {
    teardownTestDb();
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('validate_task_output', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('validate_task_output', {});
      expect(result.isError).toBe(true);
    });

    it('rejects nonexistent task_id', async () => {
      const result = await safeTool('validate_task_output', {
        task_id: 'nonexistent_task_12345_xyz'
      });
      expect(result.isError).toBe(true);
    });

    it('succeeds with valid task_id', async () => {
      const queueResult = await safeTool('queue_task', {
        task: 'Test task for validation - should exist and be checkable'
      });
      expect(queueResult.isError).toBeFalsy();
      const taskId = extractTaskId(queueResult);
      expect(taskId).not.toBeNull();

      const result = await safeTool('validate_task_output', { task_id: taskId });
      expect(result.isError).toBeFalsy();
    });
  });

  describe('capture_file_baselines', () => {
    it('rejects missing working_directory', async () => {
      const result = await safeTool('capture_file_baselines', {});
      expect(result.isError).toBe(true);
    });

    it('succeeds with valid directory', async () => {
      const result = await safeTool('capture_file_baselines', {
        working_directory: testDir
      });
      expect(result.isError).toBeFalsy();
      expect(result.content).toBeDefined();
      expect(result.content.length).toBeGreaterThan(0);
    });

    it('accepts custom extensions', async () => {
      const result = await safeTool('capture_file_baselines', {
        working_directory: testDir,
        extensions: ['.js', '.cs']
      });
      expect(result.isError).toBeFalsy();
    });

    it('handles nonexistent directory gracefully', async () => {
      const result = await safeTool('capture_file_baselines', {
        working_directory: '/nonexistent/path/to/directory/12345'
      });
      expect(result).toBeDefined();
    });
  });

  describe('compare_file_baseline', () => {
    it('rejects missing file_path', async () => {
      const result = await safeTool('compare_file_baseline', {
        working_directory: testDir
      });
      expect(result.isError).toBe(true);
    });

    it('rejects missing working_directory', async () => {
      const result = await safeTool('compare_file_baseline', {
        file_path: path.join(testDir, 'sample.js')
      });
      expect(result.isError).toBe(true);
    });

    it('handles missing baseline gracefully', async () => {
      const result = await safeTool('compare_file_baseline', {
        file_path: path.join(testDir, 'sample.py'),
        working_directory: testDir
      });
      expect(result).toBeDefined();
    });

    it('succeeds with captured baseline and modified file', async () => {
      await safeTool('capture_file_baselines', {
        working_directory: testDir,
        extensions: ['.js', '.cs', '.ts']
      });

      const sampleJsPath = path.join(testDir, 'sample.js');
      fs.writeFileSync(sampleJsPath, 'function test() {\n  return 100;\n}\n');

      const result = await safeTool('compare_file_baseline', {
        file_path: sampleJsPath,
        working_directory: testDir
      });
      expect(result.isError).toBeFalsy();
    });
  });

  describe('run_syntax_check', () => {
    it('rejects missing file_path', async () => {
      const result = await safeTool('run_syntax_check', {
        working_directory: testDir
      });
      expect(result.isError).toBe(true);
    });

    it('rejects missing working_directory', async () => {
      const result = await safeTool('run_syntax_check', {
        file_path: path.join(testDir, 'sample.js')
      });
      expect(result.isError).toBe(true);
    });

    it('succeeds for valid JavaScript', async () => {
      const result = await safeTool('run_syntax_check', {
        file_path: path.join(testDir, 'sample.js'),
        working_directory: testDir
      });
      expect(result.isError).toBeFalsy();
    });

    it('succeeds for valid Python', async () => {
      const result = await safeTool('run_syntax_check', {
        file_path: path.join(testDir, 'sample.py'),
        working_directory: testDir
      });
      expect(result.isError).toBeFalsy();
    });

    it('succeeds for valid C#', async () => {
      const result = await safeTool('run_syntax_check', {
        file_path: path.join(testDir, 'sample.cs'),
        working_directory: testDir
      });
      expect(result.isError).toBeFalsy();
    });

    it('handles syntax errors gracefully', async () => {
      const badPath = path.join(testDir, 'bad.js');
      fs.writeFileSync(badPath, 'function test() {\n  return 42 // missing brace\n');
      const result = await safeTool('run_syntax_check', {
        file_path: badPath,
        working_directory: testDir
      });
      expect(result).toBeDefined();
    });
  });

  describe('list_validation_rules', () => {
    it('succeeds with no args', async () => {
      const result = await safeTool('list_validation_rules', {});
      expect(result.isError).toBeFalsy();
      expect(result.content).toBeDefined();
      expect(result.content.length).toBeGreaterThan(0);
    });

    it('accepts enabled_only filter', async () => {
      const result = await safeTool('list_validation_rules', { enabled_only: true });
      expect(result.isError).toBeFalsy();
    });

    it('accepts severity filter', async () => {
      const result = await safeTool('list_validation_rules', { severity: 'error' });
      expect(result.isError).toBeFalsy();
    });
  });

  describe('add_validation_rule', () => {
    it('succeeds with valid fields', async () => {
      const result = await safeTool('add_validation_rule', {
        name: uniqueId('rule'),
        description: 'Test validation rule for unit testing',
        rule_type: 'pattern',
        pattern: '\\bTODO\\b',
        severity: 'warning'
      });
      expect(result.isError).toBeFalsy();
    });

    it('rejects missing name', async () => {
      const result = await safeTool('add_validation_rule', {
        description: 'Test rule',
        rule_type: 'pattern',
        pattern: 'test',
        severity: 'warning'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects missing description', async () => {
      const result = await safeTool('add_validation_rule', {
        name: uniqueId('rule'),
        rule_type: 'pattern',
        pattern: 'test',
        severity: 'warning'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects missing rule_type', async () => {
      const result = await safeTool('add_validation_rule', {
        name: uniqueId('rule'),
        description: 'Test rule',
        pattern: 'test',
        severity: 'warning'
      });
      expect(result.isError).toBe(true);
    });

    it('handles unknown severity', async () => {
      const result = await safeTool('add_validation_rule', {
        name: uniqueId('rule'),
        description: 'Test rule',
        rule_type: 'pattern',
        pattern: 'test',
        severity: 'not-a-severity'
      });
      expect(result.isError).toBeFalsy();
    });

    it('accepts size rule type', async () => {
      const result = await safeTool('add_validation_rule', {
        name: uniqueId('rule'),
        description: 'Test size rule',
        rule_type: 'size',
        condition: JSON.stringify({ min_size: 100, extensions: ['.cs'] }),
        severity: 'error'
      });
      expect(result.isError).toBeFalsy();
    });

    it('accepts delta rule type', async () => {
      const result = await safeTool('add_validation_rule', {
        name: uniqueId('rule'),
        description: 'Test delta rule',
        rule_type: 'delta',
        condition: JSON.stringify({ max_decrease_percent: 50 }),
        severity: 'warning'
      });
      expect(result.isError).toBeFalsy();
    });

    it('accepts auto_fail flag', async () => {
      const result = await safeTool('add_validation_rule', {
        name: uniqueId('rule'),
        description: 'Test auto-fail rule',
        rule_type: 'pattern',
        pattern: '\\bbug\\b',
        severity: 'critical',
        auto_fail: true
      });
      expect(result.isError).toBeFalsy();
    });
  });
});
