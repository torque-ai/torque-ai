'use strict';
/* global describe, it, expect, afterEach, vi */

const path = require('path');

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const SUBJECT_MODULE = '../policy-engine/profile-loader';
const PROFILE_STORE_MODULE = '../policy-engine/profile-store';
const LOGGER_MODULE = '../logger';

const subjectPath = require.resolve(SUBJECT_MODULE);
const profileStorePath = require.resolve(PROFILE_STORE_MODULE);
const loggerPath = require.resolve(LOGGER_MODULE);
const fsPath = require.resolve('fs');

function clearModuleCache() {
  [
    subjectPath,
    profileStorePath,
    loggerPath,
    fsPath,
  ].forEach((moduleId) => {
    delete require.cache[moduleId];
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createSeed(overrides = {}) {
  const seed = {
    profile: {
      id: 'torque-dev',
      name: 'Torque Development Profile',
      description: 'Default policy profile for Torque development tasks',
      project: 'torque',
      enabled: true,
      defaults: { mode: 'warn' },
    },
    exclusions: [
      'artifacts/**',
      ' docs/**/*.md ',
      '',
      null,
    ],
    rules: [
      {
        id: 'rule-with-existing-exclusions',
        name: 'Review risky files',
        category: 'risk',
        stage: 'task_submit',
        mode: 'block',
        priority: 5,
        matcher: {
          changed_file_globs_any: ['server/**/*.js'],
          exclude_globs_any: ['docs/**/*.md', 'custom-ignore/**'],
        },
        required_evidence: ['human_review'],
        actions: [{ type: 'notify' }],
        override_policy: { allowed: false },
        tags: ['review'],
      },
      {
        id: 'rule-using-defaults',
        name: 'Defaulted rule',
        category: 'quality',
        stage: 'task_complete',
      },
      {
        id: 'rule-with-null-matcher',
        name: 'Null matcher rule',
        category: 'quality',
        stage: 'task_complete',
        matcher: null,
      },
    ],
    bindings: [
      {
        policy_id: 'rule-with-existing-exclusions',
        mode_override: 'warn',
      },
      {
        id: 'explicit-binding-id',
        policy_id: 'rule-using-defaults',
        enabled: false,
      },
    ],
  };

  const nextSeed = clone(seed);

  if (Object.prototype.hasOwnProperty.call(overrides, 'profile')) {
    nextSeed.profile = {
      ...nextSeed.profile,
      ...overrides.profile,
    };
  }
  if (Object.prototype.hasOwnProperty.call(overrides, 'exclusions')) {
    nextSeed.exclusions = overrides.exclusions;
  }
  if (Object.prototype.hasOwnProperty.call(overrides, 'rules')) {
    nextSeed.rules = overrides.rules;
  }
  if (Object.prototype.hasOwnProperty.call(overrides, 'bindings')) {
    nextSeed.bindings = overrides.bindings;
  }

  return nextSeed;
}

function createFsMock(files = {}) {
  const storedFiles = new Map(
    Object.entries(files).map(([filePath, content]) => [path.resolve(filePath), content]),
  );

  return {
    existsSync: vi.fn((filePath) => storedFiles.has(path.resolve(filePath))),
    readFileSync: vi.fn((filePath, encoding) => {
      if (encoding !== 'utf8') {
        throw new Error(`Unexpected encoding: ${encoding}`);
      }

      const resolved = path.resolve(filePath);
      if (!storedFiles.has(resolved)) {
        const error = new Error(`ENOENT: no such file or directory, open '${resolved}'`);
        error.code = 'ENOENT';
        throw error;
      }

      return storedFiles.get(resolved);
    }),
  };
}

function createProfileStoreMock() {
  const state = {
    profiles: [],
    rules: [],
    bindings: [],
  };
  let timestamp = 0;

  function stamp(record) {
    timestamp += 1;
    return {
      created_at: `2026-03-11T00:00:0${timestamp}.000Z`,
      updated_at: `2026-03-11T00:00:0${timestamp}.000Z`,
      ...record,
    };
  }

  return {
    savePolicyProfile: vi.fn((profile) => {
      const saved = stamp(profile);
      state.profiles.push(saved);
      return saved;
    }),
    savePolicyRule: vi.fn((rule) => {
      const saved = stamp(rule);
      state.rules.push(saved);
      return saved;
    }),
    savePolicyBinding: vi.fn((binding) => {
      const saved = stamp(binding);
      state.bindings.push(saved);
      return saved;
    }),
    __state: state,
  };
}

function loadSubject(options = {}) {
  clearModuleCache();

  const loggerInstance = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const logger = {
    child: vi.fn(() => loggerInstance),
  };
  const fs = createFsMock(options.files);
  const profileStore = createProfileStoreMock();

  installMock('fs', fs);
  installMock(PROFILE_STORE_MODULE, profileStore);
  installMock(LOGGER_MODULE, logger);

  return {
    ...require(SUBJECT_MODULE),
    __mocks: {
      fs,
      logger,
      loggerInstance,
      profileStore,
    },
  };
}

afterEach(() => {
  clearModuleCache();
  vi.clearAllMocks();
});

describe('policy-engine/profile-loader', () => {
  it('loadProfileSeed reads and parses a valid seed file', () => {
    const seed = createSeed();
    const seedPath = path.join(process.cwd(), 'fixtures', 'policy.seed.json');
    const { loadProfileSeed, __mocks } = loadSubject({
      files: {
        [seedPath]: JSON.stringify(seed),
      },
    });

    expect(loadProfileSeed(seedPath)).toEqual(seed);
    expect(__mocks.fs.existsSync).toHaveBeenCalledWith(seedPath);
    expect(__mocks.fs.readFileSync).toHaveBeenCalledWith(seedPath, 'utf8');
    expect(__mocks.logger.child).toHaveBeenCalledWith({ component: 'policy-profile-loader' });
  });

  it('loadProfileSeed returns null and warns when the seed file is missing', () => {
    const seedPath = path.join(process.cwd(), 'fixtures', 'missing.seed.json');
    const { loadProfileSeed, __mocks } = loadSubject();

    expect(loadProfileSeed(seedPath)).toBeNull();
    expect(__mocks.fs.existsSync).toHaveBeenCalledWith(seedPath);
    expect(__mocks.fs.readFileSync).not.toHaveBeenCalled();
    expect(__mocks.loggerInstance.warn).toHaveBeenCalledWith(
      `Profile seed not found: ${seedPath}`,
    );
  });

  it('loadProfileSeed returns null and logs error for malformed seed files', () => {
    const seedPath = path.join(process.cwd(), 'fixtures', 'invalid.seed.json');
    const { loadProfileSeed, __mocks } = loadSubject({
      files: {
        [seedPath]: '{"profile":',
      },
    });

    expect(loadProfileSeed(seedPath)).toBeNull();
    expect(__mocks.fs.existsSync).toHaveBeenCalledWith(seedPath);
    expect(__mocks.fs.readFileSync).toHaveBeenCalledWith(seedPath, 'utf8');
    expect(__mocks.loggerInstance.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to parse profile seed'),
    );
  });

  it('applyProfileSeed throws when the seed is missing a profile section', () => {
    const { applyProfileSeed } = loadSubject();

    expect(() => applyProfileSeed({ bindings: [], rules: [] })).toThrow(
      'Invalid profile seed: missing profile section',
    );
  });

  it('applyProfileSeed saves the profile and normalizes rule payloads with exclusions', () => {
    const seed = createSeed({
      profile: {
        description: '',
        project: '',
        enabled: false,
        defaults: null,
      },
    });
    const { applyProfileSeed, __mocks } = loadSubject();

    const result = applyProfileSeed(seed);

    expect(__mocks.profileStore.savePolicyProfile).toHaveBeenCalledTimes(1);
    expect(__mocks.profileStore.savePolicyProfile).toHaveBeenCalledWith({
      id: 'torque-dev',
      name: 'Torque Development Profile',
      description: '',
      project: null,
      enabled: false,
      defaults: {},
      profile_json: {
        ...seed.profile,
        exclusions: ['artifacts/**', 'docs/**/*.md'],
      },
    });
    expect(result.profile).toMatchObject({
      id: 'torque-dev',
      project: null,
      enabled: false,
      defaults: {},
      profile_json: {
        exclusions: ['artifacts/**', 'docs/**/*.md'],
      },
    });

    expect(__mocks.profileStore.savePolicyRule).toHaveBeenCalledTimes(3);
    expect(__mocks.profileStore.savePolicyRule).toHaveBeenNthCalledWith(1, {
      id: 'rule-with-existing-exclusions',
      name: 'Review risky files',
      category: 'risk',
      stage: 'task_submit',
      mode: 'block',
      priority: 5,
      enabled: true,
      matcher: {
        changed_file_globs_any: ['server/**/*.js'],
        exclude_globs_any: ['docs/**/*.md', 'custom-ignore/**', 'artifacts/**'],
      },
      required_evidence: ['human_review'],
      actions: [{ type: 'notify' }],
      override_policy: { allowed: false },
      tags: ['review'],
    });
    expect(__mocks.profileStore.savePolicyRule).toHaveBeenNthCalledWith(2, {
      id: 'rule-using-defaults',
      name: 'Defaulted rule',
      category: 'quality',
      stage: 'task_complete',
      mode: 'advisory',
      priority: 100,
      enabled: true,
      matcher: {
        exclude_globs_any: ['artifacts/**', 'docs/**/*.md'],
      },
      required_evidence: [],
      actions: [],
      override_policy: {},
      tags: [],
    });
    expect(__mocks.profileStore.savePolicyRule).toHaveBeenNthCalledWith(3, {
      id: 'rule-with-null-matcher',
      name: 'Null matcher rule',
      category: 'quality',
      stage: 'task_complete',
      mode: 'advisory',
      priority: 100,
      enabled: true,
      matcher: {
        exclude_globs_any: ['artifacts/**', 'docs/**/*.md'],
      },
      required_evidence: [],
      actions: [],
      override_policy: {},
      tags: [],
    });
    expect(result.rules).toHaveLength(3);
    expect(__mocks.loggerInstance.info).toHaveBeenNthCalledWith(
      1,
      'Loaded policy profile: torque-dev (Torque Development Profile)',
    );
    expect(__mocks.loggerInstance.info).toHaveBeenNthCalledWith(2, 'Loaded 3 policy rules');
  });

  it('applyProfileSeed saves seeded bindings with default ids and enabled flags', () => {
    const seed = createSeed();
    const { applyProfileSeed, __mocks } = loadSubject();

    const result = applyProfileSeed(seed);

    expect(__mocks.profileStore.savePolicyBinding).toHaveBeenCalledTimes(2);
    expect(__mocks.profileStore.savePolicyBinding).toHaveBeenNthCalledWith(1, {
      id: 'torque-dev:rule-with-existing-exclusions',
      profile_id: 'torque-dev',
      policy_id: 'rule-with-existing-exclusions',
      mode_override: 'warn',
      enabled: true,
    });
    expect(__mocks.profileStore.savePolicyBinding).toHaveBeenNthCalledWith(2, {
      id: 'explicit-binding-id',
      profile_id: 'torque-dev',
      policy_id: 'rule-using-defaults',
      mode_override: null,
      enabled: false,
    });
    expect(result.bindings).toHaveLength(2);
    expect(__mocks.loggerInstance.info).toHaveBeenNthCalledWith(3, 'Loaded 2 policy bindings');
  });

  it('loadTorqueDefaults resolves the conventional seed path and applies it', () => {
    const seed = createSeed();
    const projectRoot = path.join(process.cwd(), 'sample-project');
    const expectedPath = path.join(
      projectRoot,
      'artifacts',
      'policy',
      'config',
      'torque-dev-policy.seed.json',
    );
    const { loadTorqueDefaults, __mocks } = loadSubject({
      files: {
        [expectedPath]: JSON.stringify(seed),
      },
    });

    const result = loadTorqueDefaults(projectRoot);

    expect(__mocks.fs.existsSync).toHaveBeenCalledWith(expectedPath);
    expect(__mocks.fs.readFileSync).toHaveBeenCalledWith(expectedPath, 'utf8');
    expect(result.profile).toMatchObject({
      id: 'torque-dev',
      name: 'Torque Development Profile',
    });
    expect(result.rules).toHaveLength(seed.rules.length);
    expect(result.bindings).toHaveLength(seed.bindings.length);
    // 3 builtin profiles + 1 seed profile = 4 total
    const BUILTIN_PROFILE_COUNT = 3;
    expect(__mocks.profileStore.__state.profiles).toHaveLength(BUILTIN_PROFILE_COUNT + 1);
    expect(__mocks.profileStore.__state.rules).toHaveLength(BUILTIN_PROFILE_COUNT + seed.rules.length);
    expect(__mocks.profileStore.__state.bindings).toHaveLength(BUILTIN_PROFILE_COUNT + seed.bindings.length);
  });

  it('loadTorqueDefaults returns null and skips persistence when the conventional seed is absent', () => {
    const projectRoot = path.join(process.cwd(), 'missing-project');
    const expectedPath = path.join(
      projectRoot,
      'artifacts',
      'policy',
      'config',
      'torque-dev-policy.seed.json',
    );
    const { loadTorqueDefaults, __mocks } = loadSubject();

    expect(loadTorqueDefaults(projectRoot)).toBeNull();
    expect(__mocks.fs.existsSync).toHaveBeenCalledWith(expectedPath);
    // Builtin profiles are still loaded even when seed is absent
    const BUILTIN_PROFILE_COUNT = 3;
    expect(__mocks.profileStore.savePolicyProfile).toHaveBeenCalledTimes(BUILTIN_PROFILE_COUNT);
    expect(__mocks.profileStore.savePolicyRule).toHaveBeenCalledTimes(BUILTIN_PROFILE_COUNT);
    expect(__mocks.profileStore.savePolicyBinding).toHaveBeenCalledTimes(BUILTIN_PROFILE_COUNT);
  });
});
