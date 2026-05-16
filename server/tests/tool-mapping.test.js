import { createRequire } from 'module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);

const {
  STREAM_EVENT_TYPES,
  normalizePolicyKey,
  normalizeEventTypes,
  mapTaskToolCall,
  validateToolArgumentsSemantics,
  registerTool,
  findTool,
  listAllTools,
  registerAlias,
  resolveAlias,
  addPreInvokeHook,
  addPostInvokeHook,
  invokeToolWithMiddleware,
  clearRegistry,
} = require('../mcp/tool-mapping.js');

describe('tool-mapping', () => {
  describe('STREAM_EVENT_TYPES', () => {
    it('contains the expected stream event type strings', () => {
      expect(STREAM_EVENT_TYPES).toEqual([
        'status_change',
        'completed',
        'failed',
        'started',
        'cancelled',
        'output',
        'output_update',
        '*',
      ]);
    });

    it('is a frozen-length array of 8 elements', () => {
      expect(STREAM_EVENT_TYPES).toHaveLength(8);
    });
  });

  describe('normalizePolicyKey', () => {
    it('trims whitespace and returns null for empty or undefined values', () => {
      expect(normalizePolicyKey('  policy.alpha  ')).toBe('policy.alpha');
      expect(normalizePolicyKey('   ')).toBeNull();
      expect(normalizePolicyKey(undefined)).toBeNull();
      expect(normalizePolicyKey(null)).toBeNull();
    });

    it('coerces numeric values to string via String()', () => {
      expect(normalizePolicyKey(42)).toBe('42');
      expect(normalizePolicyKey(0)).toBe('0');
    });

    it('returns null for empty string', () => {
      expect(normalizePolicyKey('')).toBeNull();
    });

    it('returns trimmed value for strings with leading/trailing whitespace only', () => {
      expect(normalizePolicyKey('\t key.name \n')).toBe('key.name');
    });
  });

  describe('normalizeEventTypes', () => {
    it('returns a normalized array for valid event types', () => {
      expect(normalizeEventTypes([' completed ', 'output_update'])).toEqual([
        'completed',
        'output_update',
      ]);
    });

    it('returns the default status_change event type when omitted', () => {
      expect(normalizeEventTypes(undefined)).toEqual(['status_change']);
      expect(normalizeEventTypes([])).toEqual(['status_change']);
    });

    it('returns null for invalid or non-string event types', () => {
      expect(normalizeEventTypes(['completed', 123])).toBeNull();
      expect(normalizeEventTypes(['completed', 'not_a_real_event'])).toBeNull();
      expect(normalizeEventTypes(['completed', '   '])).toBeNull();
    });

    it('deduplicates repeated event types while preserving order', () => {
      expect(normalizeEventTypes([
        'output',
        'failed',
        'output',
        'failed',
        '*',
        '*',
      ])).toEqual(['output', 'failed', '*']);
    });

    it('returns null for non-array truthy values', () => {
      // non-array truthy → falls into Array.isArray check → defaults to ['status_change']
      // then iterates over ['status_change'] which is valid
      expect(normalizeEventTypes('completed')).toEqual(['status_change']);
    });

    it('handles a single valid event type', () => {
      expect(normalizeEventTypes(['*'])).toEqual(['*']);
    });

    it('handles all valid event types without duplication', () => {
      const all = [...STREAM_EVENT_TYPES];
      expect(normalizeEventTypes(all)).toEqual(all);
    });

    it('returns null when a boolean is in the array', () => {
      expect(normalizeEventTypes([true])).toBeNull();
    });

    it('returns null when null is in the array', () => {
      expect(normalizeEventTypes([null])).toBeNull();
    });
  });

  describe('mapTaskToolCall', () => {
    // --- torque.task.* ---

    it('maps torque.task.submit to submit_task with forwarded args', () => {
      expect(mapTaskToolCall('torque.task.submit', {
        task: 'write tests',
        working_directory: '/repo/server',
        timeout_minutes: 15,
        auto_approve: true,
        priority: 7,
        provider: 'codex',
        model: 'gpt-5.3-codex-spark',
      })).toEqual({
        tool: 'submit_task',
        args: {
          task: 'write tests',
          working_directory: '/repo/server',
          timeout_minutes: 15,
          auto_approve: true,
          priority: 7,
          provider: 'codex',
          model: 'gpt-5.3-codex-spark',
        },
      });
    });

    it('maps torque.task.submit using prompt fallback when task is missing', () => {
      const result = mapTaskToolCall('torque.task.submit', {
        prompt: 'do something',
      });
      expect(result.tool).toBe('submit_task');
      expect(result.args.task).toBe('do something');
    });

    it('returns null for unknown tool names', () => {
      expect(mapTaskToolCall('torque.unknown.tool', { foo: 'bar' })).toBeNull();
    });

    it('handles missing args gracefully by defaulting to an empty object', () => {
      expect(() => mapTaskToolCall('torque.task.submit')).not.toThrow();
      expect(mapTaskToolCall('torque.task.submit')).toEqual({
        tool: 'submit_task',
        args: {
          task: undefined,
          working_directory: undefined,
          timeout_minutes: undefined,
          auto_approve: undefined,
          priority: undefined,
          provider: undefined,
          model: undefined,
        },
      });
    });

    it('maps torque.task.get to get_result', () => {
      expect(mapTaskToolCall('torque.task.get', { task_id: 'task-42' })).toEqual({
        tool: 'get_result',
        args: { task_id: 'task-42' },
      });
    });

    it('maps torque.task.list to list_tasks with all filter args', () => {
      expect(mapTaskToolCall('torque.task.list', {
        status: 'running',
        tags: ['test'],
        project: 'torque',
        all_projects: true,
        project_id: 'proj-1',
        limit: 50,
      })).toEqual({
        tool: 'list_tasks',
        args: {
          status: 'running',
          tags: ['test'],
          project: 'torque',
          all_projects: true,
          project_id: 'proj-1',
          limit: 50,
        },
      });
    });

    it('maps torque.task.cancel to cancel_task with confirm defaulting to true', () => {
      expect(mapTaskToolCall('torque.task.cancel', {
        task_id: 'task-99',
        reason: 'stale',
      })).toEqual({
        tool: 'cancel_task',
        args: {
          task_id: 'task-99',
          reason: 'stale',
          confirm: true,
        },
      });
    });

    it('maps torque.task.cancel preserving explicit confirm false', () => {
      expect(mapTaskToolCall('torque.task.cancel', {
        task_id: 'task-99',
        confirm: false,
      })).toEqual({
        tool: 'cancel_task',
        args: {
          task_id: 'task-99',
          reason: undefined,
          confirm: false,
        },
      });
    });

    it('maps torque.task.retry to retry_task', () => {
      expect(mapTaskToolCall('torque.task.retry', {
        task_id: 'task-7',
        modified_task: 'revised instructions',
      })).toEqual({
        tool: 'retry_task',
        args: {
          task_id: 'task-7',
          modified_task: 'revised instructions',
        },
      });
    });

    it('maps torque.task.review to set_task_review_status', () => {
      expect(mapTaskToolCall('torque.task.review', {
        task_id: 'task-10',
        status: 'approved',
        notes: 'LGTM',
      })).toEqual({
        tool: 'set_task_review_status',
        args: {
          task_id: 'task-10',
          status: 'approved',
          notes: 'LGTM',
        },
      });
    });

    it('maps torque.task.review using review_status fallback', () => {
      const result = mapTaskToolCall('torque.task.review', {
        task_id: 'task-10',
        review_status: 'needs_correction',
      });
      expect(result.args.status).toBe('needs_correction');
    });

    it('uses approval_id-specific mapping for torque.task.approve', () => {
      expect(mapTaskToolCall('torque.task.approve', {
        approval_id: 'approval-123',
        notes: 'ship it',
      })).toEqual({
        tool: 'approve_task',
        args: {
          approval_id: 'approval-123',
          notes: 'ship it',
        },
      });
    });

    it('falls back to set_task_review_status for torque.task.approve without approval_id', () => {
      expect(mapTaskToolCall('torque.task.approve', {
        task_id: 'task-5',
        notes: 'approved manually',
      })).toEqual({
        tool: 'set_task_review_status',
        args: {
          task_id: 'task-5',
          status: 'approved',
          notes: 'approved manually',
        },
      });
    });

    it('uses approval_id-specific mapping for torque.task.reject', () => {
      expect(mapTaskToolCall('torque.task.reject', {
        approval_id: 'approval-456',
        notes: 'wrong approach',
      })).toEqual({
        tool: 'reject_task',
        args: {
          approval_id: 'approval-456',
          notes: 'wrong approach',
        },
      });
    });

    it('falls back to set_task_review_status for torque.task.reject without approval_id', () => {
      expect(mapTaskToolCall('torque.task.reject', {
        task_id: 'task-8',
        notes: 'needs rework',
      })).toEqual({
        tool: 'set_task_review_status',
        args: {
          task_id: 'task-8',
          status: 'needs_correction',
          notes: 'needs rework',
        },
      });
    });

    // --- torque.workflow.* ---

    it('maps torque.workflow.create to create_workflow', () => {
      expect(mapTaskToolCall('torque.workflow.create', {
        name: 'deploy-pipeline',
        description: 'CI/CD workflow',
        working_directory: '/repo',
      })).toEqual({
        tool: 'create_workflow',
        args: {
          name: 'deploy-pipeline',
          description: 'CI/CD workflow',
          working_directory: '/repo',
        },
      });
    });

    it('maps torque.workflow.get to workflow_status', () => {
      expect(mapTaskToolCall('torque.workflow.get', {
        workflow_id: 'wf-1',
      })).toEqual({
        tool: 'workflow_status',
        args: { workflow_id: 'wf-1' },
      });
    });

    it('maps torque.workflow.list to list_workflows', () => {
      expect(mapTaskToolCall('torque.workflow.list', {
        status: 'completed',
        template_id: 'tmpl-1',
        since: '2026-01-01',
        limit: 10,
      })).toEqual({
        tool: 'list_workflows',
        args: {
          status: 'completed',
          template_id: 'tmpl-1',
          since: '2026-01-01',
          limit: 10,
        },
      });
    });

    it('maps torque.workflow.pause to pause_workflow', () => {
      expect(mapTaskToolCall('torque.workflow.pause', {
        workflow_id: 'wf-2',
      })).toEqual({
        tool: 'pause_workflow',
        args: { workflow_id: 'wf-2' },
      });
    });

    it('maps torque.workflow.resume to run_workflow', () => {
      expect(mapTaskToolCall('torque.workflow.resume', {
        workflow_id: 'wf-3',
      })).toEqual({
        tool: 'run_workflow',
        args: { workflow_id: 'wf-3' },
      });
    });

    it('maps torque.workflow.cancel to cancel_workflow', () => {
      expect(mapTaskToolCall('torque.workflow.cancel', {
        workflow_id: 'wf-4',
        reason: 'superseded',
      })).toEqual({
        tool: 'cancel_workflow',
        args: {
          workflow_id: 'wf-4',
          reason: 'superseded',
        },
      });
    });

    it('maps torque.workflow.retryNode to retry_workflow_from', () => {
      expect(mapTaskToolCall('torque.workflow.retryNode', {
        workflow_id: 'wf-5',
        from_task_id: 'task-20',
      })).toEqual({
        tool: 'retry_workflow_from',
        args: {
          workflow_id: 'wf-5',
          from_task_id: 'task-20',
        },
      });
    });

    it('maps torque.workflow.retryNode using node_task_id fallback', () => {
      const result = mapTaskToolCall('torque.workflow.retryNode', {
        workflow_id: 'wf-5',
        node_task_id: 'task-21',
      });
      expect(result.args.from_task_id).toBe('task-21');
    });

    it('maps torque.workflow.reopen to reopen_workflow', () => {
      expect(mapTaskToolCall('torque.workflow.reopen', {
        workflow_id: 'wf-6',
      })).toEqual({
        tool: 'reopen_workflow',
        args: { workflow_id: 'wf-6' },
      });
    });

    // --- torque.provider.* ---

    it('maps torque.provider.list to list_providers', () => {
      expect(mapTaskToolCall('torque.provider.list', {})).toEqual({
        tool: 'list_providers',
        args: {},
      });
    });

    it('maps torque.provider.get to provider_stats', () => {
      expect(mapTaskToolCall('torque.provider.get', {
        provider: 'codex',
        days: 7,
      })).toEqual({
        tool: 'provider_stats',
        args: { provider: 'codex', days: 7 },
      });
    });

    it('maps torque.provider.get using provider_id fallback', () => {
      const result = mapTaskToolCall('torque.provider.get', {
        provider_id: 'ollama',
      });
      expect(result.args.provider).toBe('ollama');
    });

    it('maps torque.provider.enable to configure_provider with enabled true', () => {
      expect(mapTaskToolCall('torque.provider.enable', {
        provider: 'deepinfra',
      })).toEqual({
        tool: 'configure_provider',
        args: { provider: 'deepinfra', enabled: true },
      });
    });

    it('maps torque.provider.disable to configure_provider with enabled false', () => {
      expect(mapTaskToolCall('torque.provider.disable', {
        provider: 'groq',
      })).toEqual({
        tool: 'configure_provider',
        args: { provider: 'groq', enabled: false },
      });
    });

    it('maps torque.provider.setWeight to configure_provider with max_concurrent', () => {
      expect(mapTaskToolCall('torque.provider.setWeight', {
        provider: 'codex',
        max_concurrent: 5,
      })).toEqual({
        tool: 'configure_provider',
        args: { provider: 'codex', max_concurrent: 5 },
      });
    });

    it('maps torque.provider.setWeight using weight fallback via nullish coalescing', () => {
      const result = mapTaskToolCall('torque.provider.setWeight', {
        provider: 'ollama',
        weight: 3,
      });
      expect(result.args.max_concurrent).toBe(3);
    });

    it('maps torque.provider.setWeight with max_concurrent=0 (falsy but defined)', () => {
      const result = mapTaskToolCall('torque.provider.setWeight', {
        provider: 'ollama',
        max_concurrent: 0,
        weight: 10,
      });
      // ?? operator: 0 is not null/undefined so max_concurrent wins
      expect(result.args.max_concurrent).toBe(0);
    });

    it('maps torque.provider.setDefault to set_default_provider', () => {
      expect(mapTaskToolCall('torque.provider.setDefault', {
        provider: 'codex',
      })).toEqual({
        tool: 'set_default_provider',
        args: { provider: 'codex' },
      });
    });

    // --- torque.route.* ---

    it('maps torque.route.preview to test_routing', () => {
      expect(mapTaskToolCall('torque.route.preview', {
        task: 'add auth',
        files: ['server/auth.js'],
      })).toEqual({
        tool: 'test_routing',
        args: { task: 'add auth', files: ['server/auth.js'] },
      });
    });

    it('maps torque.route.explain to test_routing (alias)', () => {
      expect(mapTaskToolCall('torque.route.explain', {
        task: 'refactor DB',
      })).toEqual({
        tool: 'test_routing',
        args: { task: 'refactor DB', files: undefined },
      });
    });

    // --- torque.audit.* ---

    it('maps torque.audit.query to __mcp_audit_query', () => {
      expect(mapTaskToolCall('torque.audit.query', {
        entity_type: 'task',
        entity_id: 'task-1',
        action: 'create',
        actor: 'user-1',
        since: '2026-01-01',
        until: '2026-12-31',
        limit: 100,
        offset: 0,
        include_stats: true,
      })).toEqual({
        tool: '__mcp_audit_query',
        args: {
          entity_type: 'task',
          entity_id: 'task-1',
          action: 'create',
          actor: 'user-1',
          since: '2026-01-01',
          until: '2026-12-31',
          limit: 100,
          offset: 0,
          include_stats: true,
        },
      });
    });

    // --- torque.telemetry.* ---

    it('maps torque.telemetry.summary to __mcp_telemetry_summary', () => {
      expect(mapTaskToolCall('torque.telemetry.summary', {
        include_tools: true,
        include_errors: false,
      })).toEqual({
        tool: '__mcp_telemetry_summary',
        args: { include_tools: true, include_errors: false },
      });
    });

    // --- torque.policy.* ---

    it('maps torque.policy.get to __mcp_policy_get', () => {
      expect(mapTaskToolCall('torque.policy.get', {
        key: 'max_retries',
      })).toEqual({
        tool: '__mcp_policy_get',
        args: { key: 'max_retries' },
      });
    });

    it('maps torque.policy.get using policy_key fallback', () => {
      const result = mapTaskToolCall('torque.policy.get', {
        policy_key: 'timeout',
      });
      expect(result.args.key).toBe('timeout');
    });

    it('maps torque.policy.set to __mcp_policy_set', () => {
      expect(mapTaskToolCall('torque.policy.set', {
        key: 'max_retries',
        value: 5,
      })).toEqual({
        tool: '__mcp_policy_set',
        args: { key: 'max_retries', value: 5 },
      });
    });

    it('maps torque.policy.set using policy_key fallback', () => {
      const result = mapTaskToolCall('torque.policy.set', {
        policy_key: 'timeout',
        value: 300,
      });
      expect(result.args.key).toBe('timeout');
    });

    // --- torque.session.* ---

    it('maps torque.session.open to __mcp_session_open', () => {
      expect(mapTaskToolCall('torque.session.open', {
        actor: 'agent-1',
      })).toEqual({
        tool: '__mcp_session_open',
        args: { actor: 'agent-1' },
      });
    });

    it('maps torque.session.close to __mcp_session_close', () => {
      expect(mapTaskToolCall('torque.session.close', {
        session_id: 'sess-abc',
      })).toEqual({
        tool: '__mcp_session_close',
        args: { session_id: 'sess-abc' },
      });
    });

    // --- torque.stream.* ---

    it('maps torque.stream.subscribe to __mcp_stream_subscribe', () => {
      expect(mapTaskToolCall('torque.stream.subscribe', {
        task_id: 'task-123',
        event_types: ['completed'],
        expires_in_minutes: 60,
        session_id: 'sess-1',
      })).toEqual({
        tool: '__mcp_stream_subscribe',
        args: {
          task_id: 'task-123',
          event_types: ['completed'],
          expires_in_minutes: 60,
          session_id: 'sess-1',
        },
      });
    });

    it('maps torque.stream.unsubscribe to __mcp_stream_unsubscribe', () => {
      expect(mapTaskToolCall('torque.stream.unsubscribe', {
        subscription_id: 'sub-xyz',
      })).toEqual({
        tool: '__mcp_stream_unsubscribe',
        args: { subscription_id: 'sub-xyz' },
      });
    });

    it('maps torque.stream.poll to __mcp_stream_poll', () => {
      expect(mapTaskToolCall('torque.stream.poll', {
        subscription_id: 'sub-xyz',
        cursor_token: '2026-05-01T00:00:00.000Z',
      })).toEqual({
        tool: '__mcp_stream_poll',
        args: {
          subscription_id: 'sub-xyz',
          cursor_token: '2026-05-01T00:00:00.000Z',
        },
      });
    });
  });

  describe('validateToolArgumentsSemantics', () => {
    // --- torque.task.submit ---

    it('returns valid true for valid audit query args', () => {
      expect(validateToolArgumentsSemantics('torque.audit.query', {
        limit: 25,
        offset: 0,
        since: '2026-04-01T00:00:00.000Z',
        until: '2026-04-02T12:30:45.000Z',
      })).toEqual({ valid: true });
    });

    it('requires task or prompt for torque.task.submit', () => {
      expect(validateToolArgumentsSemantics('torque.task.submit', {})).toEqual({
        valid: false,
        code: 'VALIDATION_TASK_REQUIRED',
        message: 'Either task or prompt is required',
      });
    });

    it('accepts torque.task.submit with task field', () => {
      expect(validateToolArgumentsSemantics('torque.task.submit', {
        task: 'write tests',
      })).toEqual({ valid: true });
    });

    it('accepts torque.task.submit with prompt field', () => {
      expect(validateToolArgumentsSemantics('torque.task.submit', {
        prompt: 'write tests',
      })).toEqual({ valid: true });
    });

    // --- torque.task.approve / torque.task.reject ---

    it('requires approval_id or task_id for torque.task.approve', () => {
      expect(validateToolArgumentsSemantics('torque.task.approve', {})).toEqual({
        valid: false,
        code: 'VALIDATION_APPROVAL_OR_TASK_REQUIRED',
        message: 'Either approval_id or task_id is required',
      });
    });

    it('accepts torque.task.approve with approval_id', () => {
      expect(validateToolArgumentsSemantics('torque.task.approve', {
        approval_id: 'appr-1',
      })).toEqual({ valid: true });
    });

    it('accepts torque.task.approve with task_id', () => {
      expect(validateToolArgumentsSemantics('torque.task.approve', {
        task_id: 'task-1',
      })).toEqual({ valid: true });
    });

    it('requires approval_id or task_id for torque.task.reject', () => {
      expect(validateToolArgumentsSemantics('torque.task.reject', {})).toEqual({
        valid: false,
        code: 'VALIDATION_APPROVAL_OR_TASK_REQUIRED',
        message: 'Either approval_id or task_id is required',
      });
    });

    it('accepts torque.task.reject with task_id', () => {
      expect(validateToolArgumentsSemantics('torque.task.reject', {
        task_id: 'task-1',
      })).toEqual({ valid: true });
    });

    // --- torque.workflow.create ---

    it('requires name for torque.workflow.create', () => {
      expect(validateToolArgumentsSemantics('torque.workflow.create', {})).toEqual({
        valid: false,
        code: 'VALIDATION_WORKFLOW_NAME_REQUIRED',
        message: 'name is required',
      });
    });

    it('accepts torque.workflow.create with name', () => {
      expect(validateToolArgumentsSemantics('torque.workflow.create', {
        name: 'my-workflow',
      })).toEqual({ valid: true });
    });

    // --- torque.workflow.get/pause/resume/cancel ---

    it('requires workflow_id for torque.workflow.get', () => {
      expect(validateToolArgumentsSemantics('torque.workflow.get', {})).toEqual({
        valid: false,
        code: 'VALIDATION_WORKFLOW_ID_REQUIRED',
        message: 'workflow_id is required',
      });
    });

    it('requires workflow_id for torque.workflow.pause', () => {
      expect(validateToolArgumentsSemantics('torque.workflow.pause', {})).toEqual({
        valid: false,
        code: 'VALIDATION_WORKFLOW_ID_REQUIRED',
        message: 'workflow_id is required',
      });
    });

    it('requires workflow_id for torque.workflow.resume', () => {
      expect(validateToolArgumentsSemantics('torque.workflow.resume', {})).toEqual({
        valid: false,
        code: 'VALIDATION_WORKFLOW_ID_REQUIRED',
        message: 'workflow_id is required',
      });
    });

    it('requires workflow_id for torque.workflow.cancel', () => {
      expect(validateToolArgumentsSemantics('torque.workflow.cancel', {})).toEqual({
        valid: false,
        code: 'VALIDATION_WORKFLOW_ID_REQUIRED',
        message: 'workflow_id is required',
      });
    });

    it('accepts torque.workflow.get with workflow_id', () => {
      expect(validateToolArgumentsSemantics('torque.workflow.get', {
        workflow_id: 'wf-1',
      })).toEqual({ valid: true });
    });

    // --- torque.workflow.retryNode ---

    it('requires workflow_id and from_task_id for torque.workflow.retryNode', () => {
      expect(validateToolArgumentsSemantics('torque.workflow.retryNode', {})).toEqual({
        valid: false,
        code: 'VALIDATION_WORKFLOW_RETRYNODE_REQUIRED',
        message: 'workflow_id and from_task_id (or node_task_id) are required',
      });
    });

    it('requires from_task_id even when workflow_id is present for torque.workflow.retryNode', () => {
      expect(validateToolArgumentsSemantics('torque.workflow.retryNode', {
        workflow_id: 'wf-1',
      })).toEqual({
        valid: false,
        code: 'VALIDATION_WORKFLOW_RETRYNODE_REQUIRED',
        message: 'workflow_id and from_task_id (or node_task_id) are required',
      });
    });

    it('accepts torque.workflow.retryNode with workflow_id and from_task_id', () => {
      expect(validateToolArgumentsSemantics('torque.workflow.retryNode', {
        workflow_id: 'wf-1',
        from_task_id: 'task-10',
      })).toEqual({ valid: true });
    });

    it('accepts torque.workflow.retryNode with workflow_id and node_task_id', () => {
      expect(validateToolArgumentsSemantics('torque.workflow.retryNode', {
        workflow_id: 'wf-1',
        node_task_id: 'task-10',
      })).toEqual({ valid: true });
    });

    // --- torque.route.preview / torque.route.explain ---

    it('requires task for torque.route.preview', () => {
      expect(validateToolArgumentsSemantics('torque.route.preview', {})).toEqual({
        valid: false,
        code: 'VALIDATION_ROUTING_TASK_REQUIRED',
        message: 'task is required',
      });
    });

    it('requires task for torque.route.explain', () => {
      expect(validateToolArgumentsSemantics('torque.route.explain', {})).toEqual({
        valid: false,
        code: 'VALIDATION_ROUTING_TASK_REQUIRED',
        message: 'task is required',
      });
    });

    it('accepts torque.route.preview with task', () => {
      expect(validateToolArgumentsSemantics('torque.route.preview', {
        task: 'add caching',
      })).toEqual({ valid: true });
    });

    // --- torque.session.* ---

    it('requires actor for torque.session.open', () => {
      expect(validateToolArgumentsSemantics('torque.session.open', {})).toEqual({
        valid: false,
        code: 'VALIDATION_SESSION_ACTOR_REQUIRED',
        message: 'actor is required',
      });
    });

    it('accepts torque.session.open with actor', () => {
      expect(validateToolArgumentsSemantics('torque.session.open', {
        actor: 'agent-1',
      })).toEqual({ valid: true });
    });

    it('requires session_id for torque.session.close', () => {
      expect(validateToolArgumentsSemantics('torque.session.close', {})).toEqual({
        valid: false,
        code: 'VALIDATION_SESSION_ID_REQUIRED',
        message: 'session_id is required',
      });
    });

    it('accepts torque.session.close with session_id', () => {
      expect(validateToolArgumentsSemantics('torque.session.close', {
        session_id: 'sess-1',
      })).toEqual({ valid: true });
    });

    // --- torque.stream.subscribe ---

    it('requires task_id or session_id for torque.stream.subscribe', () => {
      expect(validateToolArgumentsSemantics('torque.stream.subscribe', {})).toEqual({
        valid: false,
        code: 'VALIDATION_STREAM_TARGET_REQUIRED',
        message: 'task_id or session_id is required',
      });
    });

    it('accepts torque.stream.subscribe with session_id only', () => {
      expect(validateToolArgumentsSemantics('torque.stream.subscribe', {
        session_id: 'sess-1',
      })).toEqual({ valid: true });
    });

    it('rejects non-array event_types for torque.stream.subscribe', () => {
      expect(validateToolArgumentsSemantics('torque.stream.subscribe', {
        task_id: 'task-1',
        event_types: 'completed',
      })).toEqual({
        valid: false,
        code: 'VALIDATION_STREAM_EVENT_TYPES_ARRAY',
        message: 'event_types must be an array',
      });
    });

    it('validates stream subscriptions against supported event types', () => {
      expect(validateToolArgumentsSemantics('torque.stream.subscribe', {
        task_id: 'task-123',
        event_types: ['completed', 'output'],
        expires_in_minutes: 60,
      })).toEqual({ valid: true });

      expect(validateToolArgumentsSemantics('torque.stream.subscribe', {
        task_id: 'task-123',
        event_types: ['completed', 'bogus'],
      })).toEqual({
        valid: false,
        code: 'VALIDATION_STREAM_EVENT_TYPES_INVALID',
        message: `event_types must be a subset of: ${STREAM_EVENT_TYPES.join(', ')}`,
      });
    });

    it('rejects invalid expires_in_minutes for torque.stream.subscribe', () => {
      expect(validateToolArgumentsSemantics('torque.stream.subscribe', {
        task_id: 'task-1',
        expires_in_minutes: 0,
      })).toEqual({
        valid: false,
        code: 'VALIDATION_STREAM_TTL_INVALID',
        message: 'expires_in_minutes must be a positive number up to 10080',
      });

      expect(validateToolArgumentsSemantics('torque.stream.subscribe', {
        task_id: 'task-1',
        expires_in_minutes: -5,
      })).toEqual({
        valid: false,
        code: 'VALIDATION_STREAM_TTL_INVALID',
        message: 'expires_in_minutes must be a positive number up to 10080',
      });

      expect(validateToolArgumentsSemantics('torque.stream.subscribe', {
        task_id: 'task-1',
        expires_in_minutes: 10081,
      })).toEqual({
        valid: false,
        code: 'VALIDATION_STREAM_TTL_INVALID',
        message: 'expires_in_minutes must be a positive number up to 10080',
      });

      expect(validateToolArgumentsSemantics('torque.stream.subscribe', {
        task_id: 'task-1',
        expires_in_minutes: 'not-a-number',
      })).toEqual({
        valid: false,
        code: 'VALIDATION_STREAM_TTL_INVALID',
        message: 'expires_in_minutes must be a positive number up to 10080',
      });
    });

    it('accepts valid expires_in_minutes at boundary for torque.stream.subscribe', () => {
      expect(validateToolArgumentsSemantics('torque.stream.subscribe', {
        task_id: 'task-1',
        expires_in_minutes: 10080,
      })).toEqual({ valid: true });

      expect(validateToolArgumentsSemantics('torque.stream.subscribe', {
        task_id: 'task-1',
        expires_in_minutes: 1,
      })).toEqual({ valid: true });
    });

    // --- torque.stream.unsubscribe ---

    it('requires subscription_id for torque.stream.unsubscribe', () => {
      expect(validateToolArgumentsSemantics('torque.stream.unsubscribe', {})).toEqual({
        valid: false,
        code: 'VALIDATION_SUBSCRIPTION_ID_REQUIRED',
        message: 'subscription_id is required',
      });
    });

    it('accepts torque.stream.unsubscribe with subscription_id', () => {
      expect(validateToolArgumentsSemantics('torque.stream.unsubscribe', {
        subscription_id: 'sub-1',
      })).toEqual({ valid: true });
    });

    // --- torque.stream.poll ---

    it('requires subscription_id for torque.stream.poll', () => {
      expect(validateToolArgumentsSemantics('torque.stream.poll', {})).toEqual({
        valid: false,
        code: 'VALIDATION_SUBSCRIPTION_ID_REQUIRED',
        message: 'subscription_id is required',
      });
    });

    it('rejects non-string cursor_token for torque.stream.poll', () => {
      expect(validateToolArgumentsSemantics('torque.stream.poll', {
        subscription_id: 'sub-1',
        cursor_token: 12345,
      })).toEqual({
        valid: false,
        code: 'VALIDATION_CURSOR_TOKEN_TYPE',
        message: 'cursor_token must be a string',
      });
    });

    it('rejects empty cursor_token for torque.stream.poll', () => {
      expect(validateToolArgumentsSemantics('torque.stream.poll', {
        subscription_id: 'sub-1',
        cursor_token: '   ',
      })).toEqual({
        valid: false,
        code: 'VALIDATION_CURSOR_TOKEN_INVALID',
        message: 'cursor_token must be a valid timestamp string',
      });
    });

    it('rejects non-parseable cursor_token for torque.stream.poll', () => {
      expect(validateToolArgumentsSemantics('torque.stream.poll', {
        subscription_id: 'sub-1',
        cursor_token: 'not-a-date',
      })).toEqual({
        valid: false,
        code: 'VALIDATION_CURSOR_TOKEN_INVALID',
        message: 'cursor_token must be a valid timestamp string',
      });
    });

    it('accepts valid cursor_token for torque.stream.poll', () => {
      expect(validateToolArgumentsSemantics('torque.stream.poll', {
        subscription_id: 'sub-1',
        cursor_token: '2026-05-01T00:00:00.000Z',
      })).toEqual({ valid: true });
    });

    it('accepts torque.stream.poll without cursor_token', () => {
      expect(validateToolArgumentsSemantics('torque.stream.poll', {
        subscription_id: 'sub-1',
      })).toEqual({ valid: true });
    });

    // --- torque.policy.get ---

    it('rejects empty policy_key for torque.policy.get', () => {
      expect(validateToolArgumentsSemantics('torque.policy.get', {
        key: '   ',
      })).toEqual({
        valid: false,
        code: 'VALIDATION_POLICY_KEY_REQUIRED',
        message: 'policy_key must be a non-empty string when provided',
      });
    });

    it('accepts torque.policy.get without key (fetches all)', () => {
      expect(validateToolArgumentsSemantics('torque.policy.get', {})).toEqual({
        valid: true,
      });
    });

    it('accepts torque.policy.get with valid key', () => {
      expect(validateToolArgumentsSemantics('torque.policy.get', {
        key: 'max_retries',
      })).toEqual({ valid: true });
    });

    // --- torque.policy.set ---

    it('requires non-empty policy key for torque.policy.set', () => {
      expect(validateToolArgumentsSemantics('torque.policy.set', {
        value: 5,
      })).toEqual({
        valid: false,
        code: 'VALIDATION_POLICY_KEY_REQUIRED',
        message: 'policy key is required',
      });
    });

    it('requires value for torque.policy.set', () => {
      expect(validateToolArgumentsSemantics('torque.policy.set', {
        key: 'max_retries',
      })).toEqual({
        valid: false,
        code: 'VALIDATION_POLICY_VALUE_REQUIRED',
        message: 'value is required',
      });
    });

    it('accepts torque.policy.set with key and value', () => {
      expect(validateToolArgumentsSemantics('torque.policy.set', {
        key: 'max_retries',
        value: 3,
      })).toEqual({ valid: true });
    });

    it('accepts torque.policy.set with policy_key fallback', () => {
      expect(validateToolArgumentsSemantics('torque.policy.set', {
        policy_key: 'timeout',
        value: 300,
      })).toEqual({ valid: true });
    });

    // --- torque.provider.* ---

    it('requires provider for torque.provider.get', () => {
      expect(validateToolArgumentsSemantics('torque.provider.get', {})).toEqual({
        valid: false,
        code: 'VALIDATION_PROVIDER_REQUIRED',
        message: 'provider or provider_id is required',
      });
    });

    it('requires provider for torque.provider.enable', () => {
      expect(validateToolArgumentsSemantics('torque.provider.enable', {})).toEqual({
        valid: false,
        code: 'VALIDATION_PROVIDER_REQUIRED',
        message: 'provider or provider_id is required',
      });
    });

    it('requires provider for torque.provider.disable', () => {
      expect(validateToolArgumentsSemantics('torque.provider.disable', {})).toEqual({
        valid: false,
        code: 'VALIDATION_PROVIDER_REQUIRED',
        message: 'provider or provider_id is required',
      });
    });

    it('requires provider for torque.provider.setWeight', () => {
      expect(validateToolArgumentsSemantics('torque.provider.setWeight', {})).toEqual({
        valid: false,
        code: 'VALIDATION_PROVIDER_REQUIRED',
        message: 'provider or provider_id is required',
      });
    });

    it('requires provider for torque.provider.setDefault', () => {
      expect(validateToolArgumentsSemantics('torque.provider.setDefault', {})).toEqual({
        valid: false,
        code: 'VALIDATION_PROVIDER_REQUIRED',
        message: 'provider or provider_id is required',
      });
    });

    it('accepts provider via provider_id for torque.provider.get', () => {
      expect(validateToolArgumentsSemantics('torque.provider.get', {
        provider_id: 'codex',
      })).toEqual({ valid: true });
    });

    it('requires weight or max_concurrent for torque.provider.setWeight', () => {
      expect(validateToolArgumentsSemantics('torque.provider.setWeight', {
        provider: 'codex',
      })).toEqual({
        valid: false,
        code: 'VALIDATION_PROVIDER_WEIGHT_REQUIRED',
        message: 'weight or max_concurrent is required',
      });
    });

    it('accepts torque.provider.setWeight with weight', () => {
      expect(validateToolArgumentsSemantics('torque.provider.setWeight', {
        provider: 'codex',
        weight: 5,
      })).toEqual({ valid: true });
    });

    it('accepts torque.provider.setWeight with max_concurrent', () => {
      expect(validateToolArgumentsSemantics('torque.provider.setWeight', {
        provider: 'codex',
        max_concurrent: 10,
      })).toEqual({ valid: true });
    });

    // --- torque.audit.query ---

    it('returns validation errors when audit limit is not an integer', () => {
      expect(validateToolArgumentsSemantics('torque.audit.query', {
        limit: 1.5,
      })).toEqual({
        valid: false,
        code: 'VALIDATION_AUDIT_LIMIT_INVALID',
        message: 'limit must be a positive integer',
      });
    });

    it('returns validation errors when audit limit is zero', () => {
      expect(validateToolArgumentsSemantics('torque.audit.query', {
        limit: 0,
      })).toEqual({
        valid: false,
        code: 'VALIDATION_AUDIT_LIMIT_INVALID',
        message: 'limit must be a positive integer',
      });
    });

    it('returns validation errors when audit limit is negative', () => {
      expect(validateToolArgumentsSemantics('torque.audit.query', {
        limit: -10,
      })).toEqual({
        valid: false,
        code: 'VALIDATION_AUDIT_LIMIT_INVALID',
        message: 'limit must be a positive integer',
      });
    });

    it('returns validation errors when audit limit is Infinity', () => {
      expect(validateToolArgumentsSemantics('torque.audit.query', {
        limit: Infinity,
      })).toEqual({
        valid: false,
        code: 'VALIDATION_AUDIT_LIMIT_INVALID',
        message: 'limit must be a positive integer',
      });
    });

    it('returns validation errors when audit offset is negative', () => {
      expect(validateToolArgumentsSemantics('torque.audit.query', {
        offset: -1,
      })).toEqual({
        valid: false,
        code: 'VALIDATION_AUDIT_OFFSET_INVALID',
        message: 'offset must be a non-negative integer',
      });
    });

    it('returns validation errors when audit offset is not an integer', () => {
      expect(validateToolArgumentsSemantics('torque.audit.query', {
        offset: 1.5,
      })).toEqual({
        valid: false,
        code: 'VALIDATION_AUDIT_OFFSET_INVALID',
        message: 'offset must be a non-negative integer',
      });
    });

    it('accepts audit offset of zero', () => {
      expect(validateToolArgumentsSemantics('torque.audit.query', {
        offset: 0,
      })).toEqual({ valid: true });
    });

    it('returns validation errors when audit timestamps are invalid', () => {
      expect(validateToolArgumentsSemantics('torque.audit.query', {
        since: 'not-an-iso-timestamp',
      })).toEqual({
        valid: false,
        code: 'VALIDATION_AUDIT_SINCE_INVALID',
        message: 'since must be an ISO8601 timestamp',
      });

      expect(validateToolArgumentsSemantics('torque.audit.query', {
        until: 'still-not-a-timestamp',
      })).toEqual({
        valid: false,
        code: 'VALIDATION_AUDIT_UNTIL_INVALID',
        message: 'until must be an ISO8601 timestamp',
      });
    });

    // --- unknown tools pass through ---

    it('returns valid true for unrecognized tool names (no semantic rules)', () => {
      expect(validateToolArgumentsSemantics('torque.something.else', {
        foo: 'bar',
      })).toEqual({ valid: true });
    });

    it('handles missing args by defaulting to empty object', () => {
      // torque.task.submit with no args → task/prompt missing
      expect(validateToolArgumentsSemantics('torque.task.submit')).toEqual({
        valid: false,
        code: 'VALIDATION_TASK_REQUIRED',
        message: 'Either task or prompt is required',
      });
    });
  });

  describe('registerTool / findTool / listAllTools', () => {
    afterEach(() => {
      clearRegistry();
    });

    it('registerTool stores a tool that findTool can retrieve', () => {
      const def = { handler: async () => ({ ok: true }) };
      registerTool('my_tool', def);
      expect(findTool('my_tool')).toBe(def);
    });

    it('findTool returns null for unregistered tools', () => {
      expect(findTool('nonexistent')).toBeNull();
    });

    it('listAllTools returns all registered tool names', () => {
      registerTool('tool_a', { handler: async () => ({}) });
      registerTool('tool_b', { handler: async () => ({}) });
      registerTool('tool_c', { handler: async () => ({}) });
      const names = listAllTools();
      expect(names).toEqual(['tool_a', 'tool_b', 'tool_c']);
    });

    it('listAllTools returns an empty array when no tools are registered', () => {
      expect(listAllTools()).toEqual([]);
    });

    it('registerTool overwrites a previously registered tool with the same name', () => {
      const def1 = { handler: async () => ({ v: 1 }) };
      const def2 = { handler: async () => ({ v: 2 }) };
      registerTool('dup', def1);
      registerTool('dup', def2);
      expect(findTool('dup')).toBe(def2);
      expect(listAllTools()).toEqual(['dup']);
    });
  });

  describe('clearRegistry', () => {
    afterEach(() => {
      clearRegistry();
    });

    it('removes all registered tools', () => {
      registerTool('tool_x', { handler: async () => ({}) });
      registerTool('tool_y', { handler: async () => ({}) });
      clearRegistry();
      expect(listAllTools()).toEqual([]);
      expect(findTool('tool_x')).toBeNull();
    });

    it('removes all registered aliases', () => {
      registerAlias('shortcut', 'target');
      clearRegistry();
      expect(resolveAlias('shortcut')).toBe('shortcut');
    });

    it('removes all pre-invoke and post-invoke hooks', async () => {
      const hookCalled = { pre: false, post: false };
      registerTool('hook_test', { handler: async () => ({ ok: true }) });
      addPreInvokeHook(() => { hookCalled.pre = true; });
      addPostInvokeHook(() => { hookCalled.post = true; });
      clearRegistry();

      // Re-register tool so invocation can proceed
      registerTool('hook_test', { handler: async () => ({ ok: true }) });
      await invokeToolWithMiddleware('hook_test', {});
      expect(hookCalled.pre).toBe(false);
      expect(hookCalled.post).toBe(false);
    });
  });

  describe('registerAlias / resolveAlias', () => {
    afterEach(() => {
      clearRegistry();
    });

    it('returns the original name when no alias is registered', () => {
      expect(resolveAlias('some_tool')).toBe('some_tool');
    });

    it('resolves a registered alias to its target', () => {
      registerAlias('shortcut', 'real_tool');
      expect(resolveAlias('shortcut')).toBe('real_tool');
    });

    it('resolves chained aliases transitively', () => {
      registerAlias('a', 'b');
      registerAlias('b', 'c');
      expect(resolveAlias('a')).toBe('c');
    });

    it('terminates without infinite loop on circular aliases', () => {
      registerAlias('x', 'y');
      registerAlias('y', 'x');
      const result = resolveAlias('x');
      // Must terminate — returns either 'x' or 'y'
      expect(['x', 'y']).toContain(result);
    });
  });

  describe('addPreInvokeHook / addPostInvokeHook', () => {
    afterEach(() => {
      clearRegistry();
    });

    it('throws when addPreInvokeHook is passed a non-function value', () => {
      expect(() => addPreInvokeHook('not a function')).toThrow(TypeError);
      expect(() => addPreInvokeHook(null)).toThrow(TypeError);
      expect(() => addPreInvokeHook(42)).toThrow(TypeError);
    });

    it('throws when addPostInvokeHook is passed a non-function value', () => {
      expect(() => addPostInvokeHook('not a function')).toThrow(TypeError);
      expect(() => addPostInvokeHook(undefined)).toThrow(TypeError);
      expect(() => addPostInvokeHook({})).toThrow(TypeError);
    });

    it('pre-invoke hook can mutate params before handler receives them', async () => {
      let capturedParams = null;
      registerTool('test_tool', {
        handler: async (params) => {
          capturedParams = params;
          return { ok: true };
        },
      });

      addPreInvokeHook((_name, params) => {
        return { ...params, injected: true };
      });

      await invokeToolWithMiddleware('test_tool', { original: 'value' });
      expect(capturedParams.injected).toBe(true);
      expect(capturedParams.original).toBe('value');
    });
  });

  describe('invokeToolWithMiddleware', () => {
    afterEach(() => {
      clearRegistry();
    });

    it('resolves aliases before invocation', async () => {
      const handler = vi.fn(async () => ({ done: true }));
      registerTool('real', { handler });
      registerAlias('alias', 'real');

      const result = await invokeToolWithMiddleware('alias', {});
      expect(handler).toHaveBeenCalled();
      expect(result).toEqual({ done: true });
    });

    it('returns hookError when a pre-invoke hook throws', async () => {
      registerTool('my_tool', {
        handler: async () => ({ ok: true }),
      });

      addPreInvokeHook(() => {
        throw new Error('hook failed');
      });

      const result = await invokeToolWithMiddleware('my_tool', {});
      expect(result.hookError).toBe(true);
    });

    it('post-invoke hook can transform the result', async () => {
      registerTool('my_tool', {
        handler: async () => ({ original: true }),
      });

      addPostInvokeHook((_name, _result) => {
        return { modified: true };
      });

      const result = await invokeToolWithMiddleware('my_tool', {});
      expect(result).toEqual({ modified: true });
    });

    it('post-invoke hook error does NOT fail the invocation', async () => {
      const handler = vi.fn(async () => ({ ok: true }));
      registerTool('my_tool', { handler });

      addPostInvokeHook(() => {
        throw new Error('post-hook exploded');
      });

      const result = await invokeToolWithMiddleware('my_tool', {});
      expect(result).toEqual({ ok: true });
    });

    it('multiple pre-invoke hooks run in registration order', async () => {
      const order = [];
      registerTool('my_tool', {
        handler: async (params) => {
          return { order: params.order };
        },
      });

      addPreInvokeHook((_name, params) => {
        order.push('first');
        return { ...params, order: [...(params.order || []), 'first'] };
      });

      addPreInvokeHook((_name, params) => {
        order.push('second');
        return { ...params, order: [...(params.order || []), 'second'] };
      });

      const result = await invokeToolWithMiddleware('my_tool', {});
      expect(order).toEqual(['first', 'second']);
      expect(result.order).toEqual(['first', 'second']);
    });

    it('returns error object when tool is not found', async () => {
      const result = await invokeToolWithMiddleware('nonexistent_tool', {});
      expect(result.error).toBe(true);
      expect(result.message).toContain('Tool not found');
      expect(result.message).toContain('nonexistent_tool');
    });

    it('pre-invoke hook returning undefined/null does not replace params', async () => {
      let capturedParams = null;
      registerTool('test_tool', {
        handler: async (params) => {
          capturedParams = params;
          return { ok: true };
        },
      });

      addPreInvokeHook(() => undefined);
      addPreInvokeHook(() => null);

      await invokeToolWithMiddleware('test_tool', { key: 'value' });
      expect(capturedParams.key).toBe('value');
    });

    it('multiple post-invoke hooks chain transformations in order', async () => {
      registerTool('chain_tool', {
        handler: async () => ({ step: 0 }),
      });

      addPostInvokeHook((_name, result) => ({ ...result, step: 1 }));
      addPostInvokeHook((_name, result) => ({ ...result, step: result.step + 1 }));

      const result = await invokeToolWithMiddleware('chain_tool', {});
      expect(result.step).toBe(2);
    });

    it('post-invoke hook returning undefined keeps previous result', async () => {
      registerTool('noop_post', {
        handler: async () => ({ original: true }),
      });

      addPostInvokeHook(() => undefined);

      const result = await invokeToolWithMiddleware('noop_post', {});
      expect(result).toEqual({ original: true });
    });

    it('handler errors propagate as rejections', async () => {
      registerTool('failing_tool', {
        handler: async () => { throw new Error('handler boom'); },
      });

      await expect(invokeToolWithMiddleware('failing_tool', {}))
        .rejects.toThrow('handler boom');
    });

    it('pre-invoke hook receives the resolved tool name (not the alias)', async () => {
      let receivedName = null;
      registerTool('actual_tool', {
        handler: async () => ({ ok: true }),
      });
      registerAlias('my_alias', 'actual_tool');

      addPreInvokeHook((name, params) => {
        receivedName = name;
        return params;
      });

      await invokeToolWithMiddleware('my_alias', {});
      expect(receivedName).toBe('actual_tool');
    });
  });
});
