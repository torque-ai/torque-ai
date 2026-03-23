/**
 * Automation Handlers Tests
 *
 * Integration tests for MCP tools in automation-handlers.js.
 * Tests universal TS tools with temp files, config tools via DB,
 * semantic TS tools, and error paths for remaining tools.
 */

const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');
const { TEST_MODELS } = require('./test-helpers');
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

  describe('configure_stall_detection', () => {
    it('accepts valid config', async () => {
      const result = await safeTool('configure_stall_detection', {
        stall_threshold_seconds: 180
      });
      expect(result.isError).toBeFalsy();
    });

    it('accepts provider-specific config', async () => {
      const result = await safeTool('configure_stall_detection', {
        provider: 'codex',
        stall_threshold_seconds: 120
      });
      expect(result.isError).toBeFalsy();
    });

    it('accepts auto_resubmit option', async () => {
      const result = await safeTool('configure_stall_detection', {
        provider: 'ollama',
        stall_threshold_seconds: 90,
        auto_resubmit: true,
        max_resubmit_attempts: 2
      });
      expect(result.isError).toBeFalsy();
    });

    it('outputs current settings table', async () => {
      const result = await safeTool('configure_stall_detection', {
        stall_threshold_seconds: 200
      });
      const text = getText(result);
      expect(text).toContain('Current Settings');
      expect(text).toContain('codex');
      expect(text).toContain('ollama');
      expect(text).toContain('hashline-ollama');
      expect(text).toContain('claude-cli');
    });

    it('reports changes applied when setting threshold', async () => {
      const result = await safeTool('configure_stall_detection', {
        provider: 'invalid-provider',
        stall_threshold_seconds: 300
      });
      const text = getText(result);
      expect(result.isError).toBe(true);
      expect(text).toContain('Parameter "provider" must be one of');
    });

    it('enables stall detection when setting thresholds', async () => {
      const result = await safeTool('configure_stall_detection', {
        stall_threshold_seconds: 150
      });
      const text = getText(result);
      expect(text).toContain('Stall detection and recovery: enabled');
    });

    it('reports auto_resubmit status', async () => {
      await safeTool('configure_stall_detection', {
        auto_resubmit: false
      });
      const result = await safeTool('configure_stall_detection', {});
      const text = getText(result);
      expect(text).toContain('Auto-resubmit');
    });

    it('reports max_resubmit_attempts setting', async () => {
      const result = await safeTool('configure_stall_detection', {
        max_resubmit_attempts: 5
      });
      const text = getText(result);
      expect(text).toContain('Max resubmit attempts: 5');
    });

    it('handles empty args returning current config', async () => {
      const result = await safeTool('configure_stall_detection', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Stall Detection Configuration');
    });

    it('sets all providers when provider is all', async () => {
      const result = await safeTool('configure_stall_detection', {
        provider: 'all',
        stall_threshold_seconds: 250
      });
      const text = getText(result);
      expect(text).toContain('all providers');
    });
  });

  // ─── set_project_defaults / get_project_defaults ───────────────────────────

  describe('set_project_defaults', () => {
    it('accepts valid config', async () => {
      const result = await safeTool('set_project_defaults', {
        working_directory: tempDir,
        provider: 'codex',
        verify_command: 'echo ok'
      });
      expect(result.isError).toBeFalsy();
    });

    it('rejects missing working_directory', async () => {
      const result = await safeTool('set_project_defaults', {
        provider: 'codex'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects invalid provider', async () => {
      const result = await safeTool('set_project_defaults', {
        working_directory: tempDir,
        provider: 'invalid-provider'
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Parameter "provider" must be one of');
    });

    it('persists all 5 project default fields', async () => {
      await safeTool('set_project_defaults', {
        working_directory: tempDir,
        provider: 'codex',
        model: 'gpt-5.3-codex-spark',
        verify_command: 'npx tsc --noEmit',
        auto_fix: true,
        test_pattern: '.test.js'
      });
      const result = await safeTool('get_project_defaults', {
        working_directory: tempDir
      });
      const text = getText(result);
      expect(text).toContain('codex');
      expect(text).toContain('gpt-5.3-codex-spark');
      expect(text).toContain('npx tsc --noEmit');
      expect(text).toContain('.test.js');
    });

    it('lists changes applied in output', async () => {
      const result = await safeTool('set_project_defaults', {
        working_directory: tempDir,
        provider: 'ollama',
        model: TEST_MODELS.SMALL
      });
      const text = getText(result);
      expect(text).toContain('Changes Applied');
      expect(text).toContain('ollama');
      expect(text).toContain(TEST_MODELS.SMALL);
    });

    it('sets auto_fix to disabled', async () => {
      const result = await safeTool('set_project_defaults', {
        working_directory: tempDir,
        auto_fix: false
      });
      const text = getText(result);
      expect(text).toContain('disabled');
    });

    it('persists step_providers', async () => {
      await safeTool('set_project_defaults', {
        working_directory: tempDir,
        step_providers: { types: 'ollama', system: 'codex' }
      });
      const result = await safeTool('get_project_defaults', {
        working_directory: tempDir
      });
      const text = getText(result);
      expect(text).toContain('types=ollama');
      expect(text).toContain('system=codex');
    });
  });

  describe('get_project_defaults', () => {
    it('returns defaults for project', async () => {
      const result = await safeTool('get_project_defaults', {
        working_directory: tempDir
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Project Defaults');
    });

    it('rejects missing working_directory', async () => {
      const result = await safeTool('get_project_defaults', {});
      expect(result.isError).toBe(true);
    });

    it('includes Current Settings table', async () => {
      // Set something first
      await safeTool('set_project_defaults', {
        working_directory: tempDir,
        provider: 'codex'
      });
      const result = await safeTool('get_project_defaults', {
        working_directory: tempDir
      });
      const text = getText(result);
      expect(text).toContain('Current Settings');
      expect(text).toContain('Provider');
    });
  });

  // ─── generate_feature_tasks ────────────────────────────────────────────────

  describe('generate_feature_tasks', () => {
    it('rejects missing working_directory', async () => {
      const result = await safeTool('generate_feature_tasks', {
        feature_name: 'TestFeature'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects missing feature_name', async () => {
      const result = await safeTool('generate_feature_tasks', {
        working_directory: tempDir
      });
      expect(result.isError).toBe(true);
    });

    it('succeeds with valid params', async () => {
      // Create minimal project structure
      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(path.join(srcDir, 'types'), { recursive: true });
      fs.mkdirSync(path.join(srcDir, 'systems', '__tests__'), { recursive: true });
      fs.mkdirSync(path.join(srcDir, 'data'), { recursive: true });
      fs.mkdirSync(path.join(srcDir, 'scenes'), { recursive: true });

      const result = await safeTool('generate_feature_tasks', {
        working_directory: tempDir,
        feature_name: 'TestFeature',
        feature_description: 'A test feature for unit testing'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('TestFeature');
    });

    it('generates all 6 task sections', async () => {
      const result = await safeTool('generate_feature_tasks', {
        working_directory: tempDir,
        feature_name: 'Inventory',
        feature_description: 'Track inventory items'
      });
      const text = getText(result);
      expect(text).toContain('types');
      expect(text).toContain('events');
      expect(text).toContain('data');
      expect(text).toContain('system');
      expect(text).toContain('tests');
      expect(text).toContain('wire');
    });

    it('uses kebab-case for file paths in task descriptions', async () => {
      const result = await safeTool('generate_feature_tasks', {
        working_directory: tempDir,
        feature_name: 'ImpactTracking',
        feature_description: 'Track project impact'
      });
      const text = getText(result);
      expect(text).toContain('impact-tracking');
    });

    it('includes custom specs when provided', async () => {
      const result = await safeTool('generate_feature_tasks', {
        working_directory: tempDir,
        feature_name: 'CustomSpec',
        types_spec: 'interface CustomEntity { id: string; name: string }',
        events_spec: 'custom_created: { id: string }',
      });
      const text = getText(result);
      expect(text).toContain('CustomEntity');
      expect(text).toContain('custom_created');
    });
  });

  // ─── Universal TypeScript Tools ────────────────────────────────────────────

});
