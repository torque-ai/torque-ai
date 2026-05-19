import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  isValidIntent,
  validateVersionIntent,
  validateVersionIntentValue,
  enforceVersionIntent,
  enforceVersionIntentHttp,
  inferIntentFromCommitMessage,
  highestIntent,
  intentToBump,
} = require('../versioning/version-intent.js');

describe('server/versioning/version-intent', () => {
  it('isValidIntent returns true for supported intents and false otherwise', () => {
    expect(isValidIntent('feature')).toBe(true);
    expect(isValidIntent('fix')).toBe(true);
    expect(isValidIntent('breaking')).toBe(true);
    expect(isValidIntent('internal')).toBe(true);

    expect(isValidIntent('feat')).toBe(false);
    expect(isValidIntent('FEATURE')).toBe(false);
    expect(isValidIntent('')).toBe(false);
    expect(isValidIntent(null)).toBe(false);
  });

  it('validateVersionIntent returns a normalized intent or an error', () => {
    expect(validateVersionIntent('  FeAtUrE  ')).toEqual({ valid: true, intent: 'feature' });
    expect(validateVersionIntent('unknown')).toEqual({
      valid: false,
      error: 'Invalid version_intent "unknown". Use: feature, fix, breaking, or internal',
    });
    expect(validateVersionIntent()).toEqual({
      valid: false,
      error: 'version_intent is required. Use: feature, fix, breaking, or internal',
    });
  });

  it('inferIntentFromCommitMessage parses conventional commits and defaults unknown prefixes to internal', () => {
    expect(inferIntentFromCommitMessage('feat: add workflow planner')).toBe('feature');
    expect(inferIntentFromCommitMessage('fix(parser): handle empty output')).toBe('fix');
    expect(
      inferIntentFromCommitMessage('chore: update protocol\n\nBREAKING CHANGE: request shape changed')
    ).toBe('breaking');
    expect(inferIntentFromCommitMessage('refactor(core): simplify priority lookup')).toBe('internal');
    expect(inferIntentFromCommitMessage('unknown: add unsupported prefix')).toBe('internal');
  });

  it('highestIntent returns the highest priority intent from an array', () => {
    expect(highestIntent(['internal', 'fix'])).toBe('fix');
    expect(highestIntent(['fix', 'feature', 'internal'])).toBe('feature');
    expect(highestIntent(['internal', 'feature', 'breaking', 'fix'])).toBe('breaking');
  });

  it('intentToBump maps intents to the expected semantic version bump', () => {
    expect(intentToBump('breaking')).toBe('major');
    expect(intentToBump('feature')).toBe('minor');
    expect(intentToBump('fix')).toBe('patch');
    expect(intentToBump('internal')).toBeNull();
    expect(intentToBump('unknown')).toBeNull();
  });
});

describe('server/versioning/version-intent — shared utility unit tests', () => {
  describe('validateVersionIntentValue', () => {
    it('returns valid for each supported intent', () => {
      expect(validateVersionIntentValue('feature')).toEqual({ valid: true, intent: 'feature' });
      expect(validateVersionIntentValue('fix')).toEqual({ valid: true, intent: 'fix' });
      expect(validateVersionIntentValue('breaking')).toEqual({ valid: true, intent: 'breaking' });
      expect(validateVersionIntentValue('internal')).toEqual({ valid: true, intent: 'internal' });
    });

    it('returns invalid with status 400 for null, undefined, empty string, and bogus values', () => {
      const missingShape = { valid: false, error: { status: 400, message: 'version_intent is required. Use: feature, fix, breaking, or internal' } };
      expect(validateVersionIntentValue(null)).toEqual(missingShape);
      expect(validateVersionIntentValue(undefined)).toEqual(missingShape);
      expect(validateVersionIntentValue('')).toEqual(missingShape);

      const bogusResult = validateVersionIntentValue('bogus');
      expect(bogusResult.valid).toBe(false);
      expect(bogusResult.error.status).toBe(400);
      expect(bogusResult.error.message).toContain('Invalid version_intent');
    });
  });

  describe('enforceVersionIntent', () => {
    it('returns valid when versioning is disabled for the project', () => {
      const mockDb = {
        prepare: () => ({ get: () => null, all: () => [] }),
      };
      const result = enforceVersionIntent({ versionIntent: undefined, projectId: '/some/path', db: mockDb });
      expect(result).toEqual({ valid: true });
    });

    it('returns invalid with status 400 when versioning is enabled and intent is missing', () => {
      const mockDb = {
        prepare: (sql) => {
          if (sql.includes('project = ?')) {
            return { get: (p) => ({ project: p }) };
          }
          return { get: () => null, all: () => [] };
        },
      };
      const result = enforceVersionIntent({ versionIntent: undefined, projectId: '/versioned/project', db: mockDb });
      expect(result.valid).toBe(false);
      expect(result.error.status).toBe(400);
      expect(result.error.message).toContain('version_intent is required');
    });

    it('returns invalid with status 400 when versioning is enabled and intent is invalid', () => {
      const mockDb = {
        prepare: (sql) => {
          if (sql.includes('project = ?')) {
            return { get: (p) => ({ project: p }) };
          }
          return { get: () => null, all: () => [] };
        },
      };
      const result = enforceVersionIntent({ versionIntent: 'bogus', projectId: '/versioned/project', db: mockDb });
      expect(result.valid).toBe(false);
      expect(result.error.status).toBe(400);
      expect(result.error.message).toContain('Invalid version_intent');
    });

    it('returns valid when versioning is enabled and intent is valid', () => {
      const mockDb = {
        prepare: (sql) => {
          if (sql.includes('project = ?')) {
            return { get: (p) => ({ project: p }) };
          }
          return { get: () => null, all: () => [] };
        },
      };
      const result = enforceVersionIntent({ versionIntent: 'feature', projectId: '/versioned/project', db: mockDb });
      expect(result).toEqual({ valid: true, intent: 'feature' });
    });
  });
});

describe('server/versioning/version-intent — route-level regression', () => {
  /**
   * These tests exercise the enforceVersionIntent function with mocked DB state
   * to confirm the consistent error shape returned across all three entry points
   * (task submission, workflow creation, cron schedule creation).
   */

  function makeVersionedDb(projectPath) {
    return {
      prepare: (sql) => {
        if (sql.includes('project = ?') && sql.includes('versioning_enabled')) {
          return { get: (p) => (p === projectPath ? { project: p } : null) };
        }
        if (sql.includes('DISTINCT project')) {
          return { all: () => [{ project: projectPath }] };
        }
        return { get: () => null, all: () => [] };
      },
    };
  }

  it('task submission path: missing version_intent returns status 400 with normalized message', () => {
    const db = makeVersionedDb('/my/project');
    // Simulates the task handler path: enforceVersionIntent({ versionIntent: args.version_intent, projectId: workDir })
    const result = enforceVersionIntent({ versionIntent: undefined, projectId: '/my/project', db });
    expect(result.valid).toBe(false);
    expect(result.error).toEqual({
      status: 400,
      message: 'version_intent is required for versioned project. Use: feature, fix, breaking, or internal',
    });
  });

  it('workflow creation path: invalid version_intent returns status 400', () => {
    const db = makeVersionedDb('/my/project');
    // Simulates the workflow handler path: enforceVersionIntent({ versionIntent: workflowIntent, projectId: workDir, db })
    const result = enforceVersionIntent({ versionIntent: 'not-a-real-intent', projectId: '/my/project', db });
    expect(result.valid).toBe(false);
    expect(result.error.status).toBe(400);
    expect(result.error.message).toContain('Invalid version_intent');
  });

  it('cron schedule creation path: missing version_intent returns status 400', () => {
    const db = makeVersionedDb('/my/project');
    // Simulates the cron handler path: enforceVersionIntent({ versionIntent: intent, projectId: workDir, db })
    const result = enforceVersionIntent({ versionIntent: null, projectId: '/my/project', db });
    expect(result.valid).toBe(false);
    expect(result.error).toEqual({
      status: 400,
      message: 'version_intent is required for versioned project. Use: feature, fix, breaking, or internal',
    });
  });
});

describe('server/versioning/version-intent — enforceVersionIntentHttp', () => {
  /**
   * Tests for the HTTP-aware enforcement helper that wraps enforceVersionIntent
   * and returns a flat { ok, status?, error? } shape for handler call sites.
   */

  function makeVersionedDb(projectPath) {
    return {
      prepare: (sql) => {
        if (sql.includes('project = ?') && sql.includes('versioning_enabled')) {
          return { get: (p) => (p === projectPath ? { project: p } : null) };
        }
        if (sql.includes('DISTINCT project')) {
          return { all: () => [{ project: projectPath }] };
        }
        return { get: () => null, all: () => [] };
      },
    };
  }

  function makeUnversionedDb() {
    return {
      prepare: () => ({ get: () => null, all: () => [] }),
    };
  }

  it('returns { ok: true } when versioning is disabled for the project', () => {
    const db = makeUnversionedDb();
    const result = enforceVersionIntentHttp(db, '/unversioned/project', undefined);
    expect(result).toEqual({ ok: true });
  });

  it('returns { ok: false, status: 400 } with "required" message when versioning is enabled but intent is undefined', () => {
    const db = makeVersionedDb('/my/project');
    const result = enforceVersionIntentHttp(db, '/my/project', undefined);
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: 'version_intent is required for versioned project. Use: feature, fix, breaking, or internal',
    });
  });

  it('returns { ok: false, status: 400 } with "required" message when versioning is enabled but intent is null', () => {
    const db = makeVersionedDb('/my/project');
    const result = enforceVersionIntentHttp(db, '/my/project', null);
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: 'version_intent is required for versioned project. Use: feature, fix, breaking, or internal',
    });
  });

  it('returns { ok: false, status: 400 } with "Invalid" message when intent is an unrecognized string', () => {
    const db = makeVersionedDb('/my/project');
    const result = enforceVersionIntentHttp(db, '/my/project', 'not-a-real-intent');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toContain('Invalid version_intent');
  });

  it('returns { ok: true } for each valid intent when versioning is enabled', () => {
    const db = makeVersionedDb('/my/project');
    for (const intent of ['feature', 'fix', 'breaking', 'internal']) {
      const result = enforceVersionIntentHttp(db, '/my/project', intent);
      expect(result).toEqual({ ok: true });
    }
  });

  it('returns { ok: true } when db is null (graceful skip)', () => {
    const result = enforceVersionIntentHttp(null, '/my/project', 'feature');
    expect(result).toEqual({ ok: true });
  });

  it('returns { ok: true } when projectId is null (graceful skip)', () => {
    const db = makeVersionedDb('/my/project');
    const result = enforceVersionIntentHttp(db, null, 'feature');
    expect(result).toEqual({ ok: true });
  });
});

describe('server/versioning/version-intent — enforceVersionIntent caller consistency', () => {
  /**
   * Verifies that all three call paths (submit_task, smart_submit/workflow, cron)
   * produce identical error messages when version_intent enforcement fails.
   */

  function makeVersionedDb(projectPath) {
    return {
      prepare: (sql) => {
        if (sql.includes('project = ?') && sql.includes('versioning_enabled')) {
          return { get: (p) => (p === projectPath ? { project: p } : null) };
        }
        if (sql.includes('DISTINCT project')) {
          return { all: () => [{ project: projectPath }] };
        }
        return { get: () => null, all: () => [] };
      },
    };
  }

  it('submit_task and smart_submit paths produce identical "required" error messages via enforceVersionIntentHttp', () => {
    const db = makeVersionedDb('/project');
    // Both submit_task and smart_submit use enforceVersionIntentHttp at their entry point
    const submitResult = enforceVersionIntentHttp(db, '/project', undefined);
    const smartSubmitResult = enforceVersionIntentHttp(db, '/project', null);
    expect(submitResult.ok).toBe(false);
    expect(smartSubmitResult.ok).toBe(false);
    // Both should produce the same error message
    expect(submitResult.error).toBe(smartSubmitResult.error);
    expect(submitResult.error).toBe('version_intent is required for versioned project. Use: feature, fix, breaking, or internal');
  });

  it('cron path via enforceVersionIntent produces same "required" message as HTTP paths', () => {
    const db = makeVersionedDb('/project');
    // Cron path uses enforceVersionIntent directly (the throwing variant)
    const cronResult = enforceVersionIntent({ versionIntent: undefined, projectId: '/project', db });
    // HTTP path uses enforceVersionIntentHttp
    const httpResult = enforceVersionIntentHttp(db, '/project', undefined);
    expect(cronResult.valid).toBe(false);
    expect(httpResult.ok).toBe(false);
    // The message strings should be identical
    expect(cronResult.error.message).toBe(httpResult.error);
  });

  it('all paths produce identical "invalid" error message structure for bogus intents', () => {
    const db = makeVersionedDb('/project');
    const bogusIntent = 'definitely-not-valid';

    // HTTP path (submit_task / smart_submit / workflow)
    const httpResult = enforceVersionIntentHttp(db, '/project', bogusIntent);
    // Direct path (cron)
    const directResult = enforceVersionIntent({ versionIntent: bogusIntent, projectId: '/project', db });

    expect(httpResult.ok).toBe(false);
    expect(directResult.valid).toBe(false);

    // Both messages should contain the same intent string and same phrasing
    expect(httpResult.error).toBe(directResult.error.message);
    expect(httpResult.error).toContain('Invalid version_intent');
    expect(httpResult.error).toContain(bogusIntent);
  });
});
