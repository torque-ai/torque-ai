'use strict';

const { getAnnotations } = require('../tool-annotations');

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const DESTRUCT = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const DISPATCH = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const IDEMPOTENT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const LIFECYCLE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const ASYNC_RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false };

describe('tool-annotations', () => {
  describe('prefix convention rules', () => {
    it.each([
      ['list_tasks', RO],
      ['get_result', RO],
      ['check_status', RO],
      ['find_similar_tasks', RO],
      ['search_nodes', RO],
      ['scan_project', RO],
      ['diff_task_runs', RO],
      ['export_report', RO],
      ['analyze_task', RO],
      ['validate_event_consistency', RO],
      ['detect_file_conflicts', RO],
      ['compare_task_outputs', RO],
      ['predict_duration', RO],
      ['diagnose_ci_failure', RO],
      ['capture_screenshots', RO],
      ['suggest_provider', RO],
      ['compute_cost', RO],
      ['tsserver_diagnostics', RO],
      ['peek_ui', RO],
      ['peek_elements', RO],
    ])('%s → readOnly', (name, expected) => {
      expect(getAnnotations(name)).toEqual(expected);
    });

    it.each([
      ['delete_task', DESTRUCT],
      ['rollback_task', DESTRUCT],
      ['archive_task', DESTRUCT],
      ['remove_host', DESTRUCT],
      ['clear_notifications', DESTRUCT],
      ['revoke_api_key', DESTRUCT],
      ['cleanup_stale', DESTRUCT],
    ])('%s → destructive', (name, expected) => {
      expect(getAnnotations(name)).toEqual(expected);
    });

    it.each([
      ['cancel_task', DESTRUCT],
      ['cancel_workflow', DESTRUCT],
    ])('%s → cancel (destructive)', (name, expected) => {
      expect(getAnnotations(name)).toEqual(expected);
    });

    it.each([
      ['submit_task', DISPATCH],
      ['queue_task', DISPATCH],
      ['create_workflow', DISPATCH],
      ['run_workflow', DISPATCH],
      ['schedule_task', DISPATCH],
      ['generate_feature_tasks', DISPATCH],
      ['trigger_webhook', DISPATCH],
      ['clone_task', DISPATCH],
    ])('%s → dispatch/openWorld', (name, expected) => {
      expect(getAnnotations(name)).toEqual(expected);
    });

    it.each([
      ['set_project_defaults', IDEMPOTENT],
      ['configure_stall_detection', IDEMPOTENT],
      ['tag_task', IDEMPOTENT],
      ['manage_host', IDEMPOTENT],
      ['add_ts_interface_members', IDEMPOTENT],
      ['inject_class_dependency', IDEMPOTENT],
      ['normalize_interface_formatting', IDEMPOTENT],
      ['update_project_stats', IDEMPOTENT],
      ['register_agent', IDEMPOTENT],
      ['enable_provider', IDEMPOTENT],
      ['approve_task', IDEMPOTENT],
      ['record_metric', IDEMPOTENT],
      ['resolve_conflict', IDEMPOTENT],
    ])('%s → idempotent mutation', (name, expected) => {
      expect(getAnnotations(name)).toEqual(expected);
    });

    it.each([
      ['retry_task', LIFECYCLE],
      ['resume_task', LIFECYCLE],
      ['restore_task', LIFECYCLE],
      ['start_pending_task', LIFECYCLE],
      ['pause_task', LIFECYCLE],
      ['skip_task', LIFECYCLE],
      ['stop_ci_watch', LIFECYCLE],
      ['recover_host', LIFECYCLE],
      ['refresh_host_models', LIFECYCLE],
    ])('%s → lifecycle', (name, expected) => {
      expect(getAnnotations(name)).toEqual(expected);
    });

    it.each([
      ['await_workflow', ASYNC_RO],
      ['await_task', ASYNC_RO],
      ['wait_for_task', ASYNC_RO],
      ['poll_task_events', ASYNC_RO],
      ['stream_task_output', ASYNC_RO],
    ])('%s → async/blocking (readOnly, not idempotent)', (name, expected) => {
      expect(getAnnotations(name)).toEqual(expected);
    });
  });

  describe('explicit overrides', () => {
    it('restart_server is destructive', () => {
      expect(getAnnotations('restart_server')).toEqual({
        readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false,
      });
    });

    it('smart_submit_task dispatches (not matched by submit_* prefix)', () => {
      expect(getAnnotations('smart_submit_task')).toEqual(DISPATCH);
    });

    it('hashline_read is readOnly despite hashline_edit being mutable', () => {
      expect(getAnnotations('hashline_read')).toEqual(RO);
    });

    it('hashline_edit is all-false (mutable, not destructive, not idempotent)', () => {
      expect(getAnnotations('hashline_edit')).toEqual(LIFECYCLE); // all false
    });

    it('stash_changes is destructive despite *_changes suffix', () => {
      expect(getAnnotations('stash_changes')).toEqual(DESTRUCT);
    });

    it('configure (bare name) is idempotent', () => {
      expect(getAnnotations('configure')).toEqual(IDEMPOTENT);
    });

    it('strategic_decompose dispatches to external LLM', () => {
      expect(getAnnotations('strategic_decompose')).toEqual(DISPATCH);
    });

    it('compare_providers dispatches because it launches provider tasks', () => {
      expect(getAnnotations('compare_providers')).toEqual(DISPATCH);
    });
  });

  describe('exact matches', () => {
    it.each([
      ['ping', RO],
      ['blocked_tasks', RO],
      ['critical_path', RO],
      ['what_if', RO],
      ['dependency_graph', RO],
      ['batch_cancel', DESTRUCT],
    ])('%s → exact match', (name, expected) => {
      expect(getAnnotations(name)).toEqual(expected);
    });
  });

  describe('suffix rules', () => {
    it('tool ending in _status with no prefix match uses suffix rule', () => {
      expect(getAnnotations('ci_run_status')).toEqual(RO);
    });

    it('tool ending in _dashboard with no prefix match uses suffix rule', () => {
      expect(getAnnotations('coordination_dashboard')).toEqual(RO);
    });

    it('tool ending in _health with no prefix match uses suffix rule', () => {
      expect(getAnnotations('integration_health')).toEqual(RO);
    });
  });

  describe('prefix-before-suffix ordering', () => {
    it('set_task_review_status matches set_* prefix, NOT *_status suffix', () => {
      expect(getAnnotations('set_task_review_status')).toEqual(IDEMPOTENT);
    });

    it('cancel_workflow matches cancel_* prefix (destructive)', () => {
      expect(getAnnotations('cancel_workflow')).toEqual(DESTRUCT);
    });

    it('list_paused_tasks matches list_* prefix (readOnly)', () => {
      expect(getAnnotations('list_paused_tasks')).toEqual(RO);
    });

    it('get_batch_summary matches get_* prefix, not *_summary suffix', () => {
      expect(getAnnotations('get_batch_summary')).toEqual(RO);
    });
  });

  describe('fallback', () => {
    it('unknown tool returns all-false', () => {
      expect(getAnnotations('some_unknown_tool_xyz')).toEqual(LIFECYCLE); // all false
    });
  });

  describe('shape validation', () => {
    it('every annotation has exactly 4 boolean fields', () => {
      const names = ['list_tasks', 'delete_task', 'submit_task', 'set_project_defaults',
        'retry_task', 'await_workflow', 'ping', 'peek_interact', 'some_unknown'];
      const expectedKeys = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];
      for (const name of names) {
        const ann = getAnnotations(name);
        expect(Object.keys(ann).sort()).toEqual(expectedKeys.sort());
        for (const key of expectedKeys) {
          expect(typeof ann[key]).toBe('boolean');
        }
      }
    });
  });

  describe('semantic validity', () => {
    it('no annotation is both readOnly and destructive', () => {
      const { OVERRIDES, EXACT_MATCHES, PREFIX_RULES, SUFFIX_RULES } = require('../tool-annotations');
      const allAnnotations = [
        ...Object.values(OVERRIDES),
        ...Object.values(EXACT_MATCHES),
        ...PREFIX_RULES.map(r => r.annotation),
        ...SUFFIX_RULES.map(r => r.annotation),
      ];
      for (const ann of allAnnotations) {
        expect(ann.readOnlyHint && ann.destructiveHint).toBe(false);
      }
    });
  });

  describe('validateCoverage', () => {
    const { validateCoverage } = require('../tool-annotations');

    it('returns empty uncovered list when all tools are covered', () => {
      const names = ['list_tasks', 'delete_task', 'ping', 'peek_interact'];
      const result = validateCoverage(names);
      expect(result.uncovered).toEqual([]);
    });

    it('detects uncovered tools (hit fallback)', () => {
      const names = ['list_tasks', 'zzz_mystery_tool'];
      const result = validateCoverage(names);
      expect(result.uncovered).toContain('zzz_mystery_tool');
    });

    it('detects stale overrides (override references nonexistent tool)', () => {
      const result = validateCoverage(['list_tasks']);
      expect(result.stale.length).toBeGreaterThan(0);
    });

    it('returns stale list containing override names not in provided tool list', () => {
      const result = validateCoverage([]);
      expect(result.stale).toContain('restart_server');
      expect(result.stale).toContain('smart_submit_task');
    });
  });

  describe('integration — real TOOLS array', () => {
    it('every tool in TOOLS has annotations after merge', () => {
      const { TOOLS } = require('../tools');
      const expectedKeys = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];
      for (const tool of TOOLS) {
        expect(tool.annotations).toBeDefined();
        expect(Object.keys(tool.annotations).sort()).toEqual(expectedKeys.sort());
        for (const key of expectedKeys) {
          expect(typeof tool.annotations[key]).toBe('boolean');
        }
      }
    });

    it('no tool has both readOnly and destructive annotations', () => {
      const { TOOLS } = require('../tools');
      for (const tool of TOOLS) {
        if (tool.annotations.readOnlyHint && tool.annotations.destructiveHint) {
          throw new Error(`Tool "${tool.name}" is both readOnly and destructive`);
        }
      }
    });

    it('validateCoverage reports zero uncovered tools', () => {
      const { TOOLS } = require('../tools');
      const { validateCoverage } = require('../tool-annotations');
      const names = TOOLS.map(t => t.name);
      const result = validateCoverage(names);
      if (result.uncovered.length > 0) {
        throw new Error(
          `${result.uncovered.length} uncovered tools need annotations:\n` +
          result.uncovered.map(n => `  - ${n}`).join('\n')
        );
      }
    });

    it('validateCoverage reports zero stale overrides', () => {
      const { TOOLS } = require('../tools');
      const { validateCoverage } = require('../tool-annotations');
      const names = TOOLS.map(t => t.name);
      const result = validateCoverage(names);
      if (result.stale.length > 0) {
        throw new Error(
          `${result.stale.length} stale override(s) reference nonexistent tools:\n` +
          result.stale.map(n => `  - ${n}`).join('\n')
        );
      }
    });
  });
});
