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

  describe('cache_feature_gaps', () => {
    it('rejects missing paths', async () => {
      const result = await safeTool('cache_feature_gaps', {});
      expect(result.isError).toBe(true);
    });

    it('rejects when only one path provided', async () => {
      const result = await safeTool('cache_feature_gaps', {
        headwaters_path: tempDir
      });
      expect(result.isError).toBe(true);
    });

    it('scans directories when both paths provided', async () => {
      // Create minimal structure
      const hwDir = path.join(tempDir, 'headwaters');
      const dlDir = path.join(tempDir, 'deluge');
      fs.mkdirSync(path.join(hwDir, 'src', 'systems'), { recursive: true });
      fs.mkdirSync(path.join(dlDir, 'src', 'lib'), { recursive: true });
      fs.mkdirSync(path.join(dlDir, 'docs', 'plans'), { recursive: true });

      // Create a system file
      fs.writeFileSync(path.join(hwDir, 'src', 'systems', 'InventorySystem.ts'), 'export class InventorySystem {}');

      // Create a deluge plan
      fs.writeFileSync(path.join(dlDir, 'docs', 'plans', 'plan-01-inventory.md'), '# Plan 1: Inventory');

      const result = await safeTool('cache_feature_gaps', {
        headwaters_path: hwDir,
        deluge_path: dlDir
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Feature Gap Analysis');
      expect(text).toContain('Headwaters systems');
    });

    it('returns cached results on second call', async () => {
      const hwDir = path.join(tempDir, 'headwaters');
      const dlDir = path.join(tempDir, 'deluge');

      // First call (may reuse from previous test)
      await safeTool('cache_feature_gaps', {
        headwaters_path: hwDir,
        deluge_path: dlDir
      });

      // Second call should use cache
      const result = await safeTool('cache_feature_gaps', {
        headwaters_path: hwDir,
        deluge_path: dlDir
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Feature Gap Analysis');
    });

    it('refreshes cache when force_refresh is true', async () => {
      const hwDir = path.join(tempDir, 'headwaters');
      const dlDir = path.join(tempDir, 'deluge');

      const result = await safeTool('cache_feature_gaps', {
        headwaters_path: hwDir,
        deluge_path: dlDir,
        force_refresh: true
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('fresh scan');
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

  describe('plan_next_batch', () => {
    it('rejects missing paths', async () => {
      const result = await safeTool('plan_next_batch', {});
      expect(result.isError).toBe(true);
    });

    it('returns recommendations when deluge_path has plans', async () => {
      const hwDir = path.join(tempDir, 'headwaters');
      const dlDir = path.join(tempDir, 'deluge');
      // Ensure structures exist (may be leftover from cache_feature_gaps tests)
      fs.mkdirSync(path.join(hwDir, 'src', 'systems'), { recursive: true });
      fs.mkdirSync(path.join(dlDir, 'docs', 'plans'), { recursive: true });

      // Create plan with prisma + phases
      fs.writeFileSync(path.join(dlDir, 'docs', 'plans', 'plan-42-scoring.md'), `# Plan 42: Scoring

## Overview

A scoring feature for community impact.

## Phase 1

Initial setup.

\`\`\`prisma
model Score {
  id     String @id
  userId String
  amount Float
  type   String // basic, advanced
}
\`\`\`

## Phase 2

Advanced scoring with drops and ripples and community integration.
`);

      const result = await safeTool('plan_next_batch', {
        headwaters_path: hwDir,
        deluge_path: dlDir,
        count: 1
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Next Batch Recommendations');
    });
  });

  describe('update_project_stats', () => {
    it('rejects missing working_directory', async () => {
      const result = await safeTool('update_project_stats', {
        memory_path: path.join(tempDir, 'MEMORY.md')
      });
      expect(result.isError).toBe(true);
    });

    it('rejects missing memory_path', async () => {
      const result = await safeTool('update_project_stats', {
        working_directory: tempDir
      });
      expect(result.isError).toBe(true);
    });

    it('reports stats even if memory file does not exist', async () => {
      const result = await safeTool('update_project_stats', {
        working_directory: tempDir,
        memory_path: path.join(tempDir, 'nonexistent-MEMORY.md'),
        test_command: 'echo "1 passed"'
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Update Project Stats');
      expect(text).toContain('Memory file not found');
    });

    it('updates memory file when pattern matches', async () => {
      const memPath = path.join(tempDir, 'test-MEMORY.md');
      fs.writeFileSync(memPath, 'Test coverage is currently **0/0 source files (0%)**, 0 tests passing\n');

      const result = await safeTool('update_project_stats', {
        working_directory: tempDir,
        memory_path: memPath,
        test_command: 'echo "5 passed"'
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Update Project Stats');
    });

    it('reports coverage percent', async () => {
      const memPath = path.join(tempDir, 'test-MEMORY2.md');
      fs.writeFileSync(memPath, 'some content');

      const result = await safeTool('update_project_stats', {
        working_directory: tempDir,
        memory_path: memPath,
        test_command: 'echo "10 passed"'
      });
      const text = getText(result);
      expect(text).toContain('Coverage');
    });
  });

  describe('validate_event_consistency', () => {
    beforeAll(() => {
      // Create shared event system structure for all tests in this describe block
      const eventDir = path.join(tempDir, 'event-project', 'src', 'systems');
      fs.mkdirSync(eventDir, { recursive: true });

      fs.writeFileSync(path.join(eventDir, 'EventSystem.ts'), `
export interface GameEvents {
  item_created: { id: string };
  item_deleted: { id: string };
}

class EventSystem {
  emit(event: string, data: any) {}
}
`);

      // Source file that emits events
      fs.writeFileSync(path.join(eventDir, 'ItemSystem.ts'), `
import { EventSystem } from './EventSystem';

export class ItemSystem {
  create() {
    EventSystem.instance.emit("item_created", { id: "1" });
  }
  delete() {
    EventSystem.instance.emit("item_deleted", { id: "1" });
  }
  unknown() {
    EventSystem.instance.emit("unregistered_event", { id: "1" });
  }
}
`);
    });

    it('rejects missing working_directory', async () => {
      const result = await safeTool('validate_event_consistency', {});
      expect(result.isError).toBe(true);
    });

    it('runs analysis on valid directory', async () => {
      const eventDir = path.join(tempDir, 'event-project', 'src', 'systems');

      const result = await safeTool('validate_event_consistency', {
        working_directory: path.join(tempDir, 'event-project'),
        event_system_path: path.join(eventDir, 'EventSystem.ts'),
        source_dir: eventDir
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Event Consistency Validation');
      expect(text).toContain('Declared events');
    });

    it('detects unregistered emitted events', async () => {
      const eventDir = path.join(tempDir, 'event-project', 'src', 'systems');

      const result = await safeTool('validate_event_consistency', {
        working_directory: path.join(tempDir, 'event-project'),
        event_system_path: path.join(eventDir, 'EventSystem.ts'),
        source_dir: eventDir
      });
      const text = getText(result);
      expect(text).toContain('unregistered_event');
    });

    it('reports summary counts', async () => {
      const eventDir = path.join(tempDir, 'event-project', 'src', 'systems');

      const result = await safeTool('validate_event_consistency', {
        working_directory: path.join(tempDir, 'event-project'),
        event_system_path: path.join(eventDir, 'EventSystem.ts'),
        source_dir: eventDir
      });
      const text = getText(result);
      expect(text).toContain('Summary');
    });
  });

  describe('audit_class_completeness', () => {
    it('rejects missing working_directory', async () => {
      const result = await safeTool('audit_class_completeness', {});
      expect(result.isError).toBe(true);
    });

    it('audits systems dir against target class file', async () => {
      const auditDir = path.join(tempDir, 'audit-project');
      const sysDir = path.join(auditDir, 'src', 'systems');
      const sceneDir = path.join(auditDir, 'src', 'scenes');
      fs.mkdirSync(sysDir, { recursive: true });
      fs.mkdirSync(sceneDir, { recursive: true });

      // Create system files
      fs.writeFileSync(path.join(sysDir, 'FooSystem.ts'), 'export class FooSystem {}');
      fs.writeFileSync(path.join(sysDir, 'BarSystem.ts'), 'export class BarSystem {}');

      // Create target class that imports only FooSystem
      fs.writeFileSync(path.join(sceneDir, 'GameScene.ts'), `import { FooSystem } from "../systems/FooSystem";

export class GameScene {
  private fooSystem!: FooSystem;

  constructor() {
    this.fooSystem = new FooSystem();
  }

  public getFooSystem(): FooSystem {
    return this.fooSystem;
  }
}
`);

      const result = await safeTool('audit_class_completeness', {
        working_directory: auditDir,
        systems_dir: sysDir,
        target_file: path.join(sceneDir, 'GameScene.ts'),
        exclude_files: []
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Audit');
      expect(text).toContain('BarSystem');
    });

    it('reports fully wired systems', async () => {
      const auditDir = path.join(tempDir, 'audit-project');
      const sysDir = path.join(auditDir, 'src', 'systems');
      const sceneDir = path.join(auditDir, 'src', 'scenes');

      const result = await safeTool('audit_class_completeness', {
        working_directory: auditDir,
        systems_dir: sysDir,
        target_file: path.join(sceneDir, 'GameScene.ts'),
        exclude_files: []
      });
      const text = getText(result);
      expect(text).toContain('Fully wired');
    });

    it('reports missing imports', async () => {
      const auditDir = path.join(tempDir, 'audit-project');
      const sysDir = path.join(auditDir, 'src', 'systems');
      const sceneDir = path.join(auditDir, 'src', 'scenes');

      const result = await safeTool('audit_class_completeness', {
        working_directory: auditDir,
        systems_dir: sysDir,
        target_file: path.join(sceneDir, 'GameScene.ts'),
        exclude_files: []
      });
      const text = getText(result);
      expect(text).toContain('Missing imports');
      expect(text).toContain('BarSystem');
    });

    it('rejects when systems dir not found', async () => {
      const result = await safeTool('audit_class_completeness', {
        working_directory: tempDir,
        systems_dir: path.join(tempDir, 'nonexistent-systems'),
        target_file: path.join(tempDir, 'nope.ts')
      });
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

  describe('run_full_batch', () => {
    it('rejects missing working_directory', async () => {
      const result = await safeTool('run_full_batch', {});
      expect(result.isError).toBe(true);
    });

    it('fails gracefully when no feature_name can be determined', async () => {
      const result = await safeTool('run_full_batch', {
        working_directory: tempDir
      });
      // Should fail because neither feature_name nor deluge_path provided
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Could not determine feature name');
    });
  });

  // ─── Headwaters Convenience Wrappers (validation) ──────────────────────────

  describe('wire_system_to_gamescene', () => {
    it('rejects missing params', async () => {
      const result = await safeTool('wire_system_to_gamescene', {});
      expect(result.isError).toBe(true);
    });

    it('rejects when only working_directory provided', async () => {
      const result = await safeTool('wire_system_to_gamescene', {
        working_directory: tempDir
      });
      expect(result.isError).toBe(true);
    });

    it('wires system into target file with custom file_path', async () => {
      const targetFile = path.join(tempDir, 'wire-target.ts');
      fs.writeFileSync(targetFile, `import { ServiceA } from "../systems/ServiceA";

export class GameScene {
  private serviceA!: ServiceA;

  constructor() {
    this.serviceA = new ServiceA();
  }

  private generateLoanRequestForRandomResident() {}
}
`);

      const result = await safeTool('wire_system_to_gamescene', {
        working_directory: tempDir,
        system_name: 'TestSystem',
        file_path: targetFile,
        import_path: '../systems/TestSystem'
      });
      expect(result.isError).toBeFalsy();
      const content = fs.readFileSync(targetFile, 'utf8');
      expect(content).toContain('TestSystem');
    });
  });

  describe('wire_events_to_eventsystem', () => {
    it('rejects missing params', async () => {
      const result = await safeTool('wire_events_to_eventsystem', {});
      expect(result.isError).toBe(true);
    });

    it('rejects when events array is empty', async () => {
      const result = await safeTool('wire_events_to_eventsystem', {
        working_directory: tempDir,
        events: []
      });
      expect(result.isError).toBe(true);
    });

    it('wires events with custom file_path', async () => {
      const esFile = path.join(tempDir, 'TestEventSystem.ts');
      fs.writeFileSync(esFile, `export interface GameEvents {
  existing_event: { id: string };
}
`);

      const result = await safeTool('wire_events_to_eventsystem', {
        working_directory: tempDir,
        file_path: esFile,
        interface_name: 'GameEvents',
        events: [
          { name: 'test_event', payload: { id: 'string', value: 'number' } }
        ]
      });
      expect(result.isError).toBeFalsy();
      const content = fs.readFileSync(esFile, 'utf8');
      expect(content).toContain('test_event');
    });
  });

  describe('wire_notifications_to_bridge', () => {
    it('rejects missing params', async () => {
      const result = await safeTool('wire_notifications_to_bridge', {});
      expect(result.isError).toBe(true);
    });

    it('generates correct template literals from {x} syntax', async () => {
      const bridgePath = path.join(tempDir, 'TestBridge.ts');
      fs.writeFileSync(bridgePath, [
        'export type TestEvent =',
        '  | "existing_event";',
        '',
        'export class TestBridge {',
        '  private toastManager = { show: (msg: string, opts: any) => {} };',
        '  private bind(event: string, cb: Function) {}',
        '  connect() {',
        '    this.connected = true;',
        '  }',
        '}',
      ].join('\n'));

      const result = await safeTool('wire_notifications_to_bridge', {
        working_directory: tempDir,
        file_path: bridgePath,
        union_type_name: 'TestEvent',
        bind_marker: 'this.connected = true;',
        notifications: [
          {
            event_name: 'score_changed',
            toast_template: 'Score: {oldScore} to {newScore}',
            color: '#4A90D9',
            condition: 'newScore > oldScore',
            else_template: 'Score dropped: {oldScore} to {newScore}',
            else_color: '#D94A4A',
          },
          {
            event_name: 'tier_up',
            toast_template: 'Upgraded to {newTier}!',
            color: '#4AD94A',
          },
          {
            event_name: 'simple_event',
            toast_template: 'Something happened',
            color: '#FFFFFF',
          },
        ],
      });
      expect(result.isError).toBeFalsy();

      const content = fs.readFileSync(bridgePath, 'utf-8');
      // Should destructure callback params for conditional events
      expect(content).toContain('oldScore');
      expect(content).toContain('newScore');
      // else_template uses ${x} interpolation
      expect(content).toContain('${oldScore}');
      expect(content).toContain('${newScore}');
      // tier_up and score_changed main templates use {x} syntax in template literals
      expect(content).toContain('{newTier}');
      expect(content).toContain('newTier');
      // Should NOT have empty destructuring
      expect(content).not.toMatch(/\(\{\s*\}\)/);
      // Simple event with no fields should use () => not ({}) =>
      expect(content).toMatch(/bind\("simple_event", \(\) =>/);
    });

    it('does not accumulate extra blank lines on successive calls', async () => {
      const bridgePath2 = path.join(tempDir, 'TestBridge2.ts');
      fs.writeFileSync(bridgePath2, [
        'export type TestEvent2 =',
        '  | "existing";',
        '',
        'export class TestBridge2 {',
        '  private toastManager = { show: (msg: string, opts: any) => {} };',
        '  private bind(event: string, cb: Function) {}',
        '  connect() {',
        '    this.connected = true;',
        '  }',
        '}',
      ].join('\n'));

      // First call
      await safeTool('wire_notifications_to_bridge', {
        working_directory: tempDir,
        file_path: bridgePath2,
        union_type_name: 'TestEvent2',
        bind_marker: 'this.connected = true;',
        notifications: [{ event_name: 'event_a', toast_template: 'A happened', color: '#AAA' }],
      });

      // Second call
      const result = await safeTool('wire_notifications_to_bridge', {
        working_directory: tempDir,
        file_path: bridgePath2,
        union_type_name: 'TestEvent2',
        bind_marker: 'this.connected = true;',
        notifications: [{ event_name: 'event_b', toast_template: 'B happened', color: '#BBB' }],
      });
      expect(result.isError).toBeFalsy();

      const content = fs.readFileSync(bridgePath2, 'utf-8');
      // No triple+ newlines (would indicate whitespace accumulation)
      expect(content).not.toMatch(/\n{4,}/);
      // Both events should be present
      expect(content).toContain('event_a');
      expect(content).toContain('event_b');
    });

    it('rejects when bridge file not found', async () => {
      const result = await safeTool('wire_notifications_to_bridge', {
        working_directory: tempDir,
        file_path: path.join(tempDir, 'nonexistent-bridge.ts'),
        union_type_name: 'TestEvent',
        bind_marker: 'marker',
        notifications: [{ event_name: 'e', toast_template: 't', color: '#000' }]
      });
      expect(result.isError).toBe(true);
    });

    it('reports wired notification count in output', async () => {
      const bridgePath3 = path.join(tempDir, 'TestBridge3.ts');
      fs.writeFileSync(bridgePath3, [
        'export type TestEvent3 =',
        '  | "existing3";',
        '',
        'export class TestBridge3 {',
        '  private toastManager = { show: (msg: string, opts: any) => {} };',
        '  private bind(event: string, cb: Function) {}',
        '  connect() {',
        '    this.connected = true;',
        '  }',
        '}',
      ].join('\n'));

      const result = await safeTool('wire_notifications_to_bridge', {
        working_directory: tempDir,
        file_path: bridgePath3,
        union_type_name: 'TestEvent3',
        bind_marker: 'this.connected = true;',
        notifications: [
          { event_name: 'evt_x', toast_template: 'X', color: '#111' },
          { event_name: 'evt_y', toast_template: 'Y', color: '#222' },
        ],
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Wired 2 notifications');
    });
  });
});
