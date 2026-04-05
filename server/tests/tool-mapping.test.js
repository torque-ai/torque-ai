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
  });

  describe('validateToolArgumentsSemantics', () => {
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
  });
});
