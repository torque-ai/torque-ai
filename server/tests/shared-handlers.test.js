/**
 * Shared Handlers Tests
 *
 * Unit tests for pure validation/utility functions in shared.js.
 * No database or MCP layer required — tests functions directly.
 */

const shared = require('../handlers/shared');

describe('Shared Handlers', () => {
  // ─── escapeRegExp ──────────────────────────────────────────────────────────

  describe('escapeRegExp', () => {
    it('escapes regex special characters', () => {
      expect(shared.escapeRegExp('hello.world')).toBe('hello\\.world');
      expect(shared.escapeRegExp('a+b*c?')).toBe('a\\+b\\*c\\?');
      expect(shared.escapeRegExp('foo[bar]')).toBe('foo\\[bar\\]');
    });

    it('returns unmodified string without special chars', () => {
      expect(shared.escapeRegExp('hello')).toBe('hello');
    });

    it('handles empty string', () => {
      expect(shared.escapeRegExp('')).toBe('');
    });
  });

  // ─── isValidUrl ────────────────────────────────────────────────────────────

  describe('isValidUrl', () => {
    it('returns true for https URL', () => {
      expect(shared.isValidUrl('https://example.com')).toBe(true);
    });

    it('returns true for http URL', () => {
      expect(shared.isValidUrl('http://example.com')).toBe(true);
    });

    it('returns false for ftp URL', () => {
      expect(shared.isValidUrl('ftp://example.com')).toBe(false);
    });

    it('returns false for invalid string', () => {
      expect(shared.isValidUrl('not-a-url')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(shared.isValidUrl('')).toBe(false);
    });
  });

  // ─── isInternalHost ────────────────────────────────────────────────────────

  describe('isInternalHost', () => {
    it('returns true for localhost', () => {
      expect(shared.isInternalHost('http://localhost')).toBe(true);
    });

    it('returns true for 127.0.0.1', () => {
      expect(shared.isInternalHost('http://127.0.0.1')).toBe(true);
    });

    it('returns true for 10.x.x.x (private range)', () => {
      expect(shared.isInternalHost('http://10.0.0.1')).toBe(true);
    });

    it('returns true for 192.168.x.x (private range)', () => {
      expect(shared.isInternalHost('http://192.168.1.1')).toBe(true);
    });

    it('returns true for 172.16-31.x.x (private range)', () => {
      expect(shared.isInternalHost('http://172.16.0.1')).toBe(true);
    });

    it('returns true for metadata.google.internal', () => {
      expect(shared.isInternalHost('http://metadata.google.internal')).toBe(true);
    });

    it('returns true for cloud metadata endpoint', () => {
      expect(shared.isInternalHost('http://169.254.169.254')).toBe(true);
    });

    it('returns true for .localhost subdomain', () => {
      expect(shared.isInternalHost('http://app.localhost')).toBe(true);
    });

    it('returns true for internal. prefix', () => {
      expect(shared.isInternalHost('http://internal.company.com')).toBe(true);
    });

    it('returns false for public domains', () => {
      expect(shared.isInternalHost('https://example.com')).toBe(false);
      expect(shared.isInternalHost('https://github.com')).toBe(false);
    });

    it('returns true for invalid URLs (safe default)', () => {
      expect(shared.isInternalHost('not-a-url')).toBe(true);
    });
  });

  // ─── isValidWebhookUrl ────────────────────────────────────────────────────

  describe('isValidWebhookUrl', () => {
    it('returns valid for HTTPS public URL', () => {
      expect(shared.isValidWebhookUrl('https://hooks.example.com/webhook')).toEqual({ valid: true });
    });

    it('returns invalid for HTTP URL', () => {
      const result = shared.isValidWebhookUrl('http://example.com/webhook');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('HTTPS');
    });

    it('returns invalid for internal host', () => {
      const result = shared.isValidWebhookUrl('https://localhost/webhook');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('internal');
    });

    it('returns invalid for malformed URL', () => {
      const result = shared.isValidWebhookUrl('not-a-url');
      expect(result.valid).toBe(false);
    });
  });

  // ─── isValidRegex ──────────────────────────────────────────────────────────

  describe('isValidRegex', () => {
    it('returns true for valid pattern', () => {
      expect(shared.isValidRegex('\\bfoo\\b')).toBe(true);
    });

    it('returns false for invalid pattern', () => {
      expect(shared.isValidRegex('[')).toBe(false);
    });

    it('returns true for empty string', () => {
      expect(shared.isValidRegex('')).toBe(true);
    });
  });

  // ─── isSafeRegexPattern ────────────────────────────────────────────────────

  describe('isSafeRegexPattern', () => {
    it('returns true for simple pattern', () => {
      expect(shared.isSafeRegexPattern('hello\\s+world')).toBe(true);
    });

    it('returns false for pattern > 200 chars', () => {
      expect(shared.isSafeRegexPattern('a'.repeat(201))).toBe(false);
    });

    it('returns false for non-string', () => {
      expect(shared.isSafeRegexPattern(42)).toBe(false);
      expect(shared.isSafeRegexPattern(null)).toBe(false);
    });

    it('returns false for invalid regex', () => {
      expect(shared.isSafeRegexPattern('[')).toBe(false);
    });
  });

  // ─── safeLimit ─────────────────────────────────────────────────────────────

  describe('safeLimit', () => {
    it('returns default when null', () => {
      expect(shared.safeLimit(null, 20)).toBe(20);
    });

    it('returns default when undefined', () => {
      expect(shared.safeLimit(undefined, 20)).toBe(20);
    });

    it('returns parsed value within range', () => {
      expect(shared.safeLimit(50, 20)).toBe(50);
    });

    it('caps at max value', () => {
      expect(shared.safeLimit(2000, 20, 100)).toBe(100);
    });

    it('returns default for NaN', () => {
      expect(shared.safeLimit('abc', 20)).toBe(20);
    });

    it('returns default for negative values', () => {
      expect(shared.safeLimit(-5, 20)).toBe(20);
    });

    it('returns default for zero', () => {
      expect(shared.safeLimit(0, 20)).toBe(20);
    });
  });

  // ─── safeOffset ────────────────────────────────────────────────────────────

  describe('safeOffset', () => {
    it('returns 0 for null', () => {
      expect(shared.safeOffset(null)).toBe(0);
    });

    it('returns parsed value', () => {
      expect(shared.safeOffset(50)).toBe(50);
    });

    it('caps at max value', () => {
      expect(shared.safeOffset(200000, 100)).toBe(100);
    });

    it('returns 0 for negative', () => {
      expect(shared.safeOffset(-5)).toBe(0);
    });

    it('returns 0 for NaN', () => {
      expect(shared.safeOffset('abc')).toBe(0);
    });
  });

  // ─── isPathTraversalSafe ───────────────────────────────────────────────────

  describe('isPathTraversalSafe', () => {
    it('returns true for normal relative path', () => {
      expect(shared.isPathTraversalSafe('src/index.ts')).toBe(true);
    });

    it('returns false for .. traversal', () => {
      expect(shared.isPathTraversalSafe('../../../etc/passwd')).toBe(false);
    });

    it('returns false for null bytes', () => {
      expect(shared.isPathTraversalSafe('file\x00.txt')).toBe(false);
    });

    it('returns false for non-string', () => {
      expect(shared.isPathTraversalSafe(42)).toBe(false);
      expect(shared.isPathTraversalSafe(null)).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(shared.isPathTraversalSafe('')).toBe(false);
    });

    it('returns false for excessively long path', () => {
      expect(shared.isPathTraversalSafe('a'.repeat(5000))).toBe(false);
    });

    it('validates against allowed base', () => {
      const os = require('os');
      const base = os.tmpdir();
      expect(shared.isPathTraversalSafe('subdir/file.txt', base)).toBe(true);
    });
  });

  // ─── safeDate ──────────────────────────────────────────────────────────────

  describe('safeDate', () => {
    it('returns ISO string for valid date', () => {
      const result = shared.safeDate('2024-01-15');
      expect(result).toBeTruthy();
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('returns null for invalid date string', () => {
      expect(shared.safeDate('not-a-date')).toBeNull();
    });

    it('returns null for year before 2000', () => {
      expect(shared.safeDate('1999-01-01')).toBeNull();
    });

    it('returns null for far-future year', () => {
      expect(shared.safeDate('3000-01-01')).toBeNull();
    });

    it('returns null for empty/null input', () => {
      expect(shared.safeDate('')).toBeNull();
      expect(shared.safeDate(null)).toBeNull();
      expect(shared.safeDate(undefined)).toBeNull();
    });
  });

  // ─── validateObjectDepth ───────────────────────────────────────────────────

  describe('validateObjectDepth', () => {
    it('returns valid for flat object', () => {
      expect(shared.validateObjectDepth({ a: 1, b: 2 })).toEqual({ valid: true });
    });

    it('returns valid for null/undefined', () => {
      expect(shared.validateObjectDepth(null)).toEqual({ valid: true });
      expect(shared.validateObjectDepth(undefined)).toEqual({ valid: true });
    });

    it('returns valid for non-object', () => {
      expect(shared.validateObjectDepth('hello')).toEqual({ valid: true });
      expect(shared.validateObjectDepth(42)).toEqual({ valid: true });
    });

    it('returns invalid for deep nesting', () => {
      let obj = { level: 0 };
      for (let i = 0; i < 15; i++) {
        obj = { nested: obj };
      }
      const result = shared.validateObjectDepth(obj, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('deep');
    });

    it('returns invalid for too many keys', () => {
      const obj = {};
      for (let i = 0; i < 150; i++) {
        obj[`key_${i}`] = i;
      }
      const result = shared.validateObjectDepth(obj, 10, 100);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('keys');
    });
  });

  // ─── validateArtifactMimeType ──────────────────────────────────────────────

  describe('validateArtifactMimeType', () => {
    it('returns valid for safe file', () => {
      const result = shared.validateArtifactMimeType('report.pdf', 'application/pdf');
      expect(result.valid).toBe(true);
    });

    it('returns invalid for blocked extension (.exe)', () => {
      const result = shared.validateArtifactMimeType('malware.exe', 'application/x-msdownload');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('.exe');
    });

    it('returns invalid for blocked extension (.sh)', () => {
      const result = shared.validateArtifactMimeType('script.sh', 'application/x-sh');
      expect(result.valid).toBe(false);
    });

    it('returns invalid for dangerous MIME type', () => {
      const result = shared.validateArtifactMimeType('data.bin', 'application/x-executable');
      expect(result.valid).toBe(false);
    });

    it('returns invalid for malformed MIME type', () => {
      const result = shared.validateArtifactMimeType('file.txt', 'not a valid mime');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('MIME');
    });

    it('returns valid when no MIME type provided', () => {
      const result = shared.validateArtifactMimeType('file.txt', null);
      expect(result.valid).toBe(true);
    });
  });

  // ─── validateEnvVarName ────────────────────────────────────────────────────

  describe('validateEnvVarName', () => {
    it('returns valid for normal name', () => {
      expect(shared.validateEnvVarName('MY_VAR')).toEqual({ valid: true });
    });

    it('returns valid for underscore-prefixed name', () => {
      expect(shared.validateEnvVarName('_PRIVATE')).toEqual({ valid: true });
    });

    it('returns invalid for non-string', () => {
      expect(shared.validateEnvVarName(42).valid).toBe(false);
    });

    it('returns invalid for empty string', () => {
      expect(shared.validateEnvVarName('').valid).toBe(false);
    });

    it('returns invalid for name starting with number', () => {
      expect(shared.validateEnvVarName('1VAR').valid).toBe(false);
    });

    it('returns invalid for name with special chars', () => {
      expect(shared.validateEnvVarName('MY-VAR').valid).toBe(false);
    });

    it('returns invalid for blocked names', () => {
      expect(shared.validateEnvVarName('PATH').valid).toBe(false);
      expect(shared.validateEnvVarName('LD_PRELOAD').valid).toBe(false);
    });
  });

  // ─── checkForControlChars ──────────────────────────────────────────────────

  describe('checkForControlChars', () => {
    it('returns safe for normal string', () => {
      expect(shared.checkForControlChars('hello world')).toEqual({ safe: true });
    });

    it('returns safe for non-string', () => {
      expect(shared.checkForControlChars(42)).toEqual({ safe: true });
    });

    it('returns unsafe for null bytes', () => {
      const result = shared.checkForControlChars('hello\x00world', 'testField');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('null bytes');
    });

    it('returns unsafe for control characters', () => {
      const result = shared.checkForControlChars('hello\x01world', 'testField');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('control characters');
    });

    it('allows common whitespace (tab, newline)', () => {
      expect(shared.checkForControlChars('hello\tworld\n').safe).toBe(true);
    });
  });

  // ─── sanitizeControlChars ──────────────────────────────────────────────────

  describe('sanitizeControlChars', () => {
    it('returns same string if no control chars', () => {
      expect(shared.sanitizeControlChars('hello world')).toBe('hello world');
    });

    it('removes control characters', () => {
      expect(shared.sanitizeControlChars('hello\x00\x01world')).toBe('helloworld');
    });

    it('returns non-string input unchanged', () => {
      expect(shared.sanitizeControlChars(42)).toBe(42);
      expect(shared.sanitizeControlChars(null)).toBeNull();
    });

    it('preserves tab and newline', () => {
      expect(shared.sanitizeControlChars('a\tb\nc')).toBe('a\tb\nc');
    });
  });

  // ─── generateIdempotencyKey ────────────────────────────────────────────────

  describe('generateIdempotencyKey', () => {
    it('returns 32-char hex string', () => {
      const key = shared.generateIdempotencyKey('create', { id: 1 });
      expect(key).toMatch(/^[0-9a-f]{32}$/);
    });

    it('is deterministic (same input same output)', () => {
      const key1 = shared.generateIdempotencyKey('create', { id: 1 });
      const key2 = shared.generateIdempotencyKey('create', { id: 1 });
      expect(key1).toBe(key2);
    });

    it('differs for different inputs', () => {
      const key1 = shared.generateIdempotencyKey('create', { id: 1 });
      const key2 = shared.generateIdempotencyKey('delete', { id: 1 });
      expect(key1).not.toBe(key2);
    });
  });

  // ─── checkIdempotency / storeIdempotencyResult ─────────────────────────────

  describe('idempotency cache', () => {
    it('returns null for unknown key', () => {
      expect(shared.checkIdempotency('unknown_key_xyz_' + Date.now())).toBeNull();
    });

    it('returns stored result', () => {
      const key = 'test_key_' + Date.now();
      const result = { success: true };
      shared.storeIdempotencyResult(key, result);
      expect(shared.checkIdempotency(key)).toEqual(result);
    });
  });

  // ─── validationError ───────────────────────────────────────────────────────

  describe('validationError', () => {
    it('returns error object with message', () => {
      const result = shared.validationError('field', 'is required');
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('is required');
    });

    it('includes hint when provided', () => {
      const result = shared.validationError('field', 'is required', 'Provide a value');
      expect(result.content[0].text).toContain('Hint: Provide a value');
    });

    it('includes example when provided', () => {
      const result = shared.validationError('field', 'is required', null, '"hello"');
      expect(result.content[0].text).toContain('Example: "hello"');
    });

    it('includes both hint and example', () => {
      const result = shared.validationError('field', 'bad', 'Fix it', '"good"');
      expect(result.content[0].text).toContain('Hint: Fix it');
      expect(result.content[0].text).toContain('Example: "good"');
    });
  });

  // ─── requireString ─────────────────────────────────────────────────────────

  describe('requireString', () => {
    it('returns null for valid non-empty string', () => {
      expect(shared.requireString({ name: 'hello' }, 'name')).toBeNull();
    });

    it('returns error for missing field', () => {
      const result = shared.requireString({}, 'name');
      expect(result).not.toBeNull();
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(result.content[0].text).toContain('name');
    });

    it('returns error for empty string', () => {
      const result = shared.requireString({ name: '' }, 'name');
      expect(result).not.toBeNull();
      expect(result.isError).toBe(true);
    });

    it('returns error for whitespace-only string', () => {
      const result = shared.requireString({ name: '   ' }, 'name');
      expect(result).not.toBeNull();
      expect(result.isError).toBe(true);
    });

    it('returns error for non-string value', () => {
      const result = shared.requireString({ name: 42 }, 'name');
      expect(result).not.toBeNull();
      expect(result.isError).toBe(true);
    });

    it('returns error for null value', () => {
      const result = shared.requireString({ name: null }, 'name');
      expect(result).not.toBeNull();
      expect(result.isError).toBe(true);
    });

    it('uses custom label in error message', () => {
      const result = shared.requireString({}, 'name', 'Display Name');
      expect(result.content[0].text).toContain('Display Name');
    });
  });

  // ─── requireArray ─────────────────────────────────────────────────────────

  describe('requireArray', () => {
    it('returns null for valid non-empty array', () => {
      expect(shared.requireArray({ tags: ['a', 'b'] }, 'tags')).toBeNull();
    });

    it('returns error for missing field', () => {
      const result = shared.requireArray({}, 'tags');
      expect(result).not.toBeNull();
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('returns error for empty array', () => {
      const result = shared.requireArray({ tags: [] }, 'tags');
      expect(result).not.toBeNull();
      expect(result.isError).toBe(true);
    });

    it('returns error for non-array value', () => {
      const result = shared.requireArray({ tags: 'not-array' }, 'tags');
      expect(result).not.toBeNull();
      expect(result.isError).toBe(true);
    });

    it('returns error for null value', () => {
      const result = shared.requireArray({ tags: null }, 'tags');
      expect(result).not.toBeNull();
      expect(result.isError).toBe(true);
    });

    it('uses custom label in error message', () => {
      const result = shared.requireArray({}, 'tags', 'Tag List');
      expect(result.content[0].text).toContain('Tag List');
    });
  });

  // ─── requireEnum ──────────────────────────────────────────────────────────

  describe('requireEnum', () => {
    const allowed = ['red', 'green', 'blue'];

    it('returns null for valid value', () => {
      expect(shared.requireEnum({ color: 'red' }, 'color', allowed)).toBeNull();
    });

    it('returns error for invalid value', () => {
      const result = shared.requireEnum({ color: 'yellow' }, 'color', allowed);
      expect(result).not.toBeNull();
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(result.content[0].text).toContain('red');
      expect(result.content[0].text).toContain('green');
      expect(result.content[0].text).toContain('blue');
    });

    it('returns error for missing field', () => {
      const result = shared.requireEnum({}, 'color', allowed);
      expect(result).not.toBeNull();
      expect(result.isError).toBe(true);
    });

    it('returns error for null value', () => {
      const result = shared.requireEnum({ color: null }, 'color', allowed);
      expect(result).not.toBeNull();
      expect(result.isError).toBe(true);
    });

    it('uses custom label in error message', () => {
      const result = shared.requireEnum({}, 'color', allowed, 'Preferred Color');
      expect(result.content[0].text).toContain('Preferred Color');
    });
  });

  // ─── requirePositiveInt ───────────────────────────────────────────────────

  describe('requirePositiveInt', () => {
    it('returns null for positive integer', () => {
      expect(shared.requirePositiveInt({ count: 5 }, 'count')).toBeNull();
    });

    it('returns null for 1', () => {
      expect(shared.requirePositiveInt({ count: 1 }, 'count')).toBeNull();
    });

    it('returns error for 0', () => {
      const result = shared.requirePositiveInt({ count: 0 }, 'count');
      expect(result).not.toBeNull();
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
    });

    it('returns error for negative integer', () => {
      const result = shared.requirePositiveInt({ count: -3 }, 'count');
      expect(result).not.toBeNull();
      expect(result.isError).toBe(true);
    });

    it('returns error for non-integer number', () => {
      const result = shared.requirePositiveInt({ count: 3.5 }, 'count');
      expect(result).not.toBeNull();
      expect(result.isError).toBe(true);
    });

    it('returns error for string value', () => {
      const result = shared.requirePositiveInt({ count: '5' }, 'count');
      expect(result).not.toBeNull();
      expect(result.isError).toBe(true);
    });

    it('returns error for missing field', () => {
      const result = shared.requirePositiveInt({}, 'count');
      expect(result).not.toBeNull();
      expect(result.isError).toBe(true);
    });

    it('returns error for null value', () => {
      const result = shared.requirePositiveInt({ count: null }, 'count');
      expect(result).not.toBeNull();
      expect(result.isError).toBe(true);
    });

    it('uses custom label in error message', () => {
      const result = shared.requirePositiveInt({}, 'count', 'Item Count');
      expect(result.content[0].text).toContain('Item Count');
    });
  });

  // ─── optionalString ───────────────────────────────────────────────────────

  describe('optionalString', () => {
    it('returns null when field is absent', () => {
      expect(shared.optionalString({}, 'notes')).toBeNull();
    });

    it('returns null when field is undefined', () => {
      expect(shared.optionalString({ notes: undefined }, 'notes')).toBeNull();
    });

    it('returns null when field is null', () => {
      expect(shared.optionalString({ notes: null }, 'notes')).toBeNull();
    });

    it('returns null when field is a string', () => {
      expect(shared.optionalString({ notes: 'hello' }, 'notes')).toBeNull();
    });

    it('returns null when field is an empty string', () => {
      expect(shared.optionalString({ notes: '' }, 'notes')).toBeNull();
    });

    it('returns error when field is a number', () => {
      const result = shared.optionalString({ notes: 42 }, 'notes');
      expect(result).not.toBeNull();
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
    });

    it('returns error when field is an array', () => {
      const result = shared.optionalString({ notes: ['a'] }, 'notes');
      expect(result).not.toBeNull();
      expect(result.isError).toBe(true);
    });

    it('uses custom label in error message', () => {
      const result = shared.optionalString({ notes: 42 }, 'notes', 'Additional Notes');
      expect(result.content[0].text).toContain('Additional Notes');
    });
  });

  // ─── Constants ─────────────────────────────────────────────────────────────

  describe('constants', () => {
    it('exports expected validation constants', () => {
      expect(shared.MAX_NAME_LENGTH).toBe(100);
      expect(shared.MAX_TASK_LENGTH).toBe(50000);
      expect(shared.MAX_URL_LENGTH).toBe(2048);
      expect(shared.MAX_BATCH_SIZE).toBe(100);
      expect(shared.MAX_LIMIT).toBe(1000);
      expect(shared.MAX_OFFSET).toBe(100000);
    });

    it('exports webhook event types', () => {
      expect(shared.VALID_WEBHOOK_EVENTS).toContain('completed');
      expect(shared.VALID_WEBHOOK_EVENTS).toContain('failed');
      expect(shared.VALID_WEBHOOK_EVENTS).toContain('started');
    });

    it('exports blocked artifact extensions', () => {
      expect(shared.BLOCKED_ARTIFACT_EXTENSIONS.has('.exe')).toBe(true);
      expect(shared.BLOCKED_ARTIFACT_EXTENSIONS.has('.sh')).toBe(true);
      expect(shared.BLOCKED_ARTIFACT_EXTENSIONS.has('.txt')).toBe(false);
    });

    it('exports VALIDATION_HINTS', () => {
      expect(shared.VALIDATION_HINTS.task).toBeDefined();
      expect(shared.VALIDATION_HINTS.url).toBeDefined();
    });
  });
});
