const fs = require('fs');
const path = require('path');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const shared = require('../handlers/shared');

function getText(result) {
  return result?.content?.[0]?.text || '';
}

function collectJavaScriptFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJavaScriptFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }
  return files;
}

function stripCommentsPreservingLines(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\r\n]/g, ''))
    .replace(/\/\/.*$/gm, '');
}

describe('handler:shared', () => {
  beforeAll(() => {
    setupTestDbOnly('handler-shared');
  });

  afterAll(() => {
    teardownTestDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('handler database import guard', () => {
    it('keeps handler modules from importing database.js directly', () => {
      const handlersDir = path.resolve(__dirname, '../handlers');
      const allowedSharedResolver = path.join(handlersDir, 'shared.js');
      const directDatabaseImportPattern = new RegExp([
        String.raw`\b(?:require|import)\s*\(\s*['"](?:\.\.[/\\])+database(?:\.js)?['"]\s*\)`,
        String.raw`\b(?:from|import)\s*['"](?:\.\.[/\\])+database(?:\.js)?['"]`
      ].join('|'));
      const violations = [];

      for (const filePath of collectJavaScriptFiles(handlersDir)) {
        if (filePath === allowedSharedResolver) {
          continue;
        }

        const source = stripCommentsPreservingLines(fs.readFileSync(filePath, 'utf8'));
        const lines = source.split(/\r?\n/);
        lines.forEach((line, index) => {
          if (directDatabaseImportPattern.test(line)) {
            const relativePath = path.relative(process.cwd(), filePath);
            violations.push(`${relativePath}:${index + 1}: ${line.trim()}`);
          }
        });
      }

      expect(violations).toEqual([]);
    });
  });

  describe('validation helpers', () => {
    it('requireString rejects missing fields', () => {
      const result = shared.requireString({}, 'name');

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe(shared.ErrorCodes.MISSING_REQUIRED_PARAM.code);
      expect(getText(result)).toContain('name is required and must be a non-empty string');
    });

    it('requireString rejects whitespace-only strings', () => {
      const result = shared.requireString({ name: '   ' }, 'name');

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe(shared.ErrorCodes.MISSING_REQUIRED_PARAM.code);
    });

    it('requireString accepts trimmed non-empty strings', () => {
      expect(shared.requireString({ name: '  alpha  ' }, 'name')).toBeNull();
    });

    it('requireString uses the custom label in errors', () => {
      const result = shared.requireString({ name: '' }, 'name', 'Task Name');

      expect(getText(result)).toContain('Task Name is required');
    });

    it('requireArray rejects missing, non-array, and empty values', () => {
      const missing = shared.requireArray({}, 'tags');
      const wrongType = shared.requireArray({ tags: 'alpha' }, 'tags');
      const empty = shared.requireArray({ tags: [] }, 'tags');

      expect(missing.error_code).toBe(shared.ErrorCodes.MISSING_REQUIRED_PARAM.code);
      expect(wrongType.error_code).toBe(shared.ErrorCodes.MISSING_REQUIRED_PARAM.code);
      expect(empty.error_code).toBe(shared.ErrorCodes.MISSING_REQUIRED_PARAM.code);
    });

    it('requireArray accepts non-empty arrays', () => {
      expect(shared.requireArray({ tags: ['alpha'] }, 'tags')).toBeNull();
    });

    it('requireEnum rejects missing values', () => {
      const result = shared.requireEnum({}, 'mode', ['on', 'off']);

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe(shared.ErrorCodes.INVALID_PARAM.code);
    });

    it('requireEnum rejects values outside the allowlist', () => {
      const result = shared.requireEnum({ mode: 'maybe' }, 'mode', ['on', 'off'], 'Mode');

      expect(result.error_code).toBe(shared.ErrorCodes.INVALID_PARAM.code);
      expect(getText(result)).toContain('Mode must be one of: on, off');
    });

    it('requireEnum accepts allowed values', () => {
      expect(shared.requireEnum({ mode: 'on' }, 'mode', ['on', 'off'])).toBeNull();
    });

    it('requirePositiveInt rejects null, zero, fractional, and string values', () => {
      const invalidValues = [null, 0, 2.5, '3'];

      for (const retries of invalidValues) {
        const result = shared.requirePositiveInt({ retries }, 'retries');
        expect(result.error_code).toBe(shared.ErrorCodes.INVALID_PARAM.code);
      }
    });

    it('requirePositiveInt accepts positive integer boundaries', () => {
      expect(shared.requirePositiveInt({ retries: 1 }, 'retries')).toBeNull();
    });

    it('optionalString accepts undefined, null, empty, and non-empty strings', () => {
      expect(shared.optionalString({}, 'note')).toBeNull();
      expect(shared.optionalString({ note: null }, 'note')).toBeNull();
      expect(shared.optionalString({ note: '' }, 'note')).toBeNull();
      expect(shared.optionalString({ note: 'ready' }, 'note')).toBeNull();
    });

    it('optionalString rejects non-string values and uses the custom label', () => {
      const result = shared.optionalString({ note: 42 }, 'note', 'Task Note');

      expect(result.error_code).toBe(shared.ErrorCodes.INVALID_PARAM.code);
      expect(getText(result)).toContain('Task Note must be a string');
    });
  });

  describe('ErrorCodes and makeError', () => {
    it('makeError formats structured error objects with recovery and details', () => {
      const result = shared.makeError(shared.ErrorCodes.INVALID_PARAM, 'bad field', { field: 'mode' });
      const text = getText(result);

      expect(result).toMatchObject({
        isError: true,
        error_code: 'INVALID_PARAM'
      });
      expect(text).toContain('INVALID_PARAM: bad field');
      expect(text).toContain('Recovery:');
      expect(text).toContain('"field":"mode"');
    });

    it('makeError supports raw string error codes without a recovery section', () => {
      const result = shared.makeError('CUSTOM_ERROR', 'plain failure');
      const text = getText(result);

      expect(result.error_code).toBe('CUSTOM_ERROR');
      expect(text).toContain('CUSTOM_ERROR: plain failure');
      expect(text).not.toContain('Recovery:');
    });

    it('makeError falls back to the error-code message when detail is omitted', () => {
      const result = shared.makeError(shared.ErrorCodes.INVALID_PARAM);

      expect(getText(result)).toContain('INVALID_PARAM: Invalid parameter');
    });
  });

  describe('getWorkflowTaskCounts', () => {
    it('returns zeroed counts for null workflows', () => {
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
        terminal: 0
      });
    });

    it('counts task arrays and derives open, runnable, and terminal totals', () => {
      const counts = shared.getWorkflowTaskCounts({
        tasks: [
          { status: 'completed' },
          { status: 'failed' },
          { status: 'running' },
          { status: 'pending' },
          { status: 'queued' },
          { status: 'blocked' },
          { status: 'skipped' },
          { status: 'cancelled' },
          { status: 'unknown' }
        ]
      });

      expect(counts).toMatchObject({
        total: 9,
        completed: 1,
        failed: 1,
        running: 1,
        pending: 1,
        queued: 1,
        blocked: 1,
        skipped: 1,
        cancelled: 1,
        open: 4,
        runnable: 3,
        terminal: 4
      });
    });

    it('counts tasks stored in object maps', () => {
      const counts = shared.getWorkflowTaskCounts({
        tasks: {
          a: { status: 'completed' },
          b: { status: 'running' }
        }
      });

      expect(counts).toMatchObject({
        total: 2,
        completed: 1,
        running: 1,
        open: 1,
        runnable: 1,
        terminal: 1
      });
    });

    it('prefers larger summary counts over task-derived counts', () => {
      const counts = shared.getWorkflowTaskCounts({
        summary: {
          total: 10,
          completed: 5,
          failed: 3,
          pending: 2,
          queued: 1,
          blocked: 4
        },
        tasks: [
          { status: 'completed' },
          { status: 'failed' }
        ]
      });

      expect(counts).toMatchObject({
        total: 10,
        completed: 5,
        failed: 3,
        pending: 2,
        queued: 1,
        blocked: 4,
        open: 7,
        runnable: 3,
        terminal: 8
      });
    });

    it('falls back to summary and legacy workflow fields when no task list is present', () => {
      const counts = shared.getWorkflowTaskCounts({
        summary: {
          pending: '3',
          cancelled: 1
        },
        total_tasks: 6,
        completed_tasks: 2,
        skipped_tasks: 1
      });

      expect(counts).toMatchObject({
        total: 6,
        completed: 2,
        failed: 0,
        pending: 3,
        skipped: 1,
        cancelled: 1,
        open: 3,
        runnable: 3,
        terminal: 4
      });
    });
  });

  describe('evaluateWorkflowVisibility', () => {
    it('marks empty workflows as hygiene issues', () => {
      const result = shared.evaluateWorkflowVisibility({ status: 'running' });

      expect(result).toMatchObject({
        state: 'hygiene',
        code: 'empty-workflow',
        actionable: false,
        label: 'HYGIENE: empty workflow'
      });
      expect(result.reason).toContain('has no tasks attached');
    });

    it('flags terminal workflows that still have open work', () => {
      const result = shared.evaluateWorkflowVisibility({
        status: 'completed',
        tasks: [{ status: 'pending' }]
      });

      expect(result).toMatchObject({
        state: 'hygiene',
        code: 'status-conflict',
        actionable: true
      });
      expect(result.reason).toContain('marked completed');
      expect(result.reason).toContain('1 open task');
    });

    it('returns blocked-only hygiene state when no tasks are runnable', () => {
      const result = shared.evaluateWorkflowVisibility({
        status: 'running',
        tasks: [{ status: 'blocked' }, { status: 'blocked' }]
      });

      expect(result).toMatchObject({
        state: 'hygiene',
        code: 'blocked-only',
        actionable: false
      });
      expect(result.reason).toContain('All 2 open task(s) are blocked');
    });

    it('returns stale-active-status when active workflows only contain terminal tasks', () => {
      const result = shared.evaluateWorkflowVisibility({
        status: 'pending',
        tasks: [{ status: 'completed' }, { status: 'failed' }]
      });

      expect(result).toMatchObject({
        state: 'hygiene',
        code: 'stale-active-status',
        actionable: false
      });
      expect(result.reason).toContain('every task is already terminal');
    });

    it('returns paused visibility for paused workflows with open tasks', () => {
      const result = shared.evaluateWorkflowVisibility({
        status: 'paused',
        tasks: [{ status: 'pending' }, { status: 'blocked' }]
      });

      expect(result).toMatchObject({
        state: 'paused',
        code: 'paused',
        actionable: true,
        label: 'PAUSED'
      });
      expect(result.next_step).toContain('run_workflow');
    });

    it('returns actionable visibility for workflows with running or ready tasks', () => {
      const result = shared.evaluateWorkflowVisibility({
        status: 'running',
        tasks: [{ status: 'running' }, { status: 'queued' }, { status: 'blocked' }]
      });

      expect(result).toMatchObject({
        state: 'actionable',
        code: 'active',
        actionable: true,
        label: 'ACTIONABLE'
      });
      expect(result.reason).toContain('1 running, 1 ready, 1 blocked');
    });

    it('returns quiet visibility when no tasks are open', () => {
      const result = shared.evaluateWorkflowVisibility({
        status: 'completed',
        tasks: [{ status: 'completed' }, { status: 'failed' }]
      });

      expect(result).toMatchObject({
        state: 'quiet',
        code: 'quiet',
        actionable: false,
        label: 'QUIET'
      });
      expect(result.reason).toContain('2 terminal task(s)');
    });
  });

  describe('safeLimit and MAX_BATCH_SIZE', () => {
    it('keeps MAX_BATCH_SIZE at 100 and clamps to that boundary', () => {
      expect(shared.MAX_BATCH_SIZE).toBe(100);
      expect(shared.safeLimit(shared.MAX_BATCH_SIZE + 1, 25, shared.MAX_BATCH_SIZE)).toBe(100);
      expect(shared.safeLimit(shared.MAX_BATCH_SIZE, 25, shared.MAX_BATCH_SIZE)).toBe(100);
    });

    it('falls back to bounded defaults for null and invalid values', () => {
      expect(shared.safeLimit(undefined, 200, shared.MAX_BATCH_SIZE)).toBe(100);
      expect(shared.safeLimit(null, 25, shared.MAX_BATCH_SIZE)).toBe(25);
      expect(shared.safeLimit('nope', 25, shared.MAX_BATCH_SIZE)).toBe(25);
      expect(shared.safeLimit(0, 25, shared.MAX_BATCH_SIZE)).toBe(25);
    });

    it('parses numeric strings and clamps oversized values', () => {
      expect(shared.safeLimit('42', 10, 100)).toBe(42);
      expect(shared.safeLimit(5000, 10, 100)).toBe(100);
    });
  });

  describe('isPathTraversalSafe', () => {
    it('rejects non-string, empty, and null-byte paths', () => {
      expect(shared.isPathTraversalSafe(null)).toBe(false);
      expect(shared.isPathTraversalSafe('')).toBe(false);
      expect(shared.isPathTraversalSafe('safe\u0000name.txt')).toBe(false);
    });

    it('rejects dot-dot traversal attempts, including encoded variants', () => {
      expect(shared.isPathTraversalSafe('../secret.txt')).toBe(false);
      expect(shared.isPathTraversalSafe('nested/%2e%2e/secret.txt')).toBe(false);
    });

    it('rejects dangerous absolute system paths', () => {
      expect(shared.isPathTraversalSafe('/etc/passwd')).toBe(false);
      expect(shared.isPathTraversalSafe('/Windows/System32/drivers/etc/hosts')).toBe(false);
    });

    it('allows contained paths and blocks absolute paths outside an allowed base', () => {
      const allowedBase = path.resolve('tmp-handler-shared-base');
      const safePath = path.join('nested', 'file.txt');
      const outsidePath = path.resolve(allowedBase, '..', 'escape.txt');

      expect(shared.isPathTraversalSafe(safePath, allowedBase)).toBe(true);
      expect(shared.isPathTraversalSafe(outsidePath, allowedBase)).toBe(false);
    });
  });
});
