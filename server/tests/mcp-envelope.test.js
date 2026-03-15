'use strict';

const { createCorrelationId, okEnvelope, errorEnvelope } = require('../mcp/envelope');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('mcp/envelope', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('createCorrelationId', () => {
    it('returns a unique UUID string on each call', () => {
      const ids = [
        createCorrelationId(),
        createCorrelationId(),
        createCorrelationId(),
      ];

      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) {
        expect(typeof id).toBe('string');
        expect(id).toMatch(UUID_PATTERN);
      }
    });
  });

  describe('okEnvelope', () => {
    it('wraps data with metadata including timestamp and correlation id', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-11T12:34:56.789Z'));

      const result = okEnvelope({ tool: 'status', ok: true }, {
        correlation_id: 'corr-123',
        request_id: 'req-123',
      });

      expect(result).toEqual({
        ok: true,
        data: { tool: 'status', ok: true },
        metadata: {
          schema_version: 'v1',
          tool_version: 'v1',
          timestamp: '2026-03-11T12:34:56.789Z',
          correlation_id: 'corr-123',
          request_id: 'req-123',
        },
      });
    });
  });

  describe('errorEnvelope', () => {
    it('wraps the error payload with isError, timestamp, and correlation id metadata', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-11T12:35:00.000Z'));

      const result = errorEnvelope({
        code: 'BAD_INPUT',
        message: 'Invalid tool arguments',
        retryable: true,
        details: { field: 'tool' },
      }, {
        correlation_id: 'corr-456',
      });

      expect(result).toEqual({
        ok: false,
        isError: true,
        error: {
          code: 'BAD_INPUT',
          message: 'Invalid tool arguments',
          retryable: true,
          details: { field: 'tool' },
        },
        metadata: {
          schema_version: 'v1',
          tool_version: 'v1',
          timestamp: '2026-03-11T12:35:00.000Z',
          correlation_id: 'corr-456',
        },
      });
    });

    it('normalizes missing error fields to safe defaults', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-11T12:35:10.000Z'));

      const result = errorEnvelope(null, {
        correlation_id: 'corr-789',
      });

      expect(result).toEqual({
        ok: false,
        isError: true,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Unknown error',
          retryable: false,
          details: null,
        },
        metadata: {
          schema_version: 'v1',
          tool_version: 'v1',
          timestamp: '2026-03-11T12:35:10.000Z',
          correlation_id: 'corr-789',
        },
      });
    });
  });
});
