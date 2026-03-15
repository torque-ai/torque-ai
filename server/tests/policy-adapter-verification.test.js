'use strict';

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const SUBJECT_MODULE = '../policy-engine/adapters/verification';
const MATCHERS_MODULE = '../policy-engine/matchers';
const realMatchers = require(MATCHERS_MODULE);
const subjectPath = require.resolve(SUBJECT_MODULE);
const matchersPath = require.resolve(MATCHERS_MODULE);

function loadSubject(options = {}) {
  const matchers = {
    normalizePath: vi.fn(options.normalizePath || ((value) => realMatchers.normalizePath(value))),
    extractChangedFiles: vi.fn(
      options.extractChangedFiles || ((context) => realMatchers.extractChangedFiles(context)),
    ),
    matchesAnyGlob: vi.fn(
      options.matchesAnyGlob || ((candidate, globs) => realMatchers.matchesAnyGlob(candidate, globs)),
    ),
  };

  delete require.cache[subjectPath];
  delete require.cache[matchersPath];
  installMock(MATCHERS_MODULE, matchers);

  return {
    matchers,
    ...require(SUBJECT_MODULE),
  };
}

function getEvidence(evidence, type) {
  return evidence.find((entry) => entry.type === type);
}

function createEmptyCategories() {
  return {
    code: [],
    test: [],
    schema: [],
    docs: [],
    config: [],
  };
}

afterEach(() => {
  delete require.cache[subjectPath];
  delete require.cache[matchersPath];
  vi.clearAllMocks();
});

describe('policy-engine/adapters/verification', () => {
  it('returns unavailable evidence when verification metadata and changed files are missing', () => {
    const { collectVerificationEvidence, matchers } = loadSubject();

    const evidence = collectVerificationEvidence({});

    expect(matchers.extractChangedFiles).toHaveBeenCalledWith({});
    expect(getEvidence(evidence, 'verify_command_passed')).toEqual({
      type: 'verify_command_passed',
      available: false,
      satisfied: false,
    });
    expect(getEvidence(evidence, 'test_command_passed')).toEqual({
      type: 'test_command_passed',
      available: false,
      satisfied: false,
    });
    expect(getEvidence(evidence, 'build_command_passed')).toEqual({
      type: 'build_command_passed',
      available: false,
      satisfied: false,
    });
    expect(getEvidence(evidence, 'changed_files_classified')).toEqual({
      type: 'changed_files_classified',
      available: false,
      satisfied: false,
      value: [],
      categories: createEmptyCategories(),
      by_file: [],
      unclassified: [],
    });
  });

  it('normalizes string and numeric verification outcomes', () => {
    const { collectVerificationEvidence } = loadSubject();

    const evidence = collectVerificationEvidence({
      task: {
        verification_passed: ' passed ',
        test_passed: 0,
        build_passed: 'YES',
      },
    });

    expect(getEvidence(evidence, 'verify_command_passed')).toEqual({
      type: 'verify_command_passed',
      available: true,
      satisfied: true,
    });
    expect(getEvidence(evidence, 'test_command_passed')).toEqual({
      type: 'test_command_passed',
      available: true,
      satisfied: false,
    });
    expect(getEvidence(evidence, 'build_command_passed')).toEqual({
      type: 'build_command_passed',
      available: true,
      satisfied: true,
    });
  });

  it('treats unrecognized verification strings as unavailable', () => {
    const { collectVerificationEvidence } = loadSubject();

    const evidence = collectVerificationEvidence({
      task: {
        verification_passed: 'sometimes',
        test_passed: '  ',
        build_passed: 'unknown',
      },
    });

    expect(getEvidence(evidence, 'verify_command_passed')).toEqual({
      type: 'verify_command_passed',
      available: false,
      satisfied: false,
    });
    expect(getEvidence(evidence, 'test_command_passed')).toEqual({
      type: 'test_command_passed',
      available: false,
      satisfied: false,
    });
    expect(getEvidence(evidence, 'build_command_passed')).toEqual({
      type: 'build_command_passed',
      available: false,
      satisfied: false,
    });
  });

  it('classifies extracted changed files across overlapping categories', () => {
    const { collectVerificationEvidence } = loadSubject();

    const evidence = collectVerificationEvidence({
      changed_files: [
        'server\\policy-engine\\adapters\\verification.js',
        'server/tests/user-schema.test.js',
        'server/db/migrations/001-init.sql',
        'docs/README.md',
        'server/package.json',
      ],
    });
    const changedFiles = getEvidence(evidence, 'changed_files_classified');

    expect(changedFiles).toMatchObject({
      type: 'changed_files_classified',
      available: true,
      satisfied: true,
      value: [
        'server/policy-engine/adapters/verification.js',
        'server/tests/user-schema.test.js',
        'server/db/migrations/001-init.sql',
        'docs/README.md',
        'server/package.json',
      ],
      unclassified: [],
    });
    expect(changedFiles.categories).toEqual({
      code: [
        'server/policy-engine/adapters/verification.js',
        'server/tests/user-schema.test.js',
      ],
      test: ['server/tests/user-schema.test.js'],
      schema: [
        'server/tests/user-schema.test.js',
        'server/db/migrations/001-init.sql',
      ],
      docs: ['docs/README.md'],
      config: ['server/package.json'],
    });
    expect(changedFiles.by_file).toEqual([
      {
        path: 'server/policy-engine/adapters/verification.js',
        categories: ['code'],
      },
      {
        path: 'server/tests/user-schema.test.js',
        categories: ['code', 'test', 'schema'],
      },
      {
        path: 'server/db/migrations/001-init.sql',
        categories: ['schema'],
      },
      {
        path: 'docs/README.md',
        categories: ['docs'],
      },
      {
        path: 'server/package.json',
        categories: ['config'],
      },
    ]);
  });

  it('marks changed-file evidence unsatisfied when any files are unclassified', () => {
    const { collectVerificationEvidence } = loadSubject();

    const changedFiles = getEvidence(
      collectVerificationEvidence({
        changed_files: ['assets/logo.png', 'README.md'],
      }),
      'changed_files_classified',
    );

    expect(changedFiles).toMatchObject({
      type: 'changed_files_classified',
      available: true,
      satisfied: false,
      value: ['assets/logo.png', 'README.md'],
      unclassified: ['assets/logo.png'],
    });
    expect(changedFiles.categories).toEqual({
      code: [],
      test: [],
      schema: [],
      docs: ['README.md'],
      config: [],
    });
    expect(changedFiles.by_file).toEqual([
      {
        path: 'assets/logo.png',
        categories: [],
      },
      {
        path: 'README.md',
        categories: ['docs'],
      },
    ]);
  });

  it('falls back to task.changed_files when extractChangedFiles does not return an array', () => {
    const { collectVerificationEvidence, matchers } = loadSubject({
      extractChangedFiles: () => null,
    });

    const changedFiles = getEvidence(
      collectVerificationEvidence({
        task: {
          changed_files: ['server\\docs\\guide.md', '', null, './server/package-lock.json'],
        },
      }),
      'changed_files_classified',
    );

    expect(matchers.extractChangedFiles).toHaveBeenCalledOnce();
    expect(changedFiles).toMatchObject({
      type: 'changed_files_classified',
      available: true,
      satisfied: true,
      value: ['server/docs/guide.md', 'server/package-lock.json'],
      unclassified: [],
    });
    expect(changedFiles.categories).toEqual({
      code: [],
      test: [],
      schema: [],
      docs: ['server/docs/guide.md'],
      config: ['server/package-lock.json'],
    });
  });

  it('falls back to task.changedFiles and treats an empty list as satisfied', () => {
    const { collectVerificationEvidence } = loadSubject({
      extractChangedFiles: () => 'not-an-array',
    });

    const changedFiles = getEvidence(
      collectVerificationEvidence({
        task: {
          changedFiles: [],
        },
      }),
      'changed_files_classified',
    );

    expect(changedFiles).toEqual({
      type: 'changed_files_classified',
      available: true,
      satisfied: true,
      value: [],
      categories: createEmptyCategories(),
      by_file: [],
      unclassified: [],
    });
  });

  it('prefers matcher-extracted changed files over task fallbacks', () => {
    const { collectVerificationEvidence } = loadSubject({
      extractChangedFiles: () => ['docs/from-matcher.md'],
    });

    const changedFiles = getEvidence(
      collectVerificationEvidence({
        task: {
          changed_files: ['assets/logo.png'],
        },
      }),
      'changed_files_classified',
    );

    expect(changedFiles).toMatchObject({
      type: 'changed_files_classified',
      available: true,
      satisfied: true,
      value: ['docs/from-matcher.md'],
      unclassified: [],
    });
    expect(changedFiles.categories.docs).toEqual(['docs/from-matcher.md']);
  });
});
