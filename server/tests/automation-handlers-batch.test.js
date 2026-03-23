/**
 * Automation Handlers Tests
 *
 * Integration tests for MCP tools in automation-handlers.js.
 * Tests universal TS tools with temp files, config tools via DB,
 * semantic TS tools, and error paths for remaining tools.
 */

const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');
const path = require('path');
const os = require('os');
const fs = require('fs');

describe('Automation Handlers', () => {
  let tempDir;

  beforeAll(() => {
    setupTestDb('automation');
    tempDir = path.join(os.tmpdir(), `torque-auto-test-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterAll(() => {
    teardownTestDb();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ─── configure_stall_detection ─────────────────────────────────────────────

  describe('auto_verify_and_fix', () => {
    it('rejects missing working_directory', async () => {
      const result = await safeTool('auto_verify_and_fix', {});
      expect(result.isError).toBe(true);
    });

    it('passes when verify command succeeds', async () => {
      const result = await safeTool('auto_verify_and_fix', {
        working_directory: tempDir,
        verify_command: 'echo ok',
        auto_fix: false
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('PASSED');
    });

    it('reports failures when verify command fails', async () => {
      const result = await safeTool('auto_verify_and_fix', {
        working_directory: tempDir,
        verify_command: 'exit 1',
        auto_fix: false
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('FAILED');
    });

    it('includes working directory in output', async () => {
      const result = await safeTool('auto_verify_and_fix', {
        working_directory: tempDir,
        verify_command: 'echo ok'
      });
      const text = getText(result);
      expect(text).toContain('Working directory');
      expect(text).toContain(tempDir.replace(/\\/g, '\\'));
    });

    it('includes verify command in output', async () => {
      const result = await safeTool('auto_verify_and_fix', {
        working_directory: tempDir,
        verify_command: 'echo custom-check'
      });
      const text = getText(result);
      expect(text).toContain('custom-check');
    });
  });

  describe('generate_test_tasks', () => {
    it('rejects missing working_directory', async () => {
      const result = await safeTool('generate_test_tasks', {});
      expect(result.isError).toBe(true);
    });

    it('succeeds with valid directory', async () => {
      const result = await safeTool('generate_test_tasks', {
        working_directory: tempDir,
        count: 2
      });
      expect(result.isError).toBeFalsy();
    });

    it('includes test gap analysis header', async () => {
      const result = await safeTool('generate_test_tasks', {
        working_directory: tempDir,
        count: 1
      });
      const text = getText(result);
      expect(text).toContain('Test Gap Analysis');
    });

    it('reports source and test file counts', async () => {
      const result = await safeTool('generate_test_tasks', {
        working_directory: tempDir,
        count: 1
      });
      const text = getText(result);
      expect(text).toContain('Source files');
      expect(text).toContain('Test files');
      expect(text).toContain('Coverage');
    });

    it('respects count parameter', async () => {
      // Create some source files in a scan-friendly dir
      const scanDir = path.join(tempDir, 'scan-src');
      fs.mkdirSync(scanDir, { recursive: true });
      for (let i = 0; i < 5; i++) {
        const content = Array.from({ length: 30 }, (_, j) => `// line ${j}`).join('\n');
        fs.writeFileSync(path.join(scanDir, `module${i}.ts`), content);
      }
      const result = await safeTool('generate_test_tasks', {
        working_directory: tempDir,
        source_dirs: ['scan-src'],
        count: 2
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      // Should show Top 2 or fewer
      expect(text).toContain('Top');
    });

    it('excludes files matching exclude_patterns', async () => {
      const scanDir2 = path.join(tempDir, 'scan-src2');
      fs.mkdirSync(scanDir2, { recursive: true });
      const bigContent = Array.from({ length: 50 }, (_, j) => `// line ${j}`).join('\n');
      fs.writeFileSync(path.join(scanDir2, 'main.ts'), bigContent);
      fs.writeFileSync(path.join(scanDir2, 'helper.ts'), bigContent);

      const result = await safeTool('generate_test_tasks', {
        working_directory: tempDir,
        source_dirs: ['scan-src2'],
        exclude_patterns: ['main.ts'],
        count: 5
      });
      const text = getText(result);
      expect(text).not.toContain('main.ts');
    });
  });

  describe('get_batch_summary', () => {
    it('rejects missing workflow_id', async () => {
      const result = await safeTool('get_batch_summary', {});
      expect(result.isError).toBe(true);
    });

    it('rejects non-existent workflow', async () => {
      const result = await safeTool('get_batch_summary', {
        workflow_id: 'nonexistent-id-12345'
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('not found');
    });
  });


  describe('detect_file_conflicts', () => {
    it('rejects missing workflow_id', async () => {
      const result = await safeTool('detect_file_conflicts', {});
      expect(result.isError).toBe(true);
    });

    it('rejects non-existent workflow', async () => {
      const result = await safeTool('detect_file_conflicts', {
        workflow_id: 'nonexistent-id-67890'
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('not found');
    });
  });

  describe('auto_commit_batch', () => {
    it('rejects missing working_directory', async () => {
      const result = await safeTool('auto_commit_batch', {});
      expect(result.isError).toBe(true);
    });
  });




  describe('run_batch', () => {
    it('rejects missing working_directory', async () => {
      const result = await safeTool('run_batch', {
        feature_name: 'Test'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects missing feature_name', async () => {
      const result = await safeTool('run_batch', {
        working_directory: tempDir
      });
      expect(result.isError).toBe(true);
    });
  });

});
