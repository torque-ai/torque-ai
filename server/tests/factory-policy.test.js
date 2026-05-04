'use strict';

const Database = require('better-sqlite3');
const {
  DEFAULT_POLICY,
  validatePolicy,
  mergeWithDefaults,
  checkScopeAllowed,
  checkBlastRadius,
  checkRestrictedPaths,
  checkWorkHours,
  checkProviderAllowed,
  shouldEscalate,
} = require('../factory/policy-engine');
const factoryHealth = require('../db/factory/health');
const handlers = require('../handlers/factory-handlers');

function createFactoryTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS factory_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      brief TEXT,
      trust_level TEXT NOT NULL DEFAULT 'supervised',
      status TEXT NOT NULL DEFAULT 'paused',
      config_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function parseJsonResponse(result) {
  return JSON.parse(result.content[0].text);
}

describe('policy-engine', () => {
  describe('DEFAULT_POLICY', () => {
    it('has expected shape', () => {
      expect(Object.keys(DEFAULT_POLICY).sort()).toEqual([
        'blast_radius_percent',
        'budget_ceiling',
        'escalation_rules',
        'provider_restrictions',
        'required_checks',
        'restricted_paths',
        'scope_ceiling',
        'work_hours',
      ]);
      expect(DEFAULT_POLICY).toMatchObject({
        budget_ceiling: null,
        scope_ceiling: {
          max_tasks: 20,
          max_files_per_task: 10,
        },
        blast_radius_percent: 5,
        restricted_paths: [],
        required_checks: [],
        escalation_rules: {
          security_findings: true,
          health_drop_threshold: 10,
          breaking_changes: true,
          budget_warning_percent: 80,
        },
        work_hours: null,
        provider_restrictions: [],
      });
    });

    it('is frozen', () => {
      expect(Object.isFrozen(DEFAULT_POLICY)).toBe(true);
    });
  });

  describe('validatePolicy', () => {
    it('accepts valid complete policy', () => {
      const validation = validatePolicy({
        budget_ceiling: 250,
        scope_ceiling: {
          max_tasks: 8,
          max_files_per_task: 4,
        },
        blast_radius_percent: 12,
        restricted_paths: ['server/secrets', 'infra/private'],
        required_checks: ['lint', 'unit'],
        escalation_rules: {
          security_findings: true,
          health_drop_threshold: 15,
          breaking_changes: false,
          budget_warning_percent: 70,
        },
        work_hours: {
          start: 9,
          end: 17,
          timezone: 'UTC',
        },
        provider_restrictions: ['codex', 'ollama'],
      });

      expect(validation).toEqual({ valid: true });
    });

    it('accepts empty object', () => {
      expect(validatePolicy({})).toEqual({ valid: true });
    });

    it('rejects non-number budget_ceiling', () => {
      const validation = validatePolicy({ budget_ceiling: 'abc' });

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('budget_ceiling must be null or a positive number');
    });

    it('rejects negative budget_ceiling', () => {
      const validation = validatePolicy({ budget_ceiling: -1 });

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('budget_ceiling must be null or a positive number');
    });

    it('rejects non-integer max_tasks', () => {
      const validation = validatePolicy({
        scope_ceiling: {
          max_tasks: 3.5,
        },
      });

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('scope_ceiling.max_tasks must be a positive integer');
    });

    it('rejects blast_radius_percent out of range', () => {
      const tooLow = validatePolicy({ blast_radius_percent: 0 });
      const tooHigh = validatePolicy({ blast_radius_percent: 101 });

      expect(tooLow.valid).toBe(false);
      expect(tooLow.errors).toContain('blast_radius_percent must be a number between 1 and 100');
      expect(tooHigh.valid).toBe(false);
      expect(tooHigh.errors).toContain('blast_radius_percent must be a number between 1 and 100');
    });

    it('rejects non-array restricted_paths', () => {
      const validation = validatePolicy({ restricted_paths: 'server/secrets' });

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('restricted_paths must be an array of strings');
    });

    it('rejects invalid work_hours', () => {
      const validation = validatePolicy({
        work_hours: {
          start: 25,
          end: 17,
        },
      });

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('work_hours.start must be an integer between 0 and 23');
    });
  });

  describe('mergeWithDefaults', () => {
    it('fills gaps with defaults', () => {
      expect(mergeWithDefaults({ budget_ceiling: 500 })).toEqual({
        ...mergeWithDefaults({}),
        budget_ceiling: 500,
      });
    });

    it('preserves user overrides', () => {
      const merged = mergeWithDefaults({
        budget_ceiling: 800,
        blast_radius_percent: 25,
        restricted_paths: ['server/private'],
        provider_restrictions: ['codex'],
      });

      expect(merged).toMatchObject({
        budget_ceiling: 800,
        blast_radius_percent: 25,
        restricted_paths: ['server/private'],
        provider_restrictions: ['codex'],
      });
    });

    it('deep merges scope_ceiling', () => {
      const merged = mergeWithDefaults({
        scope_ceiling: {
          max_tasks: 3,
        },
      });

      expect(merged.scope_ceiling).toEqual({
        max_tasks: 3,
        max_files_per_task: 10,
      });
    });

    it('deep merges escalation_rules', () => {
      const merged = mergeWithDefaults({
        escalation_rules: {
          health_drop_threshold: 22,
        },
      });

      expect(merged.escalation_rules).toEqual({
        security_findings: true,
        health_drop_threshold: 22,
        breaking_changes: true,
        budget_warning_percent: 80,
      });
    });
  });

  describe('checkScopeAllowed', () => {
    it('allows within limit', () => {
      expect(checkScopeAllowed({ scope_ceiling: { max_tasks: 2 } }, 2)).toEqual({ allowed: true });
    });

    it('denies over limit', () => {
      const result = checkScopeAllowed({ scope_ceiling: { max_tasks: 2 } }, 3);

      expect(result).toMatchObject({ allowed: false });
      expect(result.reason).toContain('Task count 3 exceeds scope ceiling of 2');
    });
  });

  describe('checkBlastRadius', () => {
    it('allows within limit', () => {
      expect(checkBlastRadius({ blast_radius_percent: 5 }, 5, 100)).toEqual({ allowed: true });
    });

    it('denies over limit with percent', () => {
      const result = checkBlastRadius({ blast_radius_percent: 5 }, 6, 100);

      expect(result).toMatchObject({
        allowed: false,
        percent: 6,
      });
      expect(result.reason).toContain('Blast radius 6.00% exceeds limit of 5%');
    });
  });

  describe('checkRestrictedPaths', () => {
    it('returns empty array when no match', () => {
      expect(checkRestrictedPaths({ restricted_paths: ['server/private'] }, ['server/public/app.js'])).toEqual({
        restricted: [],
      });
    });

    it('detects restricted paths using startsWith', () => {
      const result = checkRestrictedPaths(
        { restricted_paths: ['server/private', 'docs/internal/'] },
        ['server/private/config.js', 'docs/internal/runbook.md', 'src/index.js'],
      );

      expect(result).toEqual({
        restricted: ['server/private/config.js', 'docs/internal/runbook.md'],
      });
    });
  });

  describe('checkWorkHours', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('allows when work_hours is null', () => {
      expect(checkWorkHours({ work_hours: null })).toEqual({ allowed: true });
    });

    it('handles start/end range', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-15T13:00:00.000Z'));

      expect(checkWorkHours({
        work_hours: {
          start: 12,
          end: 18,
          timezone: 'UTC',
        },
      })).toEqual({ allowed: true });

      vi.setSystemTime(new Date('2026-01-15T19:00:00.000Z'));

      const denied = checkWorkHours({
        work_hours: {
          start: 12,
          end: 18,
          timezone: 'UTC',
        },
      });

      expect(denied).toMatchObject({
        allowed: false,
        next_window: 12,
      });
      expect(denied.reason).toContain('Current hour 19 is outside allowed work hours 12:00-18:00 UTC');
    });
  });

  describe('checkProviderAllowed', () => {
    it('allows when no restrictions', () => {
      expect(checkProviderAllowed({}, 'codex')).toEqual({ allowed: true });
    });

    it('allows listed provider', () => {
      expect(checkProviderAllowed({ provider_restrictions: ['codex', 'ollama'] }, 'codex')).toEqual({ allowed: true });
    });

    it('denies unlisted provider', () => {
      const result = checkProviderAllowed({ provider_restrictions: ['codex'] }, 'anthropic');

      expect(result).toMatchObject({ allowed: false });
      expect(result.reason).toContain('Provider "anthropic" is not allowed by policy');
    });
  });

  describe('shouldEscalate', () => {
    it('escalates security findings', () => {
      expect(shouldEscalate({}, { type: 'security_finding' })).toEqual({
        escalate: true,
        reason: 'Security finding requires escalation',
      });
    });

    it('escalates health drop above threshold', () => {
      const result = shouldEscalate({}, { type: 'health_drop', delta: 11 });

      expect(result.escalate).toBe(true);
      expect(result.reason).toContain('Health dropped by 11');
    });

    it('does not escalate health drop below threshold', () => {
      expect(shouldEscalate({}, { type: 'health_drop', delta: 9 })).toEqual({ escalate: false });
    });

    it('escalates breaking changes', () => {
      expect(shouldEscalate({}, { type: 'breaking_change' })).toEqual({
        escalate: true,
        reason: 'Breaking change requires escalation',
      });
    });

    it('does not escalate unknown event types', () => {
      expect(shouldEscalate({}, { type: 'maintenance_window' })).toEqual({ escalate: false });
    });
  });
});

describe('factory-health policy helpers', () => {
  let db;
  let project;

  beforeEach(() => {
    db = new Database(':memory:');
    createFactoryTables(db);
    factoryHealth.setDb(db);
    project = factoryHealth.registerProject({
      name: 'Factory Policy Test App',
      path: '/projects/factory-policy-test-app',
      brief: 'Test project for policy flows',
    });
  });

  afterEach(() => {
    db.close();
  });

  it('getProjectPolicy returns defaults for new project', () => {
    expect(factoryHealth.getProjectPolicy(project.id)).toEqual(mergeWithDefaults({}));
  });

  it('setProjectPolicy stores and retrieves policy', () => {
    const saved = factoryHealth.setProjectPolicy(project.id, {
      budget_ceiling: 500,
      blast_radius_percent: 12,
      provider_restrictions: ['codex'],
    });

    expect(saved).toEqual(mergeWithDefaults({
      budget_ceiling: 500,
      blast_radius_percent: 12,
      provider_restrictions: ['codex'],
    }));
    expect(factoryHealth.getProjectPolicy(project.id)).toEqual(saved);
  });

  it('setProjectPolicy rejects invalid policy', () => {
    expect(() => factoryHealth.setProjectPolicy(project.id, { budget_ceiling: 'abc' }))
      .toThrow('Invalid policy: budget_ceiling must be null or a positive number');
  });

  it('setProjectPolicy merges with defaults', () => {
    const saved = factoryHealth.setProjectPolicy(project.id, {
      scope_ceiling: {
        max_tasks: 7,
      },
      escalation_rules: {
        health_drop_threshold: 18,
      },
    });

    expect(saved.scope_ceiling).toEqual({
      max_tasks: 7,
      max_files_per_task: 10,
    });
    expect(saved.escalation_rules).toEqual({
      security_findings: true,
      health_drop_threshold: 18,
      breaking_changes: true,
      budget_warning_percent: 80,
    });
  });
});

describe('factory-handlers policy', () => {
  let db;
  let project;

  beforeEach(() => {
    db = new Database(':memory:');
    createFactoryTables(db);
    factoryHealth.setDb(db);
    project = factoryHealth.registerProject({
      name: 'Factory Policy Handler App',
      path: '/projects/factory-policy-handler-app',
      brief: 'Test project for handler policy flows',
    });
  });

  afterEach(() => {
    db.close();
  });

  it('handleGetProjectPolicy returns merged policy', async () => {
    factoryHealth.setProjectPolicy(project.id, {
      scope_ceiling: {
        max_tasks: 4,
      },
    });

    const result = await handlers.handleGetProjectPolicy({ project: project.id });
    const data = parseJsonResponse(result);

    expect(data).toEqual({
      project: project.name,
      policy: mergeWithDefaults({
        scope_ceiling: {
          max_tasks: 4,
        },
      }),
    });
  });

  it('handleSetProjectPolicy saves and returns policy', async () => {
    const result = await handlers.handleSetProjectPolicy({
      project: project.id,
      policy: {
        budget_ceiling: 900,
        escalation_rules: {
          health_drop_threshold: 20,
        },
      },
    });
    const data = parseJsonResponse(result);
    const expected = mergeWithDefaults({
      budget_ceiling: 900,
      escalation_rules: {
        health_drop_threshold: 20,
      },
    });

    expect(data.message).toContain(`Policy updated for "${project.name}"`);
    expect(data.policy).toEqual(expected);
    expect(factoryHealth.getProjectPolicy(project.id)).toEqual(expected);
  });
});
