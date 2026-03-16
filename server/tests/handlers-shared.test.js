import { beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { createServer } from 'node:http';

const mockDb = vi.hoisted(() => ({
  getTask: vi.fn(),
  getWorkflow: vi.fn(),
  isCodexExhausted: vi.fn(),
  hasHealthyOllamaHost: vi.fn(),
}));

vi.mock('../database', () => mockDb);

import * as database from '../database';
import shared from '../handlers/shared';

function getText(result) {
  return result?.content?.[0]?.text ?? '';
}

function expectError(result, errorCode, textFragment) {
  expect(result).toMatchObject({
    isError: true,
    error_code: errorCode,
  });

  if (textFragment) {
    expect(getText(result)).toContain(textFragment);
  }
}

function makeNestedObject(depth) {
  const root = {};
  let current = root;
  for (let i = 0; i < depth; i += 1) {
    current.child = {};
    current = current.child;
  }
  return root;
}

async function startHttpServer(handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
  };
}

async function closeServer(server) {
  if (!server) {
    return;
  }

  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

beforeEach(() => {
  vi.useRealTimers();

  database.getTask.mockReset();
  database.getWorkflow.mockReset();
  database.isCodexExhausted.mockReset();
  database.hasHealthyOllamaHost.mockReset();

  database.isCodexExhausted.mockReturnValue(false);
  database.hasHealthyOllamaHost.mockReturnValue(true);
});

describe('handlers/shared.js utilities', () => {
  describe('escapeRegExp', () => {
    it('escapes regex metacharacters', () => {
      expect(shared.escapeRegExp('a+b*c?.[test]')).toBe('a\\+b\\*c\\?\\.\\[test\\]');
    });

    it('leaves plain strings unchanged', () => {
      expect(shared.escapeRegExp('alpha123')).toBe('alpha123');
    });
  });

  describe('isValidUrl', () => {
    it('accepts http and https URLs', () => {
      expect(shared.isValidUrl('http://example.com')).toBe(true);
      expect(shared.isValidUrl('https://example.com/path?q=1')).toBe(true);
    });

    it('rejects unsupported protocols', () => {
      expect(shared.isValidUrl('ftp://example.com')).toBe(false);
    });

    it('rejects malformed URLs', () => {
      expect(shared.isValidUrl('not-a-url')).toBe(false);
      expect(shared.isValidUrl('')).toBe(false);
    });
  });

  describe('isInternalHost', () => {
    it('treats localhost hosts as internal', () => {
      expect(shared.isInternalHost('http://localhost:11434')).toBe(true);
      expect(shared.isInternalHost('http://service.localhost')).toBe(true);
    });

    it('treats private IPv4 ranges as internal', () => {
      expect(shared.isInternalHost('http://10.0.0.5')).toBe(true);
      expect(shared.isInternalHost('http://172.20.1.8')).toBe(true);
      expect(shared.isInternalHost('http://192.168.10.20')).toBe(true);
    });

    it('treats cloud metadata hosts as internal', () => {
      expect(shared.isInternalHost('http://169.254.169.254')).toBe(true);
      expect(shared.isInternalHost('http://metadata.google.internal')).toBe(true);
    });

    it('treats obvious public domains as external', () => {
      expect(shared.isInternalHost('https://example.com')).toBe(false);
    });

    it('defaults malformed URLs to internal for safety', () => {
      expect(shared.isInternalHost('not-a-url')).toBe(true);
    });
  });

  describe('isValidWebhookUrl', () => {
    it('accepts public https webhook URLs', () => {
      expect(shared.isValidWebhookUrl('https://hooks.example.com/incoming')).toEqual({ valid: true });
    });

    it('rejects non-https webhook URLs', () => {
      expect(shared.isValidWebhookUrl('http://hooks.example.com/incoming')).toEqual({
        valid: false,
        reason: 'Webhook URL must use HTTPS for security',
      });
    });

    it('rejects internal hosts even when using https', () => {
      expect(shared.isValidWebhookUrl('https://localhost/incoming')).toEqual({
        valid: false,
        reason: 'Webhook URL cannot point to internal or private hosts',
      });
    });

    it('rejects malformed URLs', () => {
      expect(shared.isValidWebhookUrl('definitely not a url')).toEqual({
        valid: false,
        reason: 'Invalid URL format or protocol',
      });
    });
  });

  describe('isValidRegex', () => {
    it('accepts valid regex patterns', () => {
      expect(shared.isValidRegex('^task-[0-9]+$')).toBe(true);
    });

    it('rejects invalid regex patterns', () => {
      expect(shared.isValidRegex('[')).toBe(false);
    });
  });

  describe('isSafeRegexPattern', () => {
    it('accepts simple valid patterns', () => {
      expect(shared.isSafeRegexPattern('error\\s+count:\\s+\\d+')).toBe(true);
    });

    it('rejects nested quantifier patterns', () => {
      expect(shared.isSafeRegexPattern('(a+)+$')).toBe(false);
    });

    it('rejects excessively long patterns', () => {
      expect(shared.isSafeRegexPattern('a'.repeat(201))).toBe(false);
    });

    it('rejects invalid regex syntax', () => {
      expect(shared.isSafeRegexPattern('(')).toBe(false);
    });
  });

  describe('safeLimit', () => {
    it('returns the bounded default for nullish values', () => {
      expect(shared.safeLimit(undefined, 200, 100)).toBe(100);
      expect(shared.safeLimit(null, 25, 100)).toBe(25);
    });

    it('parses numeric input within range', () => {
      expect(shared.safeLimit('42', 10, 100)).toBe(42);
    });

    it('clamps values above the maximum', () => {
      expect(shared.safeLimit(5000, 10, 100)).toBe(100);
    });

    it('falls back to default for invalid or unsafe values', () => {
      expect(shared.safeLimit('abc', 10, 100)).toBe(10);
      expect(shared.safeLimit(-1, 10, 100)).toBe(10);
      expect(shared.safeLimit('9007199254740992', 10, 100)).toBe(10);
    });
  });

  describe('safeOffset', () => {
    it('returns zero for nullish input', () => {
      expect(shared.safeOffset(undefined)).toBe(0);
      expect(shared.safeOffset(null)).toBe(0);
    });

    it('parses numeric input within range', () => {
      expect(shared.safeOffset('24', 100)).toBe(24);
    });

    it('clamps values above the maximum', () => {
      expect(shared.safeOffset(1000, 50)).toBe(50);
    });

    it('returns zero for invalid or unsafe values', () => {
      expect(shared.safeOffset('abc', 100)).toBe(0);
      expect(shared.safeOffset(-5, 100)).toBe(0);
      expect(shared.safeOffset('9007199254740992', 100)).toBe(0);
    });
  });

  describe('isPathTraversalSafe', () => {
    it('rejects non-string and empty paths', () => {
      expect(shared.isPathTraversalSafe(null)).toBe(false);
      expect(shared.isPathTraversalSafe('')).toBe(false);
    });

    it('rejects paths containing null bytes', () => {
      expect(shared.isPathTraversalSafe('safe\u0000name.txt')).toBe(false);
    });

    it('rejects dot-dot traversal, including URL-encoded traversal', () => {
      expect(shared.isPathTraversalSafe('../secret.txt')).toBe(false);
      expect(shared.isPathTraversalSafe('nested/%2e%2e/secret.txt')).toBe(false);
    });

    it('rejects dangerous absolute system paths', () => {
      expect(shared.isPathTraversalSafe('/etc/passwd')).toBe(false);
      expect(shared.isPathTraversalSafe('/Windows/System32/drivers/etc/hosts')).toBe(false);
    });

    it('allows contained paths inside an allowed base', () => {
      expect(shared.isPathTraversalSafe('nested/file.txt', 'C:/repo/output')).toBe(true);
    });

    it('rejects resolved paths that escape the allowed base', () => {
      expect(shared.isPathTraversalSafe('../escape.txt', 'C:/repo/output')).toBe(false);
    });

    it('tolerates bad URL encoding when the path is otherwise safe', () => {
      expect(shared.isPathTraversalSafe('reports/%zz/log.txt')).toBe(true);
    });
  });

  describe('safeDate', () => {
    it('normalizes valid dates to ISO-8601', () => {
      expect(shared.safeDate('2026-03-12T10:15:30-07:00')).toBe('2026-03-12T17:15:30.000Z');
    });

    it('returns null for missing values', () => {
      expect(shared.safeDate(null)).toBeNull();
      expect(shared.safeDate('')).toBeNull();
    });

    it('returns null for invalid dates', () => {
      expect(shared.safeDate('not-a-date')).toBeNull();
    });

    it('returns null for years outside the supported range', () => {
      expect(shared.safeDate('1999-12-31T23:59:59.000Z')).toBeNull();
      expect(shared.safeDate('2101-06-01T12:00:00.000Z')).toBeNull();
    });
  });

  describe('getWorkflowTaskCounts', () => {
    it('returns zeroed counts for a missing workflow', () => {
      expect(shared.getWorkflowTaskCounts(null)).toEqual({
        total: 0,
        completed: 0,
        failed: 0,
        running: 0,
        blocked: 0,
        pending: 0,
        queued: 0,
        skipped: 0,
        cancelled: 0,
        pending_provider_switch: 0,
        open: 0,
        runnable: 0,
        terminal: 0,
      });
    });

    it('counts status values from a task array', () => {
      expect(
        shared.getWorkflowTaskCounts({
          tasks: [
            { status: 'completed' },
            { status: 'failed' },
            { status: 'running' },
            { status: 'pending' },
            { status: 'queued' },
            { status: 'blocked' },
            { status: 'skipped' },
            { status: 'cancelled' },
            { status: 'pending_provider_switch' },
            { status: 'unknown' },
          ],
        }),
      ).toEqual({
        total: 10,
        completed: 1,
        failed: 1,
        running: 1,
        blocked: 1,
        pending: 1,
        queued: 1,
        skipped: 1,
        cancelled: 1,
        pending_provider_switch: 1,
        open: 5,
        runnable: 4,
        terminal: 4,
      });
    });

    it('counts tasks stored in an object map', () => {
      expect(
        shared.getWorkflowTaskCounts({
          tasks: {
            a: { status: 'completed' },
            b: { status: 'running' },
            c: { status: 'blocked' },
          },
        }),
      ).toEqual({
        total: 3,
        completed: 1,
        failed: 0,
        running: 1,
        blocked: 1,
        pending: 0,
        queued: 0,
        skipped: 0,
        cancelled: 0,
        pending_provider_switch: 0,
        open: 2,
        runnable: 1,
        terminal: 1,
      });
    });

    it('prefers larger summary and legacy values when no task list exists', () => {
      expect(
        shared.getWorkflowTaskCounts({
          summary: {
            pending: '3',
            queued: '2',
            blocked: 1,
            completed: 4,
            cancelled: 1,
          },
          total_tasks: 12,
          failed_tasks: 2,
          skipped_tasks: 1,
        }),
      ).toEqual({
        total: 12,
        completed: 4,
        failed: 2,
        running: 0,
        blocked: 1,
        pending: 3,
        queued: 2,
        skipped: 1,
        cancelled: 1,
        pending_provider_switch: 0,
        open: 6,
        runnable: 5,
        terminal: 8,
      });
    });
  });

  describe('getWorkflowRestartGuardError', () => {
    it('returns null when no workflow is provided', () => {
      expect(shared.getWorkflowRestartGuardError(null)).toBeNull();
    });

    it('returns null when there is no runnable work left', () => {
      expect(
        shared.getWorkflowRestartGuardError({
          id: 'wf-quiet',
          status: 'completed',
          tasks: [{ status: 'blocked' }, { status: 'completed' }],
        }),
      ).toBeNull();
    });

    it('allows a fresh pending start when explicitly enabled', () => {
      expect(
        shared.getWorkflowRestartGuardError(
          {
            id: 'wf-new',
            status: 'pending',
            tasks: [{ status: 'pending' }],
          },
          { allowFreshPendingStart: true },
        ),
      ).toBeNull();
    });

    it('allows paused workflows to resume when explicitly enabled', () => {
      expect(
        shared.getWorkflowRestartGuardError(
          {
            id: 'wf-paused',
            status: 'paused',
            tasks: [{ status: 'pending' }],
          },
          { allowPausedResume: true },
        ),
      ).toBeNull();
    });

    it('returns an invalid status transition error for live runnable work', () => {
      const result = shared.getWorkflowRestartGuardError(
        {
          id: 'wf-live',
          name: 'Deploy',
          status: 'running',
          tasks: [{ status: 'running' }, { status: 'queued' }, { status: 'blocked' }],
        },
        { attemptedAction: 'restart this workflow' },
      );

      expectError(result, shared.ErrorCodes.INVALID_STATUS_TRANSITION.code, 'still has live runnable work');
      expect(getText(result)).toContain("workflow 'Deploy' (wf-live)");
      expect(getText(result)).toContain('1 running, 0 pending, 1 queued');
    });
  });

  describe('evaluateWorkflowVisibility', () => {
    it('marks empty workflows as hygiene issues', () => {
      expect(
        shared.evaluateWorkflowVisibility({ id: 'wf-empty', status: 'running' }),
      ).toMatchObject({
        state: 'hygiene',
        code: 'empty-workflow',
        actionable: false,
      });
    });

    it('flags terminal workflows that still have open tasks', () => {
      expect(
        shared.evaluateWorkflowVisibility({
          id: 'wf-conflict',
          status: 'completed',
          tasks: [{ status: 'pending' }],
        }),
      ).toMatchObject({
        state: 'hygiene',
        code: 'status-conflict',
        actionable: true,
      });
    });

    it('reports blocked-only workflows as hygiene issues', () => {
      expect(
        shared.evaluateWorkflowVisibility({
          id: 'wf-blocked',
          status: 'running',
          tasks: [{ status: 'blocked' }, { status: 'blocked' }],
        }),
      ).toMatchObject({
        state: 'hygiene',
        code: 'blocked-only',
        actionable: false,
      });
    });

    it('reports stale active statuses when all tasks are terminal', () => {
      expect(
        shared.evaluateWorkflowVisibility({
          id: 'wf-stale',
          status: 'pending',
          tasks: [{ status: 'completed' }, { status: 'failed' }],
        }),
      ).toMatchObject({
        state: 'hygiene',
        code: 'stale-active-status',
        actionable: false,
      });
    });

    it('reports paused workflows separately', () => {
      expect(
        shared.evaluateWorkflowVisibility({
          id: 'wf-paused',
          status: 'paused',
          tasks: [{ status: 'pending' }, { status: 'blocked' }],
        }),
      ).toMatchObject({
        state: 'paused',
        code: 'paused',
        actionable: true,
      });
    });

    it('reports active workflows as actionable', () => {
      expect(
        shared.evaluateWorkflowVisibility({
          id: 'wf-active',
          status: 'running',
          tasks: [{ status: 'running' }, { status: 'queued' }, { status: 'blocked' }],
        }),
      ).toMatchObject({
        state: 'actionable',
        code: 'active',
        actionable: true,
      });
    });

    it('reports completed workflows with only terminal tasks as quiet', () => {
      expect(
        shared.evaluateWorkflowVisibility({
          id: 'wf-quiet',
          status: 'completed',
          tasks: [{ status: 'completed' }, { status: 'failed' }, { status: 'cancelled' }],
        }),
      ).toMatchObject({
        state: 'quiet',
        code: 'quiet',
        actionable: false,
      });
    });
  });

  describe('validateObjectDepth', () => {
    it('accepts nullish and primitive values', () => {
      expect(shared.validateObjectDepth(null)).toEqual({ valid: true });
      expect(shared.validateObjectDepth('value')).toEqual({ valid: true });
      expect(shared.validateObjectDepth(42)).toEqual({ valid: true });
    });

    it('accepts objects within the configured depth budget', () => {
      expect(shared.validateObjectDepth({ a: { b: {} } }, 2, 10)).toEqual({ valid: true });
    });

    it('rejects objects that exceed the maximum depth', () => {
      expect(shared.validateObjectDepth(makeNestedObject(3), 2, 10)).toEqual({
        valid: false,
        error: 'Object nesting too deep (max 2 levels)',
      });
    });

    it('rejects objects that exceed the total key budget', () => {
      expect(
        shared.validateObjectDepth({ a: 1, b: 2, c: { d: 3 } }, 10, 3),
      ).toEqual({
        valid: false,
        error: 'Object has too many keys (max 3)',
      });
    });
  });

  describe('validateArtifactMimeType', () => {
    it('rejects blocked executable extensions', () => {
      expect(shared.validateArtifactMimeType('dangerous.exe')).toEqual({
        valid: false,
        reason: "File extension '.exe' is not allowed for security reasons",
      });
    });

    it('rejects invalid MIME type syntax', () => {
      expect(shared.validateArtifactMimeType('report.txt', 'text plain')).toEqual({
        valid: false,
        reason: 'Invalid MIME type format',
      });
    });

    it('rejects dangerous MIME types', () => {
      expect(shared.validateArtifactMimeType('payload.bin', 'application/x-msdownload')).toEqual({
        valid: false,
        reason: 'File type not allowed for security reasons',
      });
    });

    it('accepts safe MIME types', () => {
      expect(shared.validateArtifactMimeType('report.json', 'application/json')).toEqual({
        valid: true,
        mimeType: 'application/json',
      });
    });
  });

  describe('validateEnvVarName', () => {
    it('rejects non-string names', () => {
      expect(shared.validateEnvVarName(42)).toEqual({
        valid: false,
        reason: 'Environment variable name must be a string',
      });
    });

    it('rejects invalid identifier formats', () => {
      expect(shared.validateEnvVarName('1BAD-NAME')).toEqual({
        valid: false,
        reason: 'Environment variable name must start with letter or underscore, contain only alphanumeric and underscore',
      });
    });

    it('rejects blocked names case-insensitively', () => {
      expect(shared.validateEnvVarName('path')).toEqual({
        valid: false,
        reason: "Environment variable 'path' is not allowed for security reasons",
      });
    });

    it('accepts safe names', () => {
      expect(shared.validateEnvVarName('_CUSTOM_FLAG_2')).toEqual({ valid: true });
    });
  });

  describe('checkForControlChars', () => {
    it('treats non-string values as safe', () => {
      expect(shared.checkForControlChars(42)).toEqual({ safe: true });
    });

    it('rejects strings with null bytes', () => {
      expect(shared.checkForControlChars('hello\u0000world', 'payload')).toEqual({
        safe: false,
        reason: 'payload contains null bytes',
      });
    });

    it('rejects strings with other dangerous control characters', () => {
      expect(shared.checkForControlChars('bad\u0007bell', 'payload')).toEqual({
        safe: false,
        reason: 'payload contains dangerous control characters',
      });
    });

    it('accepts printable strings', () => {
      expect(shared.checkForControlChars('ready to ship', 'payload')).toEqual({ safe: true });
    });
  });

  describe('sanitizeControlChars', () => {
    it('removes dangerous control characters from strings', () => {
      expect(shared.sanitizeControlChars('a\u0000b\u0007c\nd')).toBe('abc\nd');
    });

    it('returns non-string values unchanged', () => {
      expect(shared.sanitizeControlChars(null)).toBeNull();
      expect(shared.sanitizeControlChars(5)).toBe(5);
    });
  });

  describe('generateIdempotencyKey', () => {
    it('returns a stable 32-character key for identical inputs', () => {
      const first = shared.generateIdempotencyKey('run', { taskId: 't-1', force: true });
      const second = shared.generateIdempotencyKey('run', { taskId: 't-1', force: true });

      expect(first).toBe(second);
      expect(first).toMatch(/^[a-f0-9]{32}$/);
    });

    it('returns different keys for different inputs', () => {
      expect(
        shared.generateIdempotencyKey('run', { taskId: 't-1' }),
      ).not.toBe(shared.generateIdempotencyKey('run', { taskId: 't-2' }));
    });
  });

  describe('checkIdempotency and storeIdempotencyResult', () => {
    it('returns null for keys that were never stored', () => {
      expect(shared.checkIdempotency(`missing-${Date.now()}`)).toBeNull();
    });

    it('returns stored results inside the idempotency window', () => {
      const key = `stored-${Date.now()}`;
      const result = { ok: true, id: 'abc' };

      shared.storeIdempotencyResult(key, result);

      expect(shared.checkIdempotency(key)).toBe(result);
    });

    it('expires cached results outside the idempotency window', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-12T12:00:00.000Z'));

      const key = 'expired-key';
      shared.storeIdempotencyResult(key, { ok: true });

      vi.advanceTimersByTime(shared.IDEMPOTENCY_WINDOW_MS + 1);

      expect(shared.checkIdempotency(key)).toBeNull();
    });
  });

  describe('validationError', () => {
    it('creates an INVALID_PARAM error response', () => {
      const result = shared.validationError('task', 'Task description is required');

      expectError(result, shared.ErrorCodes.INVALID_PARAM.code, 'Validation Error: Task description is required');
    });

    it('includes optional hint and example text', () => {
      const result = shared.validationError(
        'url',
        'URL is invalid',
        'Use an https URL',
        'https://hooks.example.com/incoming',
      );

      expect(getText(result)).toContain('Hint: Use an https URL');
      expect(getText(result)).toContain('Example: https://hooks.example.com/incoming');
    });
  });

  describe('requireString', () => {
    it('rejects missing or blank strings', () => {
      expectError(
        shared.requireString({}, 'name'),
        shared.ErrorCodes.MISSING_REQUIRED_PARAM.code,
        'name is required and must be a non-empty string',
      );
      expectError(
        shared.requireString({ name: '   ' }, 'name'),
        shared.ErrorCodes.MISSING_REQUIRED_PARAM.code,
        'name is required and must be a non-empty string',
      );
    });

    it('accepts non-empty strings', () => {
      expect(shared.requireString({ name: 'alpha' }, 'name')).toBeNull();
    });
  });

  describe('requireArray', () => {
    it('rejects missing, non-array, or empty values', () => {
      expectError(
        shared.requireArray({}, 'items'),
        shared.ErrorCodes.MISSING_REQUIRED_PARAM.code,
        'items is required and must be a non-empty array',
      );
      expectError(
        shared.requireArray({ items: 'wrong' }, 'items'),
        shared.ErrorCodes.MISSING_REQUIRED_PARAM.code,
        'items is required and must be a non-empty array',
      );
      expectError(
        shared.requireArray({ items: [] }, 'items'),
        shared.ErrorCodes.MISSING_REQUIRED_PARAM.code,
        'items is required and must be a non-empty array',
      );
    });

    it('accepts non-empty arrays', () => {
      expect(shared.requireArray({ items: ['a'] }, 'items')).toBeNull();
    });
  });

  describe('requireEnum', () => {
    it('rejects values outside the allowlist', () => {
      expectError(
        shared.requireEnum({ mode: 'maybe' }, 'mode', ['on', 'off'], 'Mode'),
        shared.ErrorCodes.INVALID_PARAM.code,
        'Mode must be one of: on, off',
      );
    });

    it('accepts allowed values', () => {
      expect(shared.requireEnum({ mode: 'on' }, 'mode', ['on', 'off'])).toBeNull();
    });
  });

  describe('requirePositiveInt', () => {
    it('rejects null, zero, fractional, and string values', () => {
      expectError(
        shared.requirePositiveInt({ retries: null }, 'retries'),
        shared.ErrorCodes.INVALID_PARAM.code,
        'retries must be a positive integer',
      );
      expectError(
        shared.requirePositiveInt({ retries: 0 }, 'retries'),
        shared.ErrorCodes.INVALID_PARAM.code,
        'retries must be a positive integer',
      );
      expectError(
        shared.requirePositiveInt({ retries: 1.5 }, 'retries'),
        shared.ErrorCodes.INVALID_PARAM.code,
        'retries must be a positive integer',
      );
      expectError(
        shared.requirePositiveInt({ retries: '2' }, 'retries'),
        shared.ErrorCodes.INVALID_PARAM.code,
        'retries must be a positive integer',
      );
    });

    it('accepts positive integers', () => {
      expect(shared.requirePositiveInt({ retries: 3 }, 'retries')).toBeNull();
    });
  });

  describe('optionalString', () => {
    it('accepts missing, null, and string values', () => {
      expect(shared.optionalString({}, 'note')).toBeNull();
      expect(shared.optionalString({ note: null }, 'note')).toBeNull();
      expect(shared.optionalString({ note: '' }, 'note')).toBeNull();
      expect(shared.optionalString({ note: 'ready' }, 'note')).toBeNull();
    });

    it('rejects non-string values', () => {
      expectError(
        shared.optionalString({ note: 42 }, 'note', 'Note'),
        shared.ErrorCodes.INVALID_PARAM.code,
        'Note must be a string',
      );
    });
  });

  describe('requireTask', () => {
    it('returns a missing-parameter error when no task id is provided', () => {
      const result = shared.requireTask(database, '');

      expectError(result.error, shared.ErrorCodes.MISSING_REQUIRED_PARAM.code, 'task_id is required');
      expect(database.getTask).not.toHaveBeenCalled();
    });

    it('returns a task-not-found error when the task does not exist', () => {
      database.getTask.mockReturnValue(null);

      const result = shared.requireTask(database, 'task-404');

      expect(database.getTask).toHaveBeenCalledWith('task-404');
      expectError(result.error, shared.ErrorCodes.TASK_NOT_FOUND.code, 'Task not found: task-404');
    });

    it('returns the task when it exists', () => {
      const task = { id: 'task-1', status: 'running' };
      database.getTask.mockReturnValue(task);

      expect(shared.requireTask(database, 'task-1')).toEqual({ task });
    });
  });

  describe('requireWorkflow', () => {
    it('returns a missing-parameter error when no workflow id is provided', () => {
      const result = shared.requireWorkflow(database, '');

      expectError(result.error, shared.ErrorCodes.MISSING_REQUIRED_PARAM.code, 'workflow_id is required');
      expect(database.getWorkflow).not.toHaveBeenCalled();
    });

    it('returns a workflow-not-found error when the workflow does not exist', () => {
      database.getWorkflow.mockReturnValue(null);

      const result = shared.requireWorkflow(database, 'wf-404');

      expect(database.getWorkflow).toHaveBeenCalledWith('wf-404');
      expectError(result.error, shared.ErrorCodes.WORKFLOW_NOT_FOUND.code, 'Workflow not found: wf-404');
    });

    it('returns the workflow when it exists', () => {
      const workflow = { id: 'wf-1', status: 'running' };
      database.getWorkflow.mockReturnValue(workflow);

      expect(shared.requireWorkflow(database, 'wf-1')).toEqual({ workflow });
    });
  });

  describe('buildMarkdownTable', () => {
    it('builds a markdown table with headers and rows', () => {
      expect(
        shared.buildMarkdownTable(
          ['Task', 'Status'],
          [['task-1', 'running'], ['task-2', 'completed']],
        ),
      ).toBe(
        '| Task | Status |\n'
        + '| --- | --- |\n'
        + '| task-1 | running |\n'
        + '| task-2 | completed |\n',
      );
    });

    it('builds a header-only table when there are no rows', () => {
      expect(shared.buildMarkdownTable(['Name'], [])).toBe(
        '| Name |\n'
        + '| --- |\n',
      );
    });

    it('joins row values as-is for ragged row shapes', () => {
      expect(
        shared.buildMarkdownTable(['A', 'B'], [['one'], ['two', 'three', 'four']]),
      ).toBe(
        '| A | B |\n'
        + '| --- | --- |\n'
        + '| one |\n'
        + '| two | three | four |\n',
      );
    });
  });

  describe('formatTime', () => {
    it('returns N/A for missing timestamps', () => {
      expect(shared.formatTime(null)).toBe('N/A');
    });

    it('formats timestamps in local time', () => {
      const iso = '2026-03-12T18:45:00.000Z';

      expect(shared.formatTime(iso)).toBe(
        new Date(iso).toLocaleString('en-US'),
      );
    });
  });

  describe('checkProviderAvailability', () => {
    it('bypasses availability checks when an explicit provider is supplied', () => {
      expect(
        shared.checkProviderAvailability(database, { hasExplicitProvider: true }),
      ).toBeNull();
      expect(database.isCodexExhausted).not.toHaveBeenCalled();
      expect(database.hasHealthyOllamaHost).not.toHaveBeenCalled();
    });

    it('returns null when at least one provider path is available', () => {
      database.isCodexExhausted.mockReturnValue(false);
      database.hasHealthyOllamaHost.mockReturnValue(false);

      expect(shared.checkProviderAvailability(database)).toBeNull();
    });

    it('returns a NO_HOSTS_AVAILABLE error when codex is exhausted and Ollama is offline', () => {
      database.isCodexExhausted.mockReturnValue(true);
      database.hasHealthyOllamaHost.mockReturnValue(false);

      const result = shared.checkProviderAvailability(database);

      expect(result).toBeTruthy();
      expectError(result.error, shared.ErrorCodes.NO_HOSTS_AVAILABLE.code, 'No providers available');
    });
  });

  describe('probeOllamaEndpoint', () => {
    it('returns a structured invalid-url error for malformed host URLs', async () => {
      const result = await shared.probeOllamaEndpoint('not-a-url', 50);

      expect(result).toMatchObject({
        ok: false,
        models: [],
        latencyMs: 0,
      });
      expect(result.error).toContain('Invalid URL');
    });

    it('returns models from a healthy /api/tags response', async () => {
      let server;

      try {
        const started = await startHttpServer((req, res) => {
          expect(req.url).toBe('/api/tags');
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ models: [{ name: 'llama3.2' }] }));
        });
        server = started.server;

        const result = await shared.probeOllamaEndpoint(started.url, 250);

        expect(result.ok).toBe(true);
        expect(result.models).toEqual([{ name: 'llama3.2' }]);
        expect(result.error).toBeNull();
        expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      } finally {
        await closeServer(server);
      }
    });

    it('returns an HTTP error when the probe receives a non-200 response', async () => {
      let server;

      try {
        const started = await startHttpServer((_req, res) => {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'unavailable' }));
        });
        server = started.server;

        const result = await shared.probeOllamaEndpoint(started.url, 250);

        expect(result.ok).toBe(false);
        expect(result.models).toEqual([]);
        expect(result.error).toBe('HTTP 503');
      } finally {
        await closeServer(server);
      }
    });

    it('returns an invalid-json error when /api/tags returns malformed JSON', async () => {
      let server;

      try {
        const started = await startHttpServer((_req, res) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{not-json');
        });
        server = started.server;

        const result = await shared.probeOllamaEndpoint(started.url, 250);

        expect(result.ok).toBe(false);
        expect(result.models).toEqual([]);
        expect(result.error).toContain('Invalid JSON from /api/tags');
      } finally {
        await closeServer(server);
      }
    });

    it('returns a timeout error when the endpoint does not respond in time', async () => {
      let server;

      try {
        const started = await startHttpServer((_req, res) => {
          setTimeout(() => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ models: [] }));
          }, 50);
        });
        server = started.server;

        const result = await shared.probeOllamaEndpoint(started.url, 10);

        expect(result.ok).toBe(false);
        expect(result.models).toEqual([]);
        expect(result.error).toBe('Timed out after 10ms');
      } finally {
        await closeServer(server);
      }
    });
  });
});
