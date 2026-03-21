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
      ['compare_providers', RO],
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
      ['wire_system_to_gamescene', IDEMPOTENT],
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

  // NOTE: Tasks 2, 3, and 4 add more describe blocks HERE, inside this outer describe.
  // Do NOT close this describe block yet — leave it open for subsequent tasks.
});
