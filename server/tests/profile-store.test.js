'use strict';

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const mockLoggerInstance = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};
const mockLogger = {
  child: vi.fn(() => mockLoggerInstance),
};
const mockMatchers = {
  matchesAnyGlob: vi.fn(),
  extractProjectPath: vi.fn(),
  evaluateMatcher: vi.fn(),
};

installMock('../logger', mockLogger);
installMock('../policy-engine/matchers', mockMatchers);
delete require.cache[require.resolve('../policy-engine/profile-store')];

const profileStore = require('../policy-engine/profile-store');

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function makeProfileRow(overrides = {}) {
  const id = overrides.id || 'profile-1';
  const name = overrides.name || `Profile ${id}`;
  const defaults = hasOwn(overrides, 'defaults') ? overrides.defaults : { mode: 'advisory' };
  const projectMatch = hasOwn(overrides, 'project_match') ? overrides.project_match : {};
  const policyOverrides = hasOwn(overrides, 'policy_overrides') ? overrides.policy_overrides : {};
  const profileJson = hasOwn(overrides, 'profile_json')
    ? overrides.profile_json
    : {
        profile_id: id,
        name,
        defaults,
        project_match: projectMatch,
        policy_overrides: policyOverrides,
      };

  return {
    id,
    name,
    project: hasOwn(overrides, 'project') ? overrides.project : null,
    description: hasOwn(overrides, 'description') ? overrides.description : null,
    defaults_json: hasOwn(overrides, 'defaults_json')
      ? overrides.defaults_json
      : JSON.stringify(defaults),
    profile_json: typeof profileJson === 'string' ? profileJson : JSON.stringify(profileJson),
    enabled: hasOwn(overrides, 'enabled') ? (overrides.enabled ? 1 : 0) : 1,
    created_at: overrides.created_at || '2026-03-10T00:00:00.000Z',
    updated_at: overrides.updated_at || '2026-03-11T00:00:00.000Z',
  };
}

function makeRuleRow(overrides = {}) {
  const id = overrides.id || 'rule-1';
  const matcher = hasOwn(overrides, 'matcher') ? overrides.matcher : {};
  const requiredEvidence = hasOwn(overrides, 'required_evidence')
    ? overrides.required_evidence
    : [];
  const actions = hasOwn(overrides, 'actions') ? overrides.actions : [];
  const overridePolicy = hasOwn(overrides, 'override_policy') ? overrides.override_policy : {};
  const tags = hasOwn(overrides, 'tags') ? overrides.tags : [];

  return {
    id,
    name: overrides.name || `Rule ${id}`,
    category: overrides.category || 'change_safety',
    stage: overrides.stage || 'task_submit',
    mode: hasOwn(overrides, 'mode') ? overrides.mode : 'advisory',
    priority: hasOwn(overrides, 'priority') ? overrides.priority : 100,
    enabled: hasOwn(overrides, 'enabled') ? (overrides.enabled ? 1 : 0) : 1,
    matcher_json: hasOwn(overrides, 'matcher_json')
      ? overrides.matcher_json
      : JSON.stringify(matcher),
    required_evidence_json: hasOwn(overrides, 'required_evidence_json')
      ? overrides.required_evidence_json
      : JSON.stringify(requiredEvidence),
    actions_json: hasOwn(overrides, 'actions_json')
      ? overrides.actions_json
      : JSON.stringify(actions),
    override_policy_json: hasOwn(overrides, 'override_policy_json')
      ? overrides.override_policy_json
      : JSON.stringify(overridePolicy),
    tags_json: hasOwn(overrides, 'tags_json')
      ? overrides.tags_json
      : JSON.stringify(tags),
    version: hasOwn(overrides, 'version') ? overrides.version : null,
    created_at: overrides.created_at || '2026-03-10T00:00:00.000Z',
    updated_at: overrides.updated_at || '2026-03-11T00:00:00.000Z',
  };
}

function makeBindingRow(overrides = {}) {
  const bindingJson = hasOwn(overrides, 'binding_json') ? overrides.binding_json : {};

  return {
    id: overrides.id || 'binding-1',
    profile_id: overrides.profile_id || 'profile-1',
    policy_id: overrides.policy_id || 'rule-1',
    mode_override: hasOwn(overrides, 'mode_override') ? overrides.mode_override : null,
    binding_json: hasOwn(overrides, 'binding_json')
      ? (typeof overrides.binding_json === 'string'
        ? overrides.binding_json
        : JSON.stringify(bindingJson))
      : JSON.stringify(bindingJson),
    enabled: hasOwn(overrides, 'enabled') ? (overrides.enabled ? 1 : 0) : 1,
    created_at: overrides.created_at || '2026-03-10T00:00:00.000Z',
    updated_at: overrides.updated_at || '2026-03-11T00:00:00.000Z',
  };
}

function sortProfiles(rows) {
  return [...rows].sort((left, right) =>
    right.updated_at.localeCompare(left.updated_at)
    || right.created_at.localeCompare(left.created_at)
    || left.id.localeCompare(right.id));
}

function sortRules(rows) {
  return [...rows].sort((left, right) =>
    Number(left.priority) - Number(right.priority)
    || right.updated_at.localeCompare(left.updated_at)
    || left.id.localeCompare(right.id));
}

function sortBindings(rows) {
  return [...rows].sort((left, right) =>
    right.updated_at.localeCompare(left.updated_at)
    || right.created_at.localeCompare(left.created_at)
    || left.id.localeCompare(right.id));
}

function makeStatement(overrides = {}) {
  return {
    all: vi.fn(() => {
      throw new Error('Unexpected statement.all call');
    }),
    get: vi.fn(() => {
      throw new Error('Unexpected statement.get call');
    }),
    run: vi.fn(() => {
      throw new Error('Unexpected statement.run call');
    }),
    ...overrides,
  };
}

function createMockDb(seed = {}) {
  const state = {
    policy_profiles: (seed.policy_profiles || []).map((row) => ({ ...row })),
    policy_rules: (seed.policy_rules || []).map((row) => ({ ...row })),
    policy_bindings: (seed.policy_bindings || []).map((row) => ({ ...row })),
    project_metadata: (seed.project_metadata || []).map((row) => ({ ...row })),
  };

  return {
    state,
    prepare: vi.fn((sql) => {
      const normalized = normalizeSql(sql);

      if (normalized === 'SELECT * FROM policy_profiles WHERE id = ?') {
        return makeStatement({
          get: vi.fn((profileId) => {
            const row = state.policy_profiles.find((entry) => entry.id === profileId);
            return row ? { ...row } : undefined;
          }),
        });
      }

      if (
        normalized.startsWith('SELECT * FROM policy_profiles')
        && normalized.includes('ORDER BY updated_at DESC, created_at DESC, id ASC')
      ) {
        return makeStatement({
          all: vi.fn((...params) => {
            let index = 0;
            let rows = state.policy_profiles.slice();

            if (normalized.includes('project = ?')) {
              rows = rows.filter((row) => row.project === params[index]);
              index += 1;
            }

            if (normalized.includes('enabled = 1')) {
              rows = rows.filter((row) => Number(row.enabled) === 1);
            } else if (normalized.includes('enabled = ?')) {
              rows = rows.filter((row) => Number(row.enabled) === Number(params[index]));
            }

            return sortProfiles(rows).map((row) => ({ ...row }));
          }),
        });
      }

      if (normalized.startsWith('INSERT INTO policy_profiles')) {
        return makeStatement({
          run: vi.fn((
            id,
            name,
            project,
            description,
            defaultsJson,
            profileJson,
            enabled,
            createdAt,
            updatedAt,
          ) => {
            const row = {
              id,
              name,
              project,
              description,
              defaults_json: defaultsJson,
              profile_json: profileJson,
              enabled,
              created_at: createdAt,
              updated_at: updatedAt,
            };
            const existingIndex = state.policy_profiles.findIndex((entry) => entry.id === id);
            if (existingIndex === -1) {
              state.policy_profiles.push(row);
            } else {
              state.policy_profiles[existingIndex] = row;
            }
            return { changes: 1 };
          }),
        });
      }

      if (normalized === 'SELECT * FROM policy_rules WHERE id = ?') {
        return makeStatement({
          get: vi.fn((policyId) => {
            const row = state.policy_rules.find((entry) => entry.id === policyId);
            return row ? { ...row } : undefined;
          }),
        });
      }

      if (
        normalized.startsWith('SELECT * FROM policy_rules')
        && normalized.includes('ORDER BY priority ASC, updated_at DESC, id ASC')
      ) {
        return makeStatement({
          all: vi.fn((...params) => {
            let index = 0;
            let rows = state.policy_rules.slice();

            if (normalized.includes('stage = ?')) {
              rows = rows.filter((row) => row.stage === params[index]);
              index += 1;
            }
            if (normalized.includes('category = ?')) {
              rows = rows.filter((row) => row.category === params[index]);
              index += 1;
            }
            if (normalized.includes('id = ?')) {
              rows = rows.filter((row) => row.id === params[index]);
              index += 1;
            }

            if (normalized.includes('enabled = 1')) {
              rows = rows.filter((row) => Number(row.enabled) === 1);
            } else if (normalized.includes('enabled = ?')) {
              rows = rows.filter((row) => Number(row.enabled) === Number(params[index]));
            }

            return sortRules(rows).map((row) => ({ ...row }));
          }),
        });
      }

      if (normalized.startsWith('INSERT INTO policy_rules')) {
        return makeStatement({
          run: vi.fn((
            id,
            name,
            category,
            stage,
            mode,
            priority,
            enabled,
            matcherJson,
            requiredEvidenceJson,
            actionsJson,
            overridePolicyJson,
            tagsJson,
            version,
            createdAt,
            updatedAt,
          ) => {
            const row = {
              id,
              name,
              category,
              stage,
              mode,
              priority,
              enabled,
              matcher_json: matcherJson,
              required_evidence_json: requiredEvidenceJson,
              actions_json: actionsJson,
              override_policy_json: overridePolicyJson,
              tags_json: tagsJson,
              version,
              created_at: createdAt,
              updated_at: updatedAt,
            };
            const existingIndex = state.policy_rules.findIndex((entry) => entry.id === id);
            if (existingIndex === -1) {
              state.policy_rules.push(row);
            } else {
              state.policy_rules[existingIndex] = row;
            }
            return { changes: 1 };
          }),
        });
      }

      if (normalized === 'SELECT * FROM policy_bindings WHERE profile_id = ? AND policy_id = ?') {
        return makeStatement({
          get: vi.fn((profileId, policyId) => {
            const row = state.policy_bindings.find(
              (entry) => entry.profile_id === profileId && entry.policy_id === policyId,
            );
            return row ? { ...row } : undefined;
          }),
        });
      }

      if (
        normalized.startsWith('SELECT * FROM policy_bindings')
        && normalized.includes('ORDER BY updated_at DESC, created_at DESC, id ASC')
      ) {
        return makeStatement({
          all: vi.fn((...params) => {
            let index = 0;
            let rows = state.policy_bindings.slice();

            if (normalized.includes('profile_id = ?')) {
              rows = rows.filter((row) => row.profile_id === params[index]);
              index += 1;
            }
            if (normalized.includes('policy_id = ?')) {
              rows = rows.filter((row) => row.policy_id === params[index]);
              index += 1;
            }

            if (normalized.includes('enabled = 1')) {
              rows = rows.filter((row) => Number(row.enabled) === 1);
            } else if (normalized.includes('enabled = ?')) {
              rows = rows.filter((row) => Number(row.enabled) === Number(params[index]));
            }

            return sortBindings(rows).map((row) => ({ ...row }));
          }),
        });
      }

      if (normalized.startsWith('INSERT INTO policy_bindings')) {
        return makeStatement({
          run: vi.fn((
            id,
            profileId,
            policyId,
            modeOverride,
            bindingJson,
            enabled,
            createdAt,
            updatedAt,
          ) => {
            const row = {
              id,
              profile_id: profileId,
              policy_id: policyId,
              mode_override: modeOverride,
              binding_json: bindingJson,
              enabled,
              created_at: createdAt,
              updated_at: updatedAt,
            };
            const existingIndex = state.policy_bindings.findIndex(
              (entry) => entry.profile_id === profileId && entry.policy_id === policyId,
            );
            if (existingIndex === -1) {
              state.policy_bindings.push(row);
            } else {
              state.policy_bindings[existingIndex] = row;
            }
            return { changes: 1 };
          }),
        });
      }

      if (normalized === 'SELECT value FROM project_metadata WHERE project = ? COLLATE NOCASE AND key = ?') {
        return makeStatement({
          get: vi.fn((project, key) => {
            const row = state.project_metadata.find(
              (entry) => String(entry.project).toLowerCase() === String(project).toLowerCase()
                && entry.key === key,
            );
            return row ? { ...row } : undefined;
          }),
        });
      }

      throw new Error(`Unexpected SQL: ${normalized}`);
    }),
  };
}

describe('policy-engine/profile-store', () => {
  let db;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMatchers.evaluateMatcher.mockReturnValue({ state: 'no_match' });
    db = createMockDb();
    profileStore.setDb(db);
    profileStore.setGetProjectMetadata(null);
  });

  describe('setDb / setGetProjectMetadata', () => {
    it('throws before db injection and succeeds after a db is injected', () => {
      profileStore.setDb(undefined);

      expect(() => profileStore.listPolicyProfiles()).toThrow(
        'Policy profile store is not initialized',
      );

      profileStore.setDb(db);

      expect(profileStore.listPolicyProfiles()).toEqual([]);
    });

    it('uses an injected metadata getter and resets to db fallback when passed a non-function', () => {
      db.state.policy_profiles.push(
        makeProfileRow({ id: 'global-profile', name: 'Global Profile' }),
        makeProfileRow({ id: 'getter-profile', name: 'Getter Profile', project: 'BoundProject' }),
        makeProfileRow({ id: 'db-profile', name: 'DB Profile', project: 'BoundProject' }),
      );
      db.state.project_metadata.push({
        project: 'Torque',
        key: 'policy_profile_id',
        value: 'db-profile',
      });

      const getProjectMetadata = vi.fn((project, key) => {
        if (key === 'policy_profile_id' && project === 'torque') {
          return 'getter-profile';
        }
        return null;
      });

      profileStore.setGetProjectMetadata(getProjectMetadata);
      expect(
        profileStore.resolveApplicableProfiles({ project_id: ' Torque ' }).map((profile) => profile.id),
      ).toEqual(['global-profile', 'getter-profile']);
      expect(getProjectMetadata).toHaveBeenNthCalledWith(1, ' Torque ', 'policy_profile_id');
      expect(getProjectMetadata).toHaveBeenNthCalledWith(2, 'torque', 'policy_profile_id');

      profileStore.setGetProjectMetadata('not-a-function');
      expect(
        profileStore.resolveApplicableProfiles({ project_id: 'Torque' }).map((profile) => profile.id),
      ).toEqual(['global-profile', 'db-profile']);
    });
  });

  describe('normalizeEnabled', () => {
    it('treats non-null objects as disabled', () => {
      const effective = profileStore.buildEffectiveRule(
        {
          id: 'rule-object-enabled',
          mode: 'block',
          enabled: true,
          matcher: {},
          required_evidence: [],
          actions: [],
          override_policy: {},
          tags: [],
        },
        {
          id: 'binding-object-enabled',
          binding_json: {
            enabled: { value: true },
          },
        },
        {
          id: 'profile-object-enabled',
          defaults: { mode: 'block' },
          policy_overrides: {},
        },
      );

      expect(effective.enabled).toBe(false);
    });
  });

  describe('profiles', () => {
    it('listPolicyProfiles returns an empty array when no profiles exist', () => {
      expect(profileStore.listPolicyProfiles()).toEqual([]);
    });

    it('listPolicyProfiles hydrates rows and lets enabled_only win over enabled', () => {
      db = createMockDb({
        policy_profiles: [
          makeProfileRow({
            id: 'disabled-profile',
            project: 'Torque',
            enabled: false,
            updated_at: '2026-03-12T00:00:00.000Z',
          }),
          makeProfileRow({
            id: 'enabled-profile',
            project: 'Torque',
            defaults_json: null,
            profile_json: {
              defaults: { mode: 'shadow' },
              policyOverrides: { 'rule-1': { mode: 'block' } },
              projectMatch: { type: 'provider', providers_any: ['codex'] },
            },
            updated_at: '2026-03-11T00:00:00.000Z',
          }),
        ],
      });
      profileStore.setDb(db);

      const profiles = profileStore.listPolicyProfiles({
        project: 'Torque',
        enabled_only: true,
        enabled: false,
      });

      expect(profiles).toHaveLength(1);
      expect(profiles[0]).toMatchObject({
        id: 'enabled-profile',
        enabled: true,
        defaults: { mode: 'shadow' },
        policy_overrides: { 'rule-1': { mode: 'block' } },
        project_match: { type: 'provider', providers_any: ['codex'] },
      });
    });

    it('getPolicyProfile returns null for a missing profile', () => {
      expect(profileStore.getPolicyProfile('missing-profile')).toBeNull();
    });

    it('savePolicyProfile validates required input', () => {
      expect(() => profileStore.savePolicyProfile(null)).toThrow('profile must be an object');
      expect(() => profileStore.savePolicyProfile({ name: 'Missing id' })).toThrow(
        'profile.id is required',
      );
      expect(() => profileStore.savePolicyProfile({ id: 'profile-1' })).toThrow(
        'profile.name is required',
      );
    });

    it('savePolicyProfile merges derived fields into profile_json and normalizes enabled', () => {
      const saved = profileStore.savePolicyProfile({
        id: 'profile-save',
        name: 'Saved Profile',
        project: 'Torque',
        description: 'Merged profile',
        profile_json: {
          custom: { keep: true },
          project_match: { type: 'provider', providers_any: ['codex'] },
          defaults: { mode: 'shadow' },
          policy_overrides: { inherited: { mode: 'warn' } },
        },
        project_match: undefined,
        defaults: { mode: 'block' },
        policy_overrides: { explicit: { mode: 'off' } },
        enabled: 'off',
      });

      expect(saved).toMatchObject({
        id: 'profile-save',
        name: 'Saved Profile',
        project: 'Torque',
        description: 'Merged profile',
        enabled: false,
        defaults: { mode: 'block' },
        project_match: { type: 'provider', providers_any: ['codex'] },
        policy_overrides: {
          inherited: { mode: 'warn' },
          explicit: { mode: 'off' },
        },
      });
      expect(saved.profile_json).toMatchObject({
        profile_id: 'profile-save',
        name: 'Saved Profile',
        custom: { keep: true },
        defaults: { mode: 'block' },
        project_match: { type: 'provider', providers_any: ['codex'] },
        policy_overrides: {
          inherited: { mode: 'warn' },
          explicit: { mode: 'off' },
        },
      });
    });

    it('savePolicyProfile preserves created_at when updating an existing row', () => {
      db.state.policy_profiles.push(
        makeProfileRow({
          id: 'profile-existing',
          name: 'Original Name',
          created_at: '2025-01-01T00:00:00.000Z',
          updated_at: '2025-01-02T00:00:00.000Z',
        }),
      );

      const saved = profileStore.savePolicyProfile({
        id: 'profile-existing',
        name: 'Updated Name',
        defaults: { mode: 'warn' },
      });

      expect(saved.name).toBe('Updated Name');
      expect(saved.created_at).toBe('2025-01-01T00:00:00.000Z');
      expect(saved.updated_at).toEqual(expect.any(String));
    });
  });

  describe('rules', () => {
    it('listPolicyRules hydrates rows, trims stage filters, and lets enabled_only win over enabled', () => {
      db = createMockDb({
        policy_rules: [
          makeRuleRow({
            id: 'rule-enabled',
            category: 'change_safety',
            stage: 'task_submit',
            mode: 'INVALID',
            priority: '42',
            matcher_json: null,
            required_evidence_json: null,
            actions_json: null,
            override_policy_json: null,
            tags_json: null,
          }),
          makeRuleRow({
            id: 'rule-disabled',
            category: 'change_safety',
            stage: 'task_submit',
            enabled: false,
          }),
        ],
      });
      profileStore.setDb(db);

      const rules = profileStore.listPolicyRules({
        stage: ' task_submit ',
        category: 'change_safety',
        policy_id: 'rule-enabled',
        enabled_only: true,
        enabled: false,
      });

      expect(rules).toHaveLength(1);
      expect(rules[0]).toMatchObject({
        id: 'rule-enabled',
        mode: 'advisory',
        priority: 42,
        matcher: {},
        required_evidence: [],
        actions: [],
        override_policy: {},
        tags: [],
      });
    });

    it('getPolicyRule returns null for a missing rule', () => {
      expect(profileStore.getPolicyRule('missing-rule')).toBeNull();
    });

    it('savePolicyRule validates required input', () => {
      expect(() => profileStore.savePolicyRule(null)).toThrow('rule must be an object');
      expect(() => profileStore.savePolicyRule({ name: 'Missing id' })).toThrow(
        'rule.id is required',
      );
      expect(() => profileStore.savePolicyRule({ id: 'rule-1' })).toThrow(
        'rule.name is required',
      );
      expect(() => profileStore.savePolicyRule({ id: 'rule-1', name: 'Rule' })).toThrow(
        'rule.category is required',
      );
      expect(() => profileStore.savePolicyRule({
        id: 'rule-1',
        name: 'Rule',
        category: 'change_safety',
      })).toThrow('rule.stage is required');
    });

    it('savePolicyRule inserts normalized values', () => {
      const saved = profileStore.savePolicyRule({
        id: 'rule-save',
        name: 'Saved Rule',
        category: 'change_safety',
        stage: ' task_submit ',
        mode: 'not-a-real-mode',
        matcher: { changed_file_globs_any: ['server/**/*.js'] },
        required_evidence: ['approval'],
        actions: [{ type: 'emit_violation' }],
        override_policy: { allowed: true },
        tags: ['policy'],
      });

      expect(saved).toMatchObject({
        id: 'rule-save',
        stage: 'task_submit',
        mode: 'advisory',
        priority: 100,
        enabled: true,
        matcher: { changed_file_globs_any: ['server/**/*.js'] },
        required_evidence: ['approval'],
        actions: [{ type: 'emit_violation' }],
        override_policy: { allowed: true },
        tags: ['policy'],
      });
    });

    it('savePolicyRule preserves created_at when updating an existing row', () => {
      db.state.policy_rules.push(
        makeRuleRow({
          id: 'rule-existing',
          created_at: '2025-02-01T00:00:00.000Z',
          updated_at: '2025-02-02T00:00:00.000Z',
        }),
      );

      const saved = profileStore.savePolicyRule({
        id: 'rule-existing',
        name: 'Updated Rule',
        category: 'quality',
        stage: 'task_complete',
      });

      expect(saved.created_at).toBe('2025-02-01T00:00:00.000Z');
      expect(saved.category).toBe('quality');
      expect(saved.stage).toBe('task_complete');
    });
  });

  describe('bindings', () => {
    it('listPolicyBindings hydrates rows and lets enabled_only win over enabled', () => {
      db = createMockDb({
        policy_bindings: [
          makeBindingRow({
            id: 'binding-enabled',
            profile_id: 'profile-1',
            policy_id: 'rule-1',
            binding_json: null,
          }),
          makeBindingRow({
            id: 'binding-disabled',
            profile_id: 'profile-1',
            policy_id: 'rule-1',
            enabled: false,
          }),
        ],
      });
      profileStore.setDb(db);

      const bindings = profileStore.listPolicyBindings({
        profile_id: 'profile-1',
        policy_id: 'rule-1',
        enabled_only: true,
        enabled: false,
      });

      expect(bindings).toHaveLength(1);
      expect(bindings[0]).toMatchObject({
        id: 'binding-enabled',
        enabled: true,
        binding_json: {},
      });
    });

    it('getPolicyBinding returns null for a missing binding', () => {
      expect(profileStore.getPolicyBinding('profile-1', 'rule-1')).toBeNull();
    });

    it('savePolicyBinding validates required input', () => {
      expect(() => profileStore.savePolicyBinding(null)).toThrow('binding must be an object');
      expect(() => profileStore.savePolicyBinding({ profile_id: 'profile-1', policy_id: 'rule-1' })).toThrow(
        'binding.id is required',
      );
      expect(() => profileStore.savePolicyBinding({ id: 'binding-1', policy_id: 'rule-1' })).toThrow(
        'binding.profile_id is required',
      );
      expect(() => profileStore.savePolicyBinding({ id: 'binding-1', profile_id: 'profile-1' })).toThrow(
        'binding.policy_id is required',
      );
    });

    it('savePolicyBinding stores the binding alias payload and preserves an invalid mode_override', () => {
      const saved = profileStore.savePolicyBinding({
        id: 'binding-save',
        profile_id: 'profile-1',
        policy_id: 'rule-1',
        mode_override: 'custom-mode',
        binding: {
          matcher: { changed_file_globs_any: ['server/**/*.js'] },
        },
      });

      expect(saved).toMatchObject({
        id: 'binding-save',
        profile_id: 'profile-1',
        policy_id: 'rule-1',
        mode_override: 'custom-mode',
        enabled: true,
        binding_json: {
          matcher: { changed_file_globs_any: ['server/**/*.js'] },
        },
      });
    });

    it('savePolicyBinding upserts by profile_id and policy_id and can replace the stored id', () => {
      db.state.policy_bindings.push(
        makeBindingRow({
          id: 'binding-old',
          profile_id: 'profile-1',
          policy_id: 'rule-1',
          created_at: '2025-03-01T00:00:00.000Z',
          updated_at: '2025-03-02T00:00:00.000Z',
        }),
      );

      const saved = profileStore.savePolicyBinding({
        id: 'binding-new',
        profile_id: 'profile-1',
        policy_id: 'rule-1',
        mode_override: 'block',
        enabled: '0',
      });

      expect(saved).toMatchObject({
        id: 'binding-new',
        mode_override: 'block',
        enabled: false,
        created_at: '2025-03-01T00:00:00.000Z',
      });
    });
  });

  describe('profile resolution', () => {
    it('resolveApplicableProfiles short-circuits explicit profile ids and respects include_disabled', () => {
      db = createMockDb({
        policy_profiles: [
          makeProfileRow({ id: 'global-profile' }),
          makeProfileRow({ id: 'disabled-profile', enabled: false }),
        ],
      });
      profileStore.setDb(db);

      expect(
        profileStore.resolveApplicableProfiles({ profile_id: 'disabled-profile' }),
      ).toEqual([]);
      expect(
        profileStore.resolveApplicableProfiles({
          profileId: 'disabled-profile',
          include_disabled: true,
        }).map((profile) => profile.id),
      ).toEqual(['disabled-profile']);
      expect(
        profileStore.resolveApplicableProfiles({ profile_id: 'missing-profile' }),
      ).toEqual([]);
    });

    it('resolveApplicableProfiles prefers a direct project match before matcher-based profiles', () => {
      db = createMockDb({
        policy_profiles: [
          makeProfileRow({ id: 'global-profile' }),
          makeProfileRow({ id: 'project-profile', project: 'Torque' }),
          makeProfileRow({
            id: 'matcher-profile',
            project_match: { type: 'provider', providers_any: ['codex'] },
          }),
        ],
      });
      profileStore.setDb(db);
      mockMatchers.evaluateMatcher.mockReturnValue({ state: 'match' });

      expect(
        profileStore.resolveApplicableProfiles({
          project_id: 'Torque',
          provider: 'codex',
        }).map((profile) => profile.id),
      ).toEqual(['global-profile', 'project-profile']);
      expect(mockMatchers.evaluateMatcher).not.toHaveBeenCalled();
    });

    it('resolveApplicableProfiles can select a matcher-based profile from project context', () => {
      db = createMockDb({
        policy_profiles: [
          makeProfileRow({ id: 'global-profile' }),
          makeProfileRow({
            id: 'matcher-profile',
            project_match: { type: 'project_path', root_globs_any: ['apps/**'] },
          }),
        ],
      });
      profileStore.setDb(db);
      mockMatchers.evaluateMatcher.mockReturnValue({ state: 'match' });

      const profiles = profileStore.resolveApplicableProfiles({
        project_path: 'apps/torque',
        provider: 'codex',
        changed_files: ['server/policy-engine/profile-store.js'],
        target_type: 'task',
      });

      expect(profiles.map((profile) => profile.id)).toEqual(['global-profile', 'matcher-profile']);
      expect(mockMatchers.evaluateMatcher).toHaveBeenCalledWith(
        { type: 'project_path', root_globs_any: ['apps/**'] },
        {
          project_path: 'apps/torque',
          provider: 'codex',
          changed_files: ['server/policy-engine/profile-store.js'],
          target_type: 'task',
        },
      );
    });

    it('resolvePolicyProfile returns the last applicable profile', () => {
      db = createMockDb({
        policy_profiles: [
          makeProfileRow({ id: 'global-profile' }),
          makeProfileRow({ id: 'project-profile', project: 'Torque' }),
        ],
      });
      profileStore.setDb(db);

      expect(
        profileStore.resolvePolicyProfile({ project_id: 'Torque' }),
      ).toMatchObject({ id: 'project-profile' });
      expect(profileStore.resolvePolicyProfile({ project_id: 'Missing' })).toMatchObject({
        id: 'global-profile',
      });
    });
  });

  describe('buildEffectiveRule', () => {
    it('merges matcher and override_policy objects with binding overrides taking precedence', () => {
      const rule = {
        id: 'rule-1',
        mode: 'shadow',
        enabled: true,
        matcher: {
          scope: { team: 'core', provider: 'codex' },
          base: true,
        },
        required_evidence: ['rule-evidence'],
        actions: [{ type: 'rule-action' }],
        override_policy: {
          approvals: { required: 1, allowed: true },
          notes: { source: 'rule' },
        },
        tags: ['rule-tag'],
      };
      const profile = {
        id: 'profile-1',
        defaults: { mode: 'warn' },
        policy_overrides: {
          'rule-1': {
            mode: 'warn',
            enabled: false,
            matcher: {
              scope: { root: 'apps/**' },
              profile_only: true,
            },
            required_evidence: ['profile-evidence'],
            actions: [{ type: 'profile-action' }],
            override_policy: {
              approvals: { required: 2 },
              notes: { profile: true },
            },
            tags: ['profile-tag'],
          },
        },
      };
      const binding = {
        id: 'binding-1',
        mode_override: 'block',
        binding_json: {
          enabled: true,
          matcher: {
            scope: { provider: 'anthropic' },
            binding_only: true,
          },
          required_evidence: ['binding-evidence'],
          override_policy: {
            approvals: { allowed: false },
            notes: { binding: true },
          },
        },
      };

      const effective = profileStore.buildEffectiveRule(rule, binding, profile);

      expect(effective).toMatchObject({
        id: 'rule-1',
        policy_id: 'rule-1',
        profile_id: 'profile-1',
        binding_id: 'binding-1',
        mode: 'block',
        enabled: true,
        matcher: {
          scope: {
            team: 'core',
            provider: 'anthropic',
            root: 'apps/**',
          },
          base: true,
          profile_only: true,
          binding_only: true,
        },
        required_evidence: ['binding-evidence'],
        actions: [{ type: 'profile-action' }],
        override_policy: {
          approvals: { required: 2, allowed: false },
          notes: { source: 'rule', profile: true, binding: true },
        },
        tags: ['profile-tag'],
      });
    });

    it('normalizes invalid mode overrides and string enabled overrides', () => {
      const effective = profileStore.buildEffectiveRule(
        {
          id: 'rule-2',
          mode: null,
          enabled: true,
          matcher: {},
          required_evidence: [],
          actions: [],
          override_policy: {},
          tags: [],
        },
        {
          id: 'binding-2',
          mode_override: 'custom-mode',
          binding_json: {
            enabled: 'disabled',
          },
        },
        {
          id: 'profile-2',
          defaults: { mode: 'warn' },
          policy_overrides: {},
        },
      );

      expect(effective.mode).toBe('advisory');
      expect(effective.enabled).toBe(false);
    });
  });

  describe('resolvePoliciesForStage', () => {
    it('throws when stage is blank', () => {
      expect(() => profileStore.resolvePoliciesForStage({ stage: '   ' })).toThrow(
        'stage is required to resolve bound policies',
      );
    });

    it('uses an explicit profile object without resolving applicable profiles', () => {
      db = createMockDb({
        policy_rules: [
          makeRuleRow({ id: 'rule-explicit', stage: 'task_submit', priority: 5 }),
          makeRuleRow({ id: 'rule-disabled-via-binding', stage: 'task_submit', priority: 10 }),
        ],
        policy_bindings: [
          makeBindingRow({
            id: 'binding-explicit',
            profile_id: 'explicit-profile',
            policy_id: 'rule-explicit',
          }),
          makeBindingRow({
            id: 'binding-disabled-via-binding',
            profile_id: 'explicit-profile',
            policy_id: 'rule-disabled-via-binding',
            binding_json: { enabled: 'off' },
          }),
        ],
      });
      profileStore.setDb(db);

      const rules = profileStore.resolvePoliciesForStage({
        stage: 'task_submit',
        profile: {
          id: 'explicit-profile',
          defaults: { mode: 'warn' },
          policy_overrides: {},
        },
      });

      expect(rules).toHaveLength(1);
      expect(rules[0]).toMatchObject({
        id: 'rule-explicit',
        profile_id: 'explicit-profile',
      });
    });

    it('uses later applicable profiles to override earlier bindings and sorts the result', () => {
      db = createMockDb({
        policy_profiles: [
          makeProfileRow({ id: 'global-profile' }),
          makeProfileRow({ id: 'project-profile', project: 'Torque' }),
        ],
        policy_rules: [
          makeRuleRow({ id: 'rule-first', stage: 'task_submit', priority: 5 }),
          makeRuleRow({ id: 'rule-disabled-base', stage: 'task_submit', priority: 10, enabled: false }),
          makeRuleRow({ id: 'rule-top-disabled-binding', stage: 'task_submit', priority: 12 }),
          makeRuleRow({ id: 'rule-shared', stage: 'task_submit', priority: 20, mode: 'warn' }),
          makeRuleRow({ id: 'rule-other-stage', stage: 'task_complete', priority: 1 }),
        ],
        policy_bindings: [
          makeBindingRow({
            id: 'binding-global-shared',
            profile_id: 'global-profile',
            policy_id: 'rule-shared',
            mode_override: 'warn',
          }),
          makeBindingRow({
            id: 'binding-project-first',
            profile_id: 'project-profile',
            policy_id: 'rule-first',
          }),
          makeBindingRow({
            id: 'binding-project-disabled-base',
            profile_id: 'project-profile',
            policy_id: 'rule-disabled-base',
            binding_json: { enabled: true },
          }),
          makeBindingRow({
            id: 'binding-project-disabled-row',
            profile_id: 'project-profile',
            policy_id: 'rule-top-disabled-binding',
            enabled: false,
          }),
          makeBindingRow({
            id: 'binding-project-shared',
            profile_id: 'project-profile',
            policy_id: 'rule-shared',
            mode_override: 'block',
          }),
          makeBindingRow({
            id: 'binding-project-other-stage',
            profile_id: 'project-profile',
            policy_id: 'rule-other-stage',
          }),
        ],
      });
      profileStore.setDb(db);

      const rules = profileStore.resolvePoliciesForStage({
        stage: 'task_submit',
        project_id: 'Torque',
      });

      expect(rules.map((rule) => rule.id)).toEqual([
        'rule-first',
        'rule-disabled-base',
        'rule-shared',
      ]);
      expect(rules.find((rule) => rule.id === 'rule-disabled-base')).toMatchObject({
        enabled: true,
      });
      expect(rules.find((rule) => rule.id === 'rule-shared')).toMatchObject({
        profile_id: 'project-profile',
        mode: 'block',
      });
      expect(rules.some((rule) => rule.id === 'rule-top-disabled-binding')).toBe(false);
      expect(rules.some((rule) => rule.id === 'rule-other-stage')).toBe(false);
    });
  });
});
