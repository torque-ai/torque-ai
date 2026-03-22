'use strict';
/* global describe, it, expect, afterEach, vi */

const path = require('path');

function installMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

const MODULE_IDS = [
  'fs',
  '../logger',
  '../policy-engine/profile-loader',
  '../policy-engine/profile-store',
  '../policy-engine/adapters/command',
  '../execution/command-policy',
  '../policy-engine/task-hooks',
  '../policy-engine/engine',
  '../policy-engine/shadow-enforcer',
];

const ORIGINAL_CACHE = new Map(
  MODULE_IDS.map((moduleId) => {
    const resolved = require.resolve(moduleId);
    return [resolved, require.cache[resolved]];
  }),
);

function restoreModuleCache() {
  for (const [resolved, entry] of ORIGINAL_CACHE.entries()) {
    if (entry) {
      require.cache[resolved] = entry;
    } else {
      delete require.cache[resolved];
    }
  }
}

function clearModuleGroup(moduleIds) {
  moduleIds.forEach((moduleId) => {
    delete require.cache[require.resolve(moduleId)];
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createLoggerMock() {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  return {
    child: vi.fn(() => child),
    __child: child,
  };
}

function createProfileSeed(overrides = {}) {
  const seed = {
    profile: {
      id: 'torque-dev',
      name: 'Torque Development Profile',
      description: 'Default policy profile for Torque development',
      project: 'torque',
      enabled: true,
      defaults: { mode: 'warn' },
    },
    exclusions: [
      ' artifacts/** ',
      'docs/**/*.md',
      '',
      null,
      0,
      false,
    ],
    rules: [
      {
        id: 'rule-a',
        name: 'Require review',
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
        id: 'rule-b',
        name: 'Defaulted rule',
        category: 'quality',
        stage: 'task_complete',
      },
    ],
    bindings: [
      {
        policy_id: 'rule-a',
        mode_override: 'warn',
      },
      {
        id: 'binding-b',
        policy_id: 'rule-b',
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
  return {
    savePolicyProfile: vi.fn((profile) => ({
      ...clone(profile),
      created_at: '2026-03-12T00:00:00.000Z',
      updated_at: '2026-03-12T00:00:00.000Z',
    })),
    savePolicyRule: vi.fn((rule) => ({
      ...clone(rule),
      created_at: '2026-03-12T00:00:01.000Z',
      updated_at: '2026-03-12T00:00:01.000Z',
    })),
    savePolicyBinding: vi.fn((binding) => ({
      ...clone(binding),
      created_at: '2026-03-12T00:00:02.000Z',
      updated_at: '2026-03-12T00:00:02.000Z',
    })),
  };
}

function loadProfileLoader(options = {}) {
  restoreModuleCache();
  clearModuleGroup([
    'fs',
    '../logger',
    '../policy-engine/profile-loader',
    '../policy-engine/profile-store',
  ]);

  const fsMock = createFsMock(options.files);
  const loggerMock = createLoggerMock();
  const profileStoreMock = createProfileStoreMock();

  installMock('fs', fsMock);
  installMock('../logger', loggerMock);
  installMock('../policy-engine/profile-store', profileStoreMock);

  return {
    subject: require('../policy-engine/profile-loader'),
    mocks: {
      fs: fsMock,
      logger: loggerMock,
      profileStore: profileStoreMock,
    },
  };
}

function loadCommandAdapter(validationResult) {
  restoreModuleCache();
  clearModuleGroup([
    '../policy-engine/adapters/command',
    '../execution/command-policy',
  ]);

  const validateCommand = vi.fn(
    typeof validationResult === 'function'
      ? validationResult
      : () => (validationResult || { allowed: true })
  );

  installMock('../execution/command-policy', { validateCommand });

  return {
    subject: require('../policy-engine/adapters/command'),
    mocks: { validateCommand },
  };
}

function createEngineResult(summaryOverrides = {}, extra = {}) {
  return {
    summary: {
      failed: 0,
      warned: 0,
      blocked: 0,
      ...summaryOverrides,
    },
    results: [],
    ...extra,
  };
}

function loadTaskHooks(options = {}) {
  restoreModuleCache();
  clearModuleGroup([
    '../logger',
    '../policy-engine/task-hooks',
    '../policy-engine/engine',
    '../policy-engine/shadow-enforcer',
  ]);

  const loggerMock = createLoggerMock();
  const engineMock = {
    evaluatePolicies: vi.fn(
      options.evaluatePolicies || (() => createEngineResult()),
    ),
  };
  const shadowEnforcerMock = {
    isEngineEnabled: vi.fn(() => (
      Object.prototype.hasOwnProperty.call(options, 'engineEnabled')
        ? options.engineEnabled
        : true
    )),
    isShadowOnly: vi.fn(() => (
      Object.prototype.hasOwnProperty.call(options, 'shadowOnly')
        ? options.shadowOnly
        : false
    )),
  };

  installMock('../logger', loggerMock);
  installMock('../policy-engine/engine', engineMock);
  installMock('../policy-engine/shadow-enforcer', shadowEnforcerMock);

  return {
    subject: require('../policy-engine/task-hooks'),
    mocks: {
      engine: engineMock,
      shadowEnforcer: shadowEnforcerMock,
      logger: loggerMock,
    },
  };
}

afterEach(() => {
  vi.clearAllMocks();
  restoreModuleCache();
});

describe('policy profile/hooks coverage suite', () => {
  describe('policy-engine/profile-loader', () => {
    it('loadProfileSeed parses an existing seed file', () => {
      const seed = createProfileSeed();
      const seedPath = path.join(process.cwd(), 'fixtures', 'policy.seed.json');
      const { subject, mocks } = loadProfileLoader({
        files: {
          [seedPath]: JSON.stringify(seed),
        },
      });

      expect(subject.loadProfileSeed(seedPath)).toEqual(seed);
      expect(mocks.fs.existsSync).toHaveBeenCalledWith(seedPath);
      expect(mocks.fs.readFileSync).toHaveBeenCalledWith(seedPath, 'utf8');
      expect(mocks.logger.child).toHaveBeenCalledWith({ component: 'policy-profile-loader' });
    });

    it('loadProfileSeed returns null and warns when the file is missing', () => {
      const seedPath = path.join(process.cwd(), 'fixtures', 'missing.seed.json');
      const { subject, mocks } = loadProfileLoader();

      expect(subject.loadProfileSeed(seedPath)).toBeNull();
      expect(mocks.fs.readFileSync).not.toHaveBeenCalled();
      expect(mocks.logger.__child.warn).toHaveBeenCalledWith(
        `Profile seed not found: ${seedPath}`,
      );
    });

    it('loadProfileSeed returns null and logs error for malformed JSON', () => {
      const seedPath = path.join(process.cwd(), 'fixtures', 'bad.seed.json');
      const { subject, mocks } = loadProfileLoader({
        files: {
          [seedPath]: '{"profile":',
        },
      });

      expect(subject.loadProfileSeed(seedPath)).toBeNull();
      expect(mocks.fs.readFileSync).toHaveBeenCalledWith(seedPath, 'utf8');
      expect(mocks.logger.__child.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to parse profile seed'),
      );
    });

    it('applyProfileSeed throws when the profile section is missing', () => {
      const { subject } = loadProfileLoader();

      expect(() => subject.applyProfileSeed({ rules: [], bindings: [] })).toThrow(
        'Invalid profile seed: missing profile section',
      );
    });

    it('applyProfileSeed normalizes exclusions for the saved profile payload', () => {
      const seed = createProfileSeed({
        exclusions: [' src/**/*.tmp ', '', null, false, 0, 'docs/**/*.md'],
      });
      const { subject, mocks } = loadProfileLoader();

      const result = subject.applyProfileSeed(seed);

      expect(mocks.profileStore.savePolicyProfile).toHaveBeenCalledWith({
        id: 'torque-dev',
        name: 'Torque Development Profile',
        description: 'Default policy profile for Torque development',
        project: 'torque',
        enabled: true,
        defaults: { mode: 'warn' },
        profile_json: {
          ...seed.profile,
          exclusions: ['src/**/*.tmp', 'docs/**/*.md'],
        },
      });
      expect(result.profile.profile_json.exclusions).toEqual(['src/**/*.tmp', 'docs/**/*.md']);
    });

    it('applyProfileSeed merges matcher exclusions without duplicates', () => {
      const seed = createProfileSeed();
      const { subject, mocks } = loadProfileLoader();

      subject.applyProfileSeed(seed);

      expect(mocks.profileStore.savePolicyRule).toHaveBeenNthCalledWith(1, {
        id: 'rule-a',
        name: 'Require review',
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
    });

    it('applyProfileSeed converts non-object matchers into matcher objects with exclusions', () => {
      const seed = createProfileSeed({
        rules: [
          {
            id: 'rule-weird-matcher',
            name: 'Weird matcher',
            category: 'quality',
            stage: 'task_complete',
            matcher: 'not-an-object',
          },
        ],
      });
      const { subject, mocks } = loadProfileLoader();

      subject.applyProfileSeed(seed);

      expect(mocks.profileStore.savePolicyRule).toHaveBeenCalledWith({
        id: 'rule-weird-matcher',
        name: 'Weird matcher',
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
    });

    it('applyProfileSeed applies rule defaults when optional rule fields are omitted', () => {
      const seed = createProfileSeed({
        rules: [
          {
            id: 'rule-defaults',
            name: 'Defaults',
            category: 'quality',
            stage: 'task_complete',
            priority: 0,
            matcher: {},
          },
        ],
        exclusions: [],
      });
      const { subject, mocks } = loadProfileLoader();

      subject.applyProfileSeed(seed);

      expect(mocks.profileStore.savePolicyRule).toHaveBeenCalledWith({
        id: 'rule-defaults',
        name: 'Defaults',
        category: 'quality',
        stage: 'task_complete',
        mode: 'advisory',
        priority: 100,
        enabled: true,
        matcher: {},
        required_evidence: [],
        actions: [],
        override_policy: {},
        tags: [],
      });
    });

    it('applyProfileSeed preserves explicit disabled flags and binding ids', () => {
      const seed = createProfileSeed({
        profile: {
          enabled: false,
          description: '',
          project: '',
          defaults: null,
        },
        rules: [
          {
            id: 'rule-disabled',
            name: 'Disabled rule',
            category: 'risk',
            stage: 'task_submit',
            enabled: false,
            matcher: {},
          },
        ],
        bindings: [
          {
            id: 'binding-explicit',
            policy_id: 'rule-disabled',
            mode_override: '',
            enabled: false,
          },
        ],
      });
      const { subject, mocks } = loadProfileLoader();

      const result = subject.applyProfileSeed(seed);

      expect(result.profile).toMatchObject({
        enabled: false,
        description: '',
        project: null,
        defaults: {},
      });
      expect(mocks.profileStore.savePolicyRule).toHaveBeenCalledWith({
        id: 'rule-disabled',
        name: 'Disabled rule',
        category: 'risk',
        stage: 'task_submit',
        mode: 'advisory',
        priority: 100,
        enabled: false,
        matcher: {
          exclude_globs_any: ['artifacts/**', 'docs/**/*.md'],
        },
        required_evidence: [],
        actions: [],
        override_policy: {},
        tags: [],
      });
      expect(mocks.profileStore.savePolicyBinding).toHaveBeenCalledWith({
        id: 'binding-explicit',
        profile_id: 'torque-dev',
        policy_id: 'rule-disabled',
        mode_override: null,
        enabled: false,
      });
    });

    it('applyProfileSeed supports null rule and binding arrays', () => {
      const seed = createProfileSeed({
        rules: null,
        bindings: null,
      });
      const { subject, mocks } = loadProfileLoader();

      const result = subject.applyProfileSeed(seed);

      expect(result.rules).toEqual([]);
      expect(result.bindings).toEqual([]);
      expect(mocks.profileStore.savePolicyRule).not.toHaveBeenCalled();
      expect(mocks.profileStore.savePolicyBinding).not.toHaveBeenCalled();
      expect(mocks.logger.__child.info).toHaveBeenNthCalledWith(
        2,
        'Loaded 0 policy rules',
      );
      expect(mocks.logger.__child.info).toHaveBeenNthCalledWith(
        3,
        'Loaded 0 policy bindings',
      );
    });

    it('loadTorqueDefaults resolves the conventional path under an explicit project root', () => {
      const seed = createProfileSeed();
      const projectRoot = path.join(process.cwd(), 'sample-project');
      const seedPath = path.join(
        projectRoot,
        'artifacts',
        'policy',
        'config',
        'torque-dev-policy.seed.json',
      );
      const { subject, mocks } = loadProfileLoader({
        files: {
          [seedPath]: JSON.stringify(seed),
        },
      });

      const result = subject.loadTorqueDefaults(projectRoot);

      expect(mocks.fs.existsSync).toHaveBeenCalledWith(seedPath);
      expect(result.profile.id).toBe('torque-dev');
      expect(result.rules).toHaveLength(2);
      expect(result.bindings).toHaveLength(2);
    });

    it('loadTorqueDefaults falls back to process.cwd when projectRoot is omitted', () => {
      const seed = createProfileSeed();
      const seedPath = path.join(
        process.cwd(),
        'artifacts',
        'policy',
        'config',
        'torque-dev-policy.seed.json',
      );
      const { subject, mocks } = loadProfileLoader({
        files: {
          [seedPath]: JSON.stringify(seed),
        },
      });

      const result = subject.loadTorqueDefaults();

      expect(mocks.fs.existsSync).toHaveBeenCalledWith(seedPath);
      expect(result.profile.name).toBe('Torque Development Profile');
    });

    it('loadTorqueDefaults returns null and skips persistence when the seed is absent', () => {
      const projectRoot = path.join(process.cwd(), 'missing-project');
      const seedPath = path.join(
        projectRoot,
        'artifacts',
        'policy',
        'config',
        'torque-dev-policy.seed.json',
      );
      const { subject, mocks } = loadProfileLoader();

      expect(subject.loadTorqueDefaults(projectRoot)).toBeNull();
      expect(mocks.fs.existsSync).toHaveBeenCalledWith(seedPath);
      expect(mocks.profileStore.savePolicyProfile).not.toHaveBeenCalled();
      expect(mocks.profileStore.savePolicyRule).not.toHaveBeenCalled();
      expect(mocks.profileStore.savePolicyBinding).not.toHaveBeenCalled();
    });
  });

  describe('policy-engine/adapters/command', () => {
    it.each([
      ['missing command', { profile: 'safe_verify' }],
      ['array command', { command: ['npm', 'test'], profile: 'safe_verify' }],
      ['object without command keys', { command: { value: 'npm' }, profile: 'safe_verify' }],
      ['object with blank cmd', { command: { cmd: '   ' }, profile: 'safe_verify' }],
    ])('returns unavailable evidence for %s', (_label, context) => {
      const { subject, mocks } = loadCommandAdapter();

      expect(subject.collectCommandPolicyEvidence(context)).toEqual({
        type: 'command_profile_valid',
        available: false,
        satisfied: null,
        value: { reason: 'command is unavailable' },
      });
      expect(mocks.validateCommand).not.toHaveBeenCalled();
    });

    it('does not fall back when the first defined command is blank', () => {
      const { subject, mocks } = loadCommandAdapter();

      const evidence = subject.collectCommandPolicyEvidence({
        command: '   ',
        task: {
          command: 'npm',
          profile: 'build',
        },
        profile: 'safe_verify',
      });

      expect(evidence).toEqual({
        type: 'command_profile_valid',
        available: false,
        satisfied: null,
        value: { reason: 'command is unavailable' },
      });
      expect(mocks.validateCommand).not.toHaveBeenCalled();
    });

    it('falls back from a null command to task.cmd', () => {
      const { subject, mocks } = loadCommandAdapter({ allowed: true });

      subject.collectCommandPolicyEvidence({
        command: null,
        profile: 'safe_verify',
        task: {
          cmd: 'git',
        },
      });

      expect(mocks.validateCommand).toHaveBeenCalledWith(
        'git',
        undefined,
        'safe_verify',
        {
          dangerous: false,
          source: 'policy-engine.command-adapter',
          caller: 'collectCommandPolicyEvidence',
        },
      );
    });

    it('passes command objects with a cmd field through to validateCommand', () => {
      const command = { cmd: 'node', cwd: 'C:\\repo' };
      const { subject, mocks } = loadCommandAdapter({ allowed: true });

      subject.collectCommandPolicyEvidence({
        command,
        profile: 'safe_verify',
      });

      expect(mocks.validateCommand).toHaveBeenCalledWith(
        command,
        undefined,
        'safe_verify',
        expect.any(Object),
      );
    });

    it('passes command objects with a command field through to validateCommand', () => {
      const command = { command: 'npm', shell: false };
      const { subject, mocks } = loadCommandAdapter({ allowed: true });

      subject.collectCommandPolicyEvidence({
        task: {
          command,
          profile: 'safe_verify',
        },
      });

      expect(mocks.validateCommand).toHaveBeenCalledWith(
        command,
        undefined,
        'safe_verify',
        expect.any(Object),
      );
    });

    it('returns unavailable evidence when the profile is missing', () => {
      const { subject, mocks } = loadCommandAdapter();

      expect(subject.collectCommandPolicyEvidence({ command: 'npm' })).toEqual({
        type: 'command_profile_valid',
        available: false,
        satisfied: null,
        value: { reason: 'command profile is unavailable' },
      });
      expect(mocks.validateCommand).not.toHaveBeenCalled();
    });

    it('does not fall back when the first defined profile is blank', () => {
      const { subject, mocks } = loadCommandAdapter();

      const evidence = subject.collectCommandPolicyEvidence({
        command: 'npm',
        profile: '   ',
        task: {
          profile: 'build',
        },
      });

      expect(evidence).toEqual({
        type: 'command_profile_valid',
        available: false,
        satisfied: null,
        value: { reason: 'command profile is unavailable' },
      });
      expect(mocks.validateCommand).not.toHaveBeenCalled();
    });

    it('falls back from a null profile to task.commandProfile', () => {
      const { subject, mocks } = loadCommandAdapter({ allowed: true });

      subject.collectCommandPolicyEvidence({
        command: 'npm',
        profile: null,
        task: {
          commandProfile: ' build ',
        },
      });

      expect(mocks.validateCommand).toHaveBeenCalledWith(
        'npm',
        undefined,
        'build',
        expect.any(Object),
      );
    });

    it('prefers args over command_args, commandArgs, and task aliases', () => {
      const { subject, mocks } = loadCommandAdapter({ allowed: true });

      subject.collectCommandPolicyEvidence({
        command: 'git',
        profile: 'safe_verify',
        args: ['status'],
        command_args: ['log'],
        commandArgs: ['diff'],
        task: {
          args: ['pull'],
          command_args: ['push'],
          commandArgs: ['fetch'],
        },
      });

      expect(mocks.validateCommand).toHaveBeenCalledWith(
        'git',
        ['status'],
        'safe_verify',
        expect.any(Object),
      );
    });

    it('falls through null args to task.command_args', () => {
      const { subject, mocks } = loadCommandAdapter({ allowed: true });

      subject.collectCommandPolicyEvidence({
        command: 'git',
        profile: 'safe_verify',
        args: null,
        command_args: null,
        task: {
          command_args: ['status', '--short'],
        },
      });

      expect(mocks.validateCommand).toHaveBeenCalledWith(
        'git',
        ['status', '--short'],
        'safe_verify',
        expect.any(Object),
      );
    });

    it('uses explicit metadata aliases and trims the selected profile', () => {
      const { subject, mocks } = loadCommandAdapter({
        allowed: false,
        reason: 'blocked by profile',
      });

      const evidence = subject.collectCommandPolicyEvidence({
        cmd: 'npx',
        commandArgs: ['vitest', 'run'],
        command_profile: ' advanced_shell ',
        dangerous: true,
        source: 'policy-test',
        caller: 'manual-check',
      });

      expect(mocks.validateCommand).toHaveBeenCalledWith(
        'npx',
        ['vitest', 'run'],
        'advanced_shell',
        {
          dangerous: true,
          source: 'policy-test',
          caller: 'manual-check',
        },
      );
      expect(evidence).toEqual({
        type: 'command_profile_valid',
        available: true,
        satisfied: false,
        value: { reason: 'blocked by profile' },
      });
    });

    it('defaults metadata and only treats dangerous === true as dangerous', () => {
      const { subject, mocks } = loadCommandAdapter({
        allowed: false,
        reason: 'task command rejected',
      });

      const evidence = subject.collectCommandPolicyEvidence({
        task: {
          command: 'node',
          commandProfile: 'safe_verify',
          dangerous: 'yes',
        },
      });

      expect(mocks.validateCommand).toHaveBeenCalledWith(
        'node',
        undefined,
        'safe_verify',
        {
          dangerous: false,
          source: 'policy-engine.command-adapter',
          caller: 'collectCommandPolicyEvidence',
        },
      );
      expect(evidence).toEqual({
        type: 'command_profile_valid',
        available: true,
        satisfied: false,
        value: { reason: 'task command rejected' },
      });
    });
  });

  describe('policy-engine/task-hooks', () => {
    it('evaluateAtStage skips evaluation when the engine is disabled', () => {
      const { subject, mocks } = loadTaskHooks({ engineEnabled: false });

      expect(subject.evaluateAtStage('task_submit', { id: 'task-disabled' })).toEqual({
        skipped: true,
        reason: 'policy_engine_disabled',
      });
      expect(mocks.engine.evaluatePolicies).not.toHaveBeenCalled();
      expect(mocks.shadowEnforcer.isShadowOnly).not.toHaveBeenCalled();
    });

    it('evaluateAtStage uses snake_case option overrides before task data', () => {
      const { subject, mocks } = loadTaskHooks();

      subject.evaluateAtStage(
        'task_pre_execute',
        {
          id: 'task-1',
          target_type: 'task',
          target_id: 'task-target',
          project: 'Torque',
          working_directory: 'C:\\repo',
          provider: 'codex',
          changed_files: ['server/a.js'],
          command: 'npm test',
          release_id: 'release-1',
          evidence: { review: true },
        },
        {
          target_type: 'workflow',
          target_id: 'workflow-9',
        },
      );

      expect(mocks.engine.evaluatePolicies).toHaveBeenCalledWith({
        stage: 'task_pre_execute',
        target_type: 'workflow',
        target_id: 'workflow-9',
        project_id: 'Torque',
        project_path: 'C:\\repo',
        provider: 'codex',
        changed_files: ['server/a.js'],
        command: 'npm test',
        release_id: 'release-1',
        evidence: { review: true },
        persist: true,
      });
    });

    it('evaluateAtStage uses camelCase option overrides when snake_case options are absent', () => {
      const { subject, mocks } = loadTaskHooks();

      subject.evaluateAtStage(
        'task_pre_execute',
        {
          id: 'task-2',
          targetType: 'task',
          targetId: 'task-target',
        },
        {
          targetType: 'release',
          targetId: 'release-22',
        },
      );

      expect(mocks.engine.evaluatePolicies).toHaveBeenCalledWith(
        expect.objectContaining({
          target_type: 'release',
          target_id: 'release-22',
        }),
      );
    });

    it('evaluateAtStage falls back through task ids and default evidence fields', () => {
      const { subject, mocks } = loadTaskHooks();

      subject.evaluateAtStage('task_submit', {
        taskId: 'task-fallback',
        project_id: 'Torque',
        workingDirectory: 'C:\\work\\Torque',
        changedFiles: ['server/policy-engine/task-hooks.js'],
        releaseId: 'release-42',
      });

      expect(mocks.engine.evaluatePolicies).toHaveBeenCalledWith({
        stage: 'task_submit',
        target_type: 'task',
        target_id: 'task-fallback',
        project_id: 'Torque',
        project_path: 'C:\\work\\Torque',
        provider: null,
        changed_files: ['server/policy-engine/task-hooks.js'],
        command: null,
        release_id: 'release-42',
        evidence: {},
        persist: true,
      });
    });

    it('evaluateAtStage returns blocked false in live mode when nothing blocks', () => {
      const { subject } = loadTaskHooks({
        evaluatePolicies: () => createEngineResult({ failed: 1, warned: 1, blocked: 0 }),
      });

      expect(subject.evaluateAtStage('task_submit', { id: 'task-pass' })).toEqual({
        summary: {
          failed: 1,
          warned: 1,
          blocked: 0,
        },
        results: [],
        shadow: false,
        blocked: false,
      });
    });

    it('evaluateAtStage returns blocked true in live mode when blocking results exist', () => {
      const { subject } = loadTaskHooks({
        evaluatePolicies: () => createEngineResult({ failed: 1, blocked: 2 }),
      });

      expect(subject.evaluateAtStage('task_submit', { id: 'task-blocked' })).toEqual({
        summary: {
          failed: 1,
          warned: 0,
          blocked: 2,
        },
        results: [],
        shadow: false,
        blocked: true,
      });
    });

    it('evaluateAtStage logs shadow failures and warnings as non-blocking', () => {
      const { subject, mocks } = loadTaskHooks({
        shadowOnly: true,
        evaluatePolicies: () => createEngineResult(
          { failed: 2, warned: 1, blocked: 4 },
          { results: [{ policy_id: 'p-1' }] },
        ),
      });

      expect(subject.evaluateAtStage('task_complete', { id: 'task-shadow' })).toEqual({
        summary: {
          failed: 2,
          warned: 1,
          blocked: 4,
        },
        results: [{ policy_id: 'p-1' }],
        shadow: true,
        blocked: false,
      });
      expect(mocks.logger.__child.info).toHaveBeenCalledWith(
        '[Shadow] task_complete: 2 fail, 1 warn (non-blocking)',
      );
    });

    it('evaluateAtStage does not log shadow info when there are no failures or warnings', () => {
      const { subject, mocks } = loadTaskHooks({
        shadowOnly: true,
        evaluatePolicies: () => createEngineResult({ blocked: 2 }),
      });

      const result = subject.evaluateAtStage('task_complete', { id: 'task-shadow-clean' });

      expect(result.shadow).toBe(true);
      expect(result.blocked).toBe(false);
      expect(mocks.logger.__child.info).not.toHaveBeenCalled();
    });

    it('evaluateAtStage returns evaluation_error details when the engine throws', () => {
      const { subject, mocks } = loadTaskHooks({
        evaluatePolicies: () => {
          throw new Error('evaluation exploded');
        },
      });

      expect(subject.evaluateAtStage('manual_review', { id: 'task-error' })).toEqual({
        skipped: true,
        reason: 'evaluation_error',
        error: 'evaluation exploded',
      });
      expect(mocks.logger.__child.warn).toHaveBeenCalledWith(
        'Policy evaluation error at manual_review: evaluation exploded',
      );
    });

    it.each([
      ['onTaskSubmit', 'task_submit'],
      ['evaluateTaskSubmissionPolicy', 'task_submit'],
      ['onTaskPreExecute', 'task_pre_execute'],
      ['onTaskComplete', 'task_complete'],
    ])('%s evaluates the %s lifecycle stage', (hookName, stage) => {
      const { subject, mocks } = loadTaskHooks();

      const result = subject[hookName]({
        id: 'task-123',
        project: 'Torque',
        working_directory: 'C:\\repo\\Torque',
      });

      expect(mocks.engine.evaluatePolicies).toHaveBeenCalledWith({
        stage,
        target_type: 'task',
        target_id: 'task-123',
        project_id: 'Torque',
        project_path: 'C:\\repo\\Torque',
        provider: null,
        changed_files: null,
        command: null,
        release_id: null,
        evidence: {},
        persist: true,
      });
      expect(result.shadow).toBe(false);
    });

    it('onManualReview defaults to release targets and prefers release ids', () => {
      const { subject, mocks } = loadTaskHooks();

      subject.onManualReview({
        id: 'task-456',
        releaseId: 'release-7',
        project: 'Torque',
      });

      expect(mocks.engine.evaluatePolicies).toHaveBeenCalledWith({
        stage: 'manual_review',
        target_type: 'release',
        target_id: 'release-7',
        project_id: 'Torque',
        project_path: null,
        provider: null,
        changed_files: null,
        command: null,
        release_id: 'release-7',
        evidence: {},
        persist: true,
      });
    });

    it('onManualReview falls back to target ids and finally unknown when release ids are absent', () => {
      const { subject, mocks } = loadTaskHooks();

      subject.onManualReview({
        targetType: 'release_candidate',
        targetId: 'target-9',
      });
      subject.onManualReview({});

      expect(mocks.engine.evaluatePolicies).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          stage: 'manual_review',
          target_type: 'release_candidate',
          target_id: 'target-9',
        }),
      );
      expect(mocks.engine.evaluatePolicies).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          stage: 'manual_review',
          target_type: 'release',
          target_id: 'unknown',
        }),
      );
    });

    it('preserves hook invocation order across submit, pre-execute, complete, and manual review', () => {
      const contexts = [];
      const { subject } = loadTaskHooks({
        evaluatePolicies: (context) => {
          contexts.push({ stage: context.stage, target_id: context.target_id });
          return createEngineResult();
        },
      });

      subject.onTaskSubmit({ id: 'task-1' });
      subject.onTaskPreExecute({ id: 'task-1' });
      subject.onTaskComplete({ id: 'task-1' });
      subject.onManualReview({ id: 'task-1', release_id: 'release-1' });

      expect(contexts).toEqual([
        { stage: 'task_submit', target_id: 'task-1' },
        { stage: 'task_pre_execute', target_id: 'task-1' },
        { stage: 'task_complete', target_id: 'task-1' },
        { stage: 'manual_review', target_id: 'release-1' },
      ]);
    });
  });
});
