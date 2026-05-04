const { collectVerificationEvidence } = require('../policy-engine/adapters/verification');

function getEvidence(evidence, type) {
  return evidence.find((entry) => entry.type === type);
}

describe('policy verification adapter', () => {
  it('marks verify evidence satisfied when verification passed', () => {
    const evidence = collectVerificationEvidence({
      task: {
        verification_passed: true,
      },
    });

    expect(getEvidence(evidence, 'verify_command_passed')).toEqual({
      type: 'verify_command_passed',
      available: true,
      satisfied: true,
    });
  });

  it('marks verify evidence unsatisfied when verification failed', () => {
    const evidence = collectVerificationEvidence({
      task: {
        verification_passed: false,
      },
    });

    expect(getEvidence(evidence, 'verify_command_passed')).toEqual({
      type: 'verify_command_passed',
      available: true,
      satisfied: false,
    });
  });

  it('marks verify evidence unavailable when no verification metadata exists', () => {
    const evidence = collectVerificationEvidence({
      task: {},
    });

    expect(getEvidence(evidence, 'verify_command_passed')).toEqual({
      type: 'verify_command_passed',
      available: false,
      satisfied: false,
    });
  });

  it('classifies changed files into policy categories', () => {
    const evidence = collectVerificationEvidence({
      changed_files: [
        'server/policy-engine/engine.js',
        'server/tests/policy-verification-adapter.test.js',
        'server\\db\\schema-migrations.js',
        'docs/policies.md',
        'server/package.json',
      ],
    });
    const changedFilesEvidence = getEvidence(evidence, 'changed_files_classified');

    expect(changedFilesEvidence).toMatchObject({
      type: 'changed_files_classified',
      available: true,
      satisfied: true,
      value: [
        'server/policy-engine/engine.js',
        'server/tests/policy-verification-adapter.test.js',
        'server/db/schema/status-validation.js',
        'docs/policies.md',
        'server/package.json',
      ],
      unclassified: [],
    });
    expect(changedFilesEvidence.categories.code).toEqual(expect.arrayContaining([
      'server/policy-engine/engine.js',
      'server/tests/policy-verification-adapter.test.js',
      'server/db/schema/status-validation.js',
    ]));
    expect(changedFilesEvidence.categories.test).toEqual(expect.arrayContaining([
      'server/tests/policy-verification-adapter.test.js',
    ]));
    expect(changedFilesEvidence.categories.schema).toEqual(expect.arrayContaining([
      'server/db/schema/status-validation.js',
    ]));
    expect(changedFilesEvidence.categories.docs).toEqual(expect.arrayContaining([
      'docs/policies.md',
    ]));
    expect(changedFilesEvidence.categories.config).toEqual(expect.arrayContaining([
      'server/package.json',
    ]));
  });

  it('surfaces missing test evidence for schema changes without test metadata', () => {
    const evidence = collectVerificationEvidence({
      task: {
        verification_passed: true,
        build_passed: true,
      },
      changed_files: ['server/db/schema/status-validation.js'],
    });

    expect(getEvidence(evidence, 'test_command_passed')).toEqual({
      type: 'test_command_passed',
      available: false,
      satisfied: false,
    });
    expect(getEvidence(evidence, 'build_command_passed')).toEqual({
      type: 'build_command_passed',
      available: true,
      satisfied: true,
    });
    expect(getEvidence(evidence, 'changed_files_classified').categories.schema).toEqual([
      'server/db/schema/status-validation.js',
    ]);
  });
});
