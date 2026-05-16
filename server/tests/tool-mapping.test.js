import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

const {
  STREAM_EVENT_TYPES,
  normalizePolicyKey,
  normalizeEventTypes,
  mapTaskToolCall,
  validateToolArgumentsSemantics,
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
  });

  describe('normalizePolicyKey', () => {
    it('trims whitespace and returns null for empty or undefined values', () => {
      expect(normalizePolicyKey('  policy.alpha  ')).toBe('policy.alpha');
      expect(normalizePolicyKey('   ')).toBeNull();
      expect(normalizePolicyKey(undefined)).toBeNull();
      expect(normalizePolicyKey(null)).toBeNull();
    });

    it('coerces non-string values via String()', () => {
      expect(normalizePolicyKey(42)).toBe('42');
      expect(normalizePolicyKey(true)).toBe('true');
      expect(normalizePolicyKey(0)).toBe('0');
    });

    it('returns null for empty string', () => {
      expect(normalizePolicyKey('')).toBeNull();
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

    it('returns default for non-array input', () => {
      expect(normalizeEventTypes('completed')).toEqual(['status_change']);
      expect(normalizeEventTypes(null)).toEqual(['status_change']);
      expect(normalizeEventTypes(42)).toEqual(['status_change']);
    });
  });

  describe('mapTaskToolCall', () => {
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

    it('uses prompt fallback when task is absent in torque.task.submit', () => {
      expect(mapTaskToolCall('torque.task.submit', {
        prompt: 'from prompt field',
      })).toEqual({
        tool: 'submit_task',
        args: {
          task: 'from prompt field',
          working_directory: undefined,
          timeout_minutes: undefined,
          auto_approve: undefined,
          priority: undefined,
          provider: undefined,
          model: undefined,
        },
      });
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
      expect(mapTaskToolCall('torque.task.get', {
        task_id: 'task-abc',
      })).toEqual({
        tool: 'get_result',
        args: { task_id: 'task-abc' },
      });
    });

    it('maps torque.task.list to list_tasks with all filters', () => {
      expect(mapTaskToolCall('torque.task.list', {
        status: 'running',
        tags: ['feature'],
        project: 'my-project',
        all_projects: true,
        project_id: 'proj-1',
        limit: 50,
      })).toEqual({
        tool: 'list_tasks',
        args: {
          status: 'running',
          tags: ['feature'],
          project: 'my-project',
          all_projects: true,
          project_id: 'proj-1',
          limit: 50,
        },
      });
    });

    it('maps torque.task.cancel with explicit confirm=false', () => {
      expect(mapTaskToolCall('torque.task.cancel', {
        task_id: 'task-x',
        reason: 'stalled',
        confirm: false,
      })).toEqual({
        tool: 'cancel_task',
        args: {
          task_id: 'task-x',
          reason: 'stalled',
          confirm: false,
        },
      });
    });

    it('maps torque.task.cancel defaults confirm to true when not provided', () => {
      expect(mapTaskToolCall('torque.task.cancel', {
        task_id: 'task-x',
      })).toEqual({
        tool: 'cancel_task',
        args: {
          task_id: 'task-x',
          reason: undefined,
          confirm: true,
        },
      });
    });

    it('maps torque.task.retry to retry_task', () => {
      expect(mapTaskToolCall('torque.task.retry', {
        task_id: 'task-r',
        modified_task: 'updated instructions',
      })).toEqual({
        tool: 'retry_task',
        args: {
          task_id: 'task-r',
          modified_task: 'updated instructions',
        },
      });
    });

    it('maps torque.task.review and uses review_status fallback', () => {
      expect(mapTaskToolCall('torque.task.review', {
        task_id: 'task-rev',
        status: 'approved',
        notes: 'lgtm',
      })).toEqual({
        tool: 'set_task_review_status',
        args: {
          task_id: 'task-rev',
          status: 'approved',
          notes: 'lgtm',
        },
      });

      // Falls back to review_status when status is absent
      expect(mapTaskToolCall('torque.task.review', {
        task_id: 'task-rev',
        review_status: 'needs_correction',
      })).toEqual({
        tool: 'set_task_review_status',
        args: {
          task_id: 'task-rev',
          status: 'needs_correction',
          notes: undefined,
        },
      });
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
        task_id: 'task-456',
        notes: 'looks good',
      })).toEqual({
        tool: 'set_task_review_status',
        args: {
          task_id: 'task-456',
          status: 'approved',
          notes: 'looks good',
        },
      });
    });

    it('uses approval_id-specific mapping for torque.task.reject', () => {
      expect(mapTaskToolCall('torque.task.reject', {
        approval_id: 'approval-789',
        notes: 'needs work',
      })).toEqual({
        tool: 'reject_task',
        args: {
          approval_id: 'approval-789',
          notes: 'needs work',
        },
      });
    });

    it('falls back to set_task_review_status for torque.task.reject without approval_id', () => {
      expect(mapTaskToolCall('torque.task.reject', {
        task_id: 'task-r1',
        notes: 'missing tests',
      })).toEqual({
        tool: 'set_task_review_status',
        args: {
          task_id: 'task-r1',
          status: 'needs_correction',
          notes: 'missing tests',
        },
      });
    });

    it('maps torque.workflow.create to create_workflow', () => {
      expect(mapTaskToolCall('torque.workflow.create', {
        name: 'deploy-pipeline',
        description: 'production deploy',
        working_directory: '/repo',
      })).toEqual({
        tool: 'create_workflow',
        args: {
          name: 'deploy-pipeline',
          description: 'production deploy',
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
        workflow_id: 'wf-pause',
      })).toEqual({
        tool: 'pause_workflow',
        args: { workflow_id: 'wf-pause' },
      });
    });

    it('maps torque.workflow.resume to run_workflow', () => {
      expect(mapTaskToolCall('torque.workflow.resume', {
        workflow_id: 'wf-resume',
      })).toEqual({
        tool: 'run_workflow',
        args: { workflow_id: 'wf-resume' },
      });
    });

    it('maps torque.workflow.cancel to cancel_workflow', () => {
      expect(mapTaskToolCall('torque.workflow.cancel', {
        workflow_id: 'wf-cancel',
        reason: 'obsolete',
      })).toEqual({
        tool: 'cancel_workflow',
        args: {
          workflow_id: 'wf-cancel',
          reason: 'obsolete',
        },
      });
    });

    it('maps torque.workflow.retryNode with from_task_id', () => {
      expect(mapTaskToolCall('torque.workflow.retryNode', {
        workflow_id: 'wf-retry',
        from_task_id: 'task-node-1',
      })).toEqual({
        tool: 'retry_workflow_from',
        args: {
          workflow_id: 'wf-retry',
          from_task_id: 'task-node-1',
        },
      });
    });

    it('maps torque.workflow.retryNode using node_task_id fallback', () => {
      expect(mapTaskToolCall('torque.workflow.retryNode', {
        workflow_id: 'wf-retry',
        node_task_id: 'task-node-2',
      })).toEqual({
        tool: 'retry_workflow_from',
        args: {
          workflow_id: 'wf-retry',
          from_task_id: 'task-node-2',
        },
      });
    });

    it('maps torque.workflow.reopen to reopen_workflow', () => {
      expect(mapTaskToolCall('torque.workflow.reopen', {
        workflow_id: 'wf-reopen',
      })).toEqual({
        tool: 'reopen_workflow',
        args: { workflow_id: 'wf-reopen' },
      });
    });

    it('maps torque.provider.list to list_providers with empty args', () => {
      expect(mapTaskToolCall('torque.provider.list', {})).toEqual({
        tool: 'list_providers',
        args: {},
      });
    });

    it('maps torque.provider.get using provider_id fallback', () => {
      expect(mapTaskToolCall('torque.provider.get', {
        provider: 'codex',
        days: 7,
      })).toEqual({
        tool: 'provider_stats',
        args: { provider: 'codex', days: 7 },
      });

      expect(mapTaskToolCall('torque.provider.get', {
        provider_id: 'ollama',
      })).toEqual({
        tool: 'provider_stats',
        args: { provider: 'ollama', days: undefined },
      });
    });

    it('maps torque.provider.enable using provider_id fallback', () => {
      expect(mapTaskToolCall('torque.provider.enable', {
        provider: 'deepinfra',
      })).toEqual({
        tool: 'configure_provider',
        args: { provider: 'deepinfra', enabled: true },
      });

      expect(mapTaskToolCall('torque.provider.enable', {
        provider_id: 'groq',
      })).toEqual({
        tool: 'configure_provider',
        args: { provider: 'groq', enabled: true },
      });
    });

    it('maps torque.provider.disable using provider_id fallback', () => {
      expect(mapTaskToolCall('torque.provider.disable', {
        provider: 'hyperbolic',
      })).toEqual({
        tool: 'configure_provider',
        args: { provider: 'hyperbolic', enabled: false },
      });

      expect(mapTaskToolCall('torque.provider.disable', {
        provider_id: 'cerebras',
      })).toEqual({
        tool: 'configure_provider',
        args: { provider: 'cerebras', enabled: false },
      });
    });

    it('maps torque.provider.setWeight with max_concurrent taking precedence over weight', () => {
      expect(mapTaskToolCall('torque.provider.setWeight', {
        provider: 'ollama',
        max_concurrent: 4,
        weight: 2,
      })).toEqual({
        tool: 'configure_provider',
        args: { provider: 'ollama', max_concurrent: 4 },
      });
    });

    it('maps torque.provider.setWeight falls back to weight when max_concurrent is undefined', () => {
      expect(mapTaskToolCall('torque.provider.setWeight', {
        provider: 'ollama',
        weight: 3,
      })).toEqual({
        tool: 'configure_provider',
        args: { provider: 'ollama', max_concurrent: 3 },
      });
    });

    it('maps torque.provider.setWeight with provider_id fallback', () => {
      expect(mapTaskToolCall('torque.provider.setWeight', {
        provider_id: 'codex',
        max_concurrent: 5,
      })).toEqual({
        tool: 'configure_provider',
        args: { provider: 'codex', max_concurrent: 5 },
      });
    });

    it('maps torque.provider.setDefault using provider_id fallback', () => {
      expect(mapTaskToolCall('torque.provider.setDefault', {
        provider: 'codex',
      })).toEqual({
        tool: 'set_default_provider',
        args: { provider: 'codex' },
      });

      expect(mapTaskToolCall('torque.provider.setDefault', {
        provider_id: 'ollama',
      })).toEqual({
        tool: 'set_default_provider',
        args: { provider: 'ollama' },
      });
    });

    it('maps torque.route.preview to test_routing', () => {
      expect(mapTaskToolCall('torque.route.preview', {
        task: 'add caching',
        files: ['src/cache.ts'],
      })).toEqual({
        tool: 'test_routing',
        args: { task: 'add caching', files: ['src/cache.ts'] },
      });
    });

    it('maps torque.route.explain to test_routing (same as preview)', () => {
      expect(mapTaskToolCall('torque.route.explain', {
        task: 'refactor auth',
      })).toEqual({
        tool: 'test_routing',
        args: { task: 'refactor auth', files: undefined },
      });
    });

    it('maps torque.audit.query to __mcp_audit_query with all fields', () => {
      expect(mapTaskToolCall('torque.audit.query', {
        entity_type: 'task',
        entity_id: 'task-1',
        action: 'create',
        actor: 'user-1',
        since: '2026-01-01',
        until: '2026-02-01',
        limit: 100,
        offset: 50,
        include_stats: true,
      })).toEqual({
        tool: '__mcp_audit_query',
        args: {
          entity_type: 'task',
          entity_id: 'task-1',
          action: 'create',
          actor: 'user-1',
          since: '2026-01-01',
          until: '2026-02-01',
          limit: 100,
          offset: 50,
          include_stats: true,
        },
      });
    });

    it('maps torque.telemetry.summary to __mcp_telemetry_summary', () => {
      expect(mapTaskToolCall('torque.telemetry.summary', {
        include_tools: true,
        include_errors: false,
      })).toEqual({
        tool: '__mcp_telemetry_summary',
        args: { include_tools: true, include_errors: false },
      });
    });

    it('maps torque.policy.get using policy_key fallback', () => {
      expect(mapTaskToolCall('torque.policy.get', {
        key: 'max_retries',
      })).toEqual({
        tool: '__mcp_policy_get',
        args: { key: 'max_retries' },
      });

      expect(mapTaskToolCall('torque.policy.get', {
        policy_key: 'timeout',
      })).toEqual({
        tool: '__mcp_policy_get',
        args: { key: 'timeout' },
      });
    });

    it('maps torque.policy.set using policy_key fallback', () => {
      expect(mapTaskToolCall('torque.policy.set', {
        key: 'max_retries',
        value: 5,
      })).toEqual({
        tool: '__mcp_policy_set',
        args: { key: 'max_retries', value: 5 },
      });

      expect(mapTaskToolCall('torque.policy.set', {
        policy_key: 'timeout',
        value: 300,
      })).toEqual({
        tool: '__mcp_policy_set',
        args: { key: 'timeout', value: 300 },
      });
    });

    it('maps torque.session.open to __mcp_session_open', () => {
      expect(mapTaskToolCall('torque.session.open', {
        actor: 'claude-agent',
      })).toEqual({
        tool: '__mcp_session_open',
        args: { actor: 'claude-agent' },
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

    it('maps torque.stream.subscribe to __mcp_stream_subscribe', () => {
      expect(mapTaskToolCall('torque.stream.subscribe', {
        task_id: 'task-s1',
        event_types: ['completed', 'failed'],
        expires_in_minutes: 120,
        session_id: 'sess-1',
      })).toEqual({
        tool: '__mcp_stream_subscribe',
        args: {
          task_id: 'task-s1',
          event_types: ['completed', 'failed'],
          expires_in_minutes: 120,
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
    it('returns valid true for valid torque.task.submit args', () => {
      expect(validateToolArgumentsSemantics('torque.task.submit', {
        task: 'build feature',
      })).toEqual({ valid: true });
    });

    it('accepts prompt as alternative to task in torque.task.submit', () => {
      expect(validateToolArgumentsSemantics('torque.task.submit', {
        prompt: 'build feature',
      })).toEqual({ valid: true });
    });

    it('rejects torque.task.submit when both task and prompt are missing', () => {
      expect(validateToolArgumentsSemantics('torque.task.submit', {})).toEqual({
        valid: false,
        code: 'VALIDATION_TASK_REQUIRED',
        message: 'Either task or prompt is required',
      });
    });

    it('rejects torque.task.submit with null args (defaults to empty object)', () => {
      expect(validateToolArgumentsSemantics('torque.task.submit', null)).toEqual({
        valid: false,
        code: 'VALIDATION_TASK_REQUIRED',
        message: 'Either task or prompt is required',
      });
    });

    // --- torque.task.approve / reject ---
    it('rejects torque.task.approve without approval_id or task_id', () => {
      expect(validateToolArgumentsSemantics('torque.task.approve', {})).toEqual({
        valid: false,
        code: 'VALIDATION_APPROVAL_OR_TASK_REQUIRED',
        message: 'Either approval_id or task_id is required',
      });
    });

    it('rejects torque.task.reject without approval_id or task_id', () => {
      expect(validateToolArgumentsSemantics('torque.task.reject', {})).toEqual({
        valid: false,
        code: 'VALIDATION_APPROVAL_OR_TASK_REQUIRED',
        message: 'Either approval_id or task_id is required',
      });
    });

    it('accepts torque.task.approve with task_id only', () => {
      expect(validateToolArgumentsSemantics('torque.task.approve', {
        task_id: 'task-1',
      })).toEqual({ valid: true });
    });

    it('accepts torque.task.reject with approval_id only', () => {
      expect(validateToolArgumentsSemantics('torque.task.reject', {
        approval_id: 'appr-1',
      })).toEqual({ valid: true });
    });

    // --- torque.workflow.create ---
    it('rejects torque.workflow.create without name', () => {
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

    // --- torque.workflow.get/pause/resume/cancel missing workflow_id ---
    it('rejects torque.workflow.get without workflow_id', () => {
      expect(validateToolArgumentsSemantics('torque.workflow.get', {})).toEqual({
        valid: false,
        code: 'VALIDATION_WORKFLOW_ID_REQUIRED',
        message: 'workflow_id is required',
      });
    });

    it('rejects torque.workflow.pause without workflow_id', () => {
      expect(validateToolArgumentsSemantics('torque.workflow.pause', {})).toEqual({
        valid: false,
        code: 'VALIDATION_WORKFLOW_ID_REQUIRED',
        message: 'workflow_id is required',
      });
    });

    it('rejects torque.workflow.resume without workflow_id', () => {
      expect(validateToolArgumentsSemantics('torque.workflow.resume', {})).toEqual({
        valid: false,
        code: 'VALIDATION_WORKFLOW_ID_REQUIRED',
        message: 'workflow_id is required',
      });
    });

    it('rejects torque.workflow.cancel without workflow_id', () => {
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
    it('rejects torque.workflow.retryNode without workflow_id', () => {
      expect(validateToolArgumentsSemantics('torque.workflow.retryNode', {
        from_task_id: 'task-1',
      })).toEqual({
        valid: false,
        code: 'VALIDATION_WORKFLOW_RETRYNODE_REQUIRED',
        message: 'workflow_id and from_task_id (or node_task_id) are required',
      });
    });

    it('rejects torque.workflow.retryNode without from_task_id or node_task_id', () => {
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
        from_task_id: 'task-1',
      })).toEqual({ valid: true });
    });

    it('accepts torque.workflow.retryNode with workflow_id and node_task_id', () => {
      expect(validateToolArgumentsSemantics('torque.workflow.retryNode', {
        workflow_id: 'wf-1',
        node_task_id: 'task-2',
      })).toEqual({ valid: true });
    });

    // --- torque.route.preview / explain ---
    it('rejects torque.route.preview without task', () => {
      expect(validateToolArgumentsSemantics('torque.route.preview', {})).toEqual({
        valid: false,
        code: 'VALIDATION_ROUTING_TASK_REQUIRED',
        message: 'task is required',
      });
    });

    it('rejects torque.route.explain without task', () => {
      expect(validateToolArgumentsSemantics('torque.route.explain', {})).toEqual({
        valid: false,
        code: 'VALIDATION_ROUTING_TASK_REQUIRED',
        message: 'task is required',
      });
    });

    it('accepts torque.route.preview with task', () => {
      expect(validateToolArgumentsSemantics('torque.route.preview', {
        task: 'implement caching',
      })).toEqual({ valid: true });
    });

    // --- torque.session.open ---
    it('rejects torque.session.open without actor', () => {
      expect(validateToolArgumentsSemantics('torque.session.open', {})).toEqual({
        valid: false,
        code: 'VALIDATION_SESSION_ACTOR_REQUIRED',
        message: 'actor is required',
      });
    });

    it('accepts torque.session.open with actor', () => {
      expect(validateToolArgumentsSemantics('torque.session.open', {
        actor: 'user-1',
      })).toEqual({ valid: true });
    });

    // --- torque.session.close ---
    it('rejects torque.session.close without session_id', () => {
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
    it('rejects torque.stream.subscribe without task_id or session_id', () => {
      expect(validateToolArgumentsSemantics('torque.stream.subscribe', {})).toEqual({
        valid: false,
        code: 'VALIDATION_STREAM_TARGET_REQUIRED',
        message: 'task_id or session_id is required',
      });
    });

    it('rejects torque.stream.subscribe with non-array event_types', () => {
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

    it('accepts torque.stream.subscribe with session_id instead of task_id', () => {
      expect(validateToolArgumentsSemantics('torque.stream.subscribe', {
        session_id: 'sess-1',
      })).toEqual({ valid: true });
    });

    it('rejects torque.stream.subscribe with expires_in_minutes <= 0', () => {
      expect(validateToolArgumentsSemantics('torque.stream.subscribe', {
        task_id: 'task-1',
        expires_in_minutes: 0,
      })).toEqual({
        valid: false,
        code: 'VALIDATION_STREAM_TTL_INVALID',
        message: 'expires_in_minutes must be a positive number up to 10080',
      });
    });

    it('rejects torque.stream.subscribe with expires_in_minutes > 10080', () => {
      expect(validateToolArgumentsSemantics('torque.stream.subscribe', {
        task_id: 'task-1',
        expires_in_minutes: 10081,
      })).toEqual({
        valid: false,
        code: 'VALIDATION_STREAM_TTL_INVALID',
        message: 'expires_in_minutes must be a positive number up to 10080',
      });
    });

    it('rejects torque.stream.subscribe with non-number expires_in_minutes', () => {
      expect(validateToolArgumentsSemantics('torque.stream.subscribe', {
        task_id: 'task-1',
        expires_in_minutes: 'sixty',
      })).toEqual({
        valid: false,
        code: 'VALIDATION_STREAM_TTL_INVALID',
        message: 'expires_in_minutes must be a positive number up to 10080',
      });
    });

    // --- torque.stream.unsubscribe ---
    it('rejects torque.stream.unsubscribe without subscription_id', () => {
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
    it('rejects torque.stream.poll without subscription_id', () => {
      expect(validateToolArgumentsSemantics('torque.stream.poll', {})).toEqual({
        valid: false,
        code: 'VALIDATION_SUBSCRIPTION_ID_REQUIRED',
        message: 'subscription_id is required',
      });
    });

    it('rejects torque.stream.poll with non-string cursor_token', () => {
      expect(validateToolArgumentsSemantics('torque.stream.poll', {
        subscription_id: 'sub-1',
        cursor_token: 12345,
      })).toEqual({
        valid: false,
        code: 'VALIDATION_CURSOR_TOKEN_TYPE',
        message: 'cursor_token must be a string',
      });
    });

    it('rejects torque.stream.poll with empty cursor_token', () => {
      expect(validateToolArgumentsSemantics('torque.stream.poll', {
        subscription_id: 'sub-1',
        cursor_token: '   ',
      })).toEqual({
        valid: false,
        code: 'VALIDATION_CURSOR_TOKEN_INVALID',
        message: 'cursor_token must be a valid timestamp string',
      });
    });

    it('rejects torque.stream.poll with invalid timestamp cursor_token', () => {
      expect(validateToolArgumentsSemantics('torque.stream.poll', {
        subscription_id: 'sub-1',
        cursor_token: 'not-a-date',
      })).toEqual({
        valid: false,
        code: 'VALIDATION_CURSOR_TOKEN_INVALID',
        message: 'cursor_token must be a valid timestamp string',
      });
    });

    it('accepts torque.stream.poll with valid cursor_token', () => {
      expect(validateToolArgumentsSemantics('torque.stream.poll', {
        subscription_id: 'sub-1',
        cursor_token: '2026-05-01T12:00:00.000Z',
      })).toEqual({ valid: true });
    });

    it('accepts torque.stream.poll with valid cursor_token that has surrounding whitespace', () => {
      const result = validateToolArgumentsSemantics('torque.stream.poll', {
        subscription_id: 'sub-1',
        cursor_token: '  2026-05-01T12:00:00.000Z  ',
      });
      expect(result).toEqual({ valid: true });
    });

    it('accepts torque.stream.poll without cursor_token', () => {
      expect(validateToolArgumentsSemantics('torque.stream.poll', {
        subscription_id: 'sub-1',
      })).toEqual({ valid: true });
    });

    // --- torque.policy.get ---
    it('rejects torque.policy.get when provided key is empty', () => {
      expect(validateToolArgumentsSemantics('torque.policy.get', {
        key: '   ',
      })).toEqual({
        valid: false,
        code: 'VALIDATION_POLICY_KEY_REQUIRED',
        message: 'policy_key must be a non-empty string when provided',
      });
    });

    it('rejects torque.policy.get when provided policy_key is empty', () => {
      expect(validateToolArgumentsSemantics('torque.policy.get', {
        policy_key: '',
      })).toEqual({
        valid: false,
        code: 'VALIDATION_POLICY_KEY_REQUIRED',
        message: 'policy_key must be a non-empty string when provided',
      });
    });

    it('accepts torque.policy.get with no key (lists all)', () => {
      expect(validateToolArgumentsSemantics('torque.policy.get', {})).toEqual({ valid: true });
    });

    it('accepts torque.policy.get with valid key', () => {
      expect(validateToolArgumentsSemantics('torque.policy.get', {
        key: 'max_retries',
      })).toEqual({ valid: true });
    });

    // --- torque.policy.set ---
    it('rejects torque.policy.set without key', () => {
      expect(validateToolArgumentsSemantics('torque.policy.set', {
        value: 5,
      })).toEqual({
        valid: false,
        code: 'VALIDATION_POLICY_KEY_REQUIRED',
        message: 'policy key is required',
      });
    });

    it('rejects torque.policy.set with empty key', () => {
      expect(validateToolArgumentsSemantics('torque.policy.set', {
        key: '   ',
        value: 5,
      })).toEqual({
        valid: false,
        code: 'VALIDATION_POLICY_KEY_REQUIRED',
        message: 'policy key is required',
      });
    });

    it('rejects torque.policy.set without value', () => {
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

    it('accepts torque.policy.set with policy_key alias', () => {
      expect(validateToolArgumentsSemantics('torque.policy.set', {
        policy_key: 'timeout',
        value: 300,
      })).toEqual({ valid: true });
    });

    // --- torque.provider.* missing provider ---
    it('rejects torque.provider.get without provider or provider_id', () => {
      expect(validateToolArgumentsSemantics('torque.provider.get', {})).toEqual({
        valid: false,
        code: 'VALIDATION_PROVIDER_REQUIRED',
        message: 'provider or provider_id is required',
      });
    });

    it('rejects torque.provider.enable without provider or provider_id', () => {
      expect(validateToolArgumentsSemantics('torque.provider.enable', {})).toEqual({
        valid: false,
        code: 'VALIDATION_PROVIDER_REQUIRED',
        message: 'provider or provider_id is required',
      });
    });

    it('rejects torque.provider.disable without provider or provider_id', () => {
      expect(validateToolArgumentsSemantics('torque.provider.disable', {})).toEqual({
        valid: false,
        code: 'VALIDATION_PROVIDER_REQUIRED',
        message: 'provider or provider_id is required',
      });
    });

    it('rejects torque.provider.setWeight without provider or provider_id', () => {
      expect(validateToolArgumentsSemantics('torque.provider.setWeight', {
        max_concurrent: 5,
      })).toEqual({
        valid: false,
        code: 'VALIDATION_PROVIDER_REQUIRED',
        message: 'provider or provider_id is required',
      });
    });

    it('rejects torque.provider.setDefault without provider or provider_id', () => {
      expect(validateToolArgumentsSemantics('torque.provider.setDefault', {})).toEqual({
        valid: false,
        code: 'VALIDATION_PROVIDER_REQUIRED',
        message: 'provider or provider_id is required',
      });
    });

    it('accepts torque.provider.get with provider', () => {
      expect(validateToolArgumentsSemantics('torque.provider.get', {
        provider: 'codex',
      })).toEqual({ valid: true });
    });

    it('accepts torque.provider.enable with provider_id', () => {
      expect(validateToolArgumentsSemantics('torque.provider.enable', {
        provider_id: 'ollama',
      })).toEqual({ valid: true });
    });

    // --- torque.provider.setWeight missing weight ---
    it('rejects torque.provider.setWeight without weight or max_concurrent', () => {
      expect(validateToolArgumentsSemantics('torque.provider.setWeight', {
        provider: 'ollama',
      })).toEqual({
        valid: false,
        code: 'VALIDATION_PROVIDER_WEIGHT_REQUIRED',
        message: 'weight or max_concurrent is required',
      });
    });

    it('accepts torque.provider.setWeight with weight', () => {
      expect(validateToolArgumentsSemantics('torque.provider.setWeight', {
        provider: 'ollama',
        weight: 3,
      })).toEqual({ valid: true });
    });

    it('accepts torque.provider.setWeight with max_concurrent', () => {
      expect(validateToolArgumentsSemantics('torque.provider.setWeight', {
        provider: 'ollama',
        max_concurrent: 8,
      })).toEqual({ valid: true });
    });

    // --- torque.audit.query ---
    it('returns valid true for valid audit query args', () => {
      expect(validateToolArgumentsSemantics('torque.audit.query', {
        limit: 25,
        offset: 0,
        since: '2026-04-01T00:00:00.000Z',
        until: '2026-04-02T12:30:45.000Z',
      })).toEqual({ valid: true });
    });

    it('returns validation errors when audit limit is not an integer', () => {
      expect(validateToolArgumentsSemantics('torque.audit.query', {
        limit: 1.5,
      })).toEqual({
        valid: false,
        code: 'VALIDATION_AUDIT_LIMIT_INVALID',
        message: 'limit must be a positive integer',
      });
    });

    it('rejects audit limit of zero', () => {
      expect(validateToolArgumentsSemantics('torque.audit.query', {
        limit: 0,
      })).toEqual({
        valid: false,
        code: 'VALIDATION_AUDIT_LIMIT_INVALID',
        message: 'limit must be a positive integer',
      });
    });

    it('rejects negative audit limit', () => {
      expect(validateToolArgumentsSemantics('torque.audit.query', {
        limit: -5,
      })).toEqual({
        valid: false,
        code: 'VALIDATION_AUDIT_LIMIT_INVALID',
        message: 'limit must be a positive integer',
      });
    });

    it('rejects non-finite audit limit', () => {
      expect(validateToolArgumentsSemantics('torque.audit.query', {
        limit: Infinity,
      })).toEqual({
        valid: false,
        code: 'VALIDATION_AUDIT_LIMIT_INVALID',
        message: 'limit must be a positive integer',
      });
    });

    it('rejects non-integer audit offset', () => {
      expect(validateToolArgumentsSemantics('torque.audit.query', {
        offset: 1.5,
      })).toEqual({
        valid: false,
        code: 'VALIDATION_AUDIT_OFFSET_INVALID',
        message: 'offset must be a non-negative integer',
      });
    });

    it('rejects negative audit offset', () => {
      expect(validateToolArgumentsSemantics('torque.audit.query', {
        offset: -1,
      })).toEqual({
        valid: false,
        code: 'VALIDATION_AUDIT_OFFSET_INVALID',
        message: 'offset must be a non-negative integer',
      });
    });

    it('rejects non-finite audit offset', () => {
      expect(validateToolArgumentsSemantics('torque.audit.query', {
        offset: NaN,
      })).toEqual({
        valid: false,
        code: 'VALIDATION_AUDIT_OFFSET_INVALID',
        message: 'offset must be a non-negative integer',
      });
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

    it('accepts audit query with no optional args', () => {
      expect(validateToolArgumentsSemantics('torque.audit.query', {})).toEqual({ valid: true });
    });

    // --- unknown tools pass through as valid ---
    it('returns valid true for unknown tool names', () => {
      expect(validateToolArgumentsSemantics('torque.unknown.tool', {
        anything: 'goes',
      })).toEqual({ valid: true });
    });

    // --- edge: torque.telemetry.summary always passes ---
    it('accepts torque.telemetry.summary with any args', () => {
      expect(validateToolArgumentsSemantics('torque.telemetry.summary', {})).toEqual({ valid: true });
    });
  });
});
