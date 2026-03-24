'use strict';

const {
  diagnoseFailures,
  generateFixSuggestion,
  generateTriageReport,
  MAX_LOG_INPUT,
  MAX_RAW_OUTPUT,
} = require('../ci/diagnostics');

describe('CI diagnostics parser', () => {
  it('detects test failures with file and test name', () => {
    const log = 'FAIL tests/foo.test.js > handles edge case\n   expected null to be "bar"';
    const result = diagnoseFailures(log, {});

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      category: 'test_logic',
      file: 'tests/foo.test.js',
      test_name: 'handles edge case',
    });
    expect(result.failures[0].message).toContain('expected null to be "bar"');
  });

  it('detects lint errors with line and message', () => {
    const log = '  5:7  error  Unexpected var  no-var';
    const result = diagnoseFailures(log, {});

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      category: 'lint',
      line: 5,
    });
    expect(result.failures[0].message).toContain('Unexpected var');
  });

  it('detects build errors using TypeScript error markers', () => {
    const log = 'error TS2304: Cannot find name "foo"';
    const result = diagnoseFailures(log, {});

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      category: 'build',
    });
    expect(result.failures[0].message).toContain('Cannot find name');
  });

  it('detects infrastructure errors for runner shutdown signal', () => {
    const log = '##[error]The runner has received a shutdown signal';
    const result = diagnoseFailures(log, {});

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      category: 'infra',
    });
    expect(result.failures[0].message).toContain('shutdown signal');
  });

  it('detects timeout from conclusion metadata', () => {
    const log = 'build finished with exit code 124';
    const result = diagnoseFailures(log, { conclusion: 'timed_out' });

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      category: 'infra',
    });
    expect(result.failures[0].message).toContain('timed_out');
  });

  it('categorizes unknown log content as unknown', () => {
    const log = 'the pipeline crashed in an unsupported way';
    const result = diagnoseFailures(log, {});

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      category: 'unknown',
    });
    expect(result.failures[0].message).toBe('the pipeline crashed in an unsupported way');
  });

  it('caps each failure raw_output at 4096 bytes', () => {
    const longMessage = `${'x'.repeat(4096)}  no-var`;
    const log = `  5:7  error  ${longMessage}`;
    const result = diagnoseFailures(log, {});

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].category).toBe('lint');
    expect(Buffer.byteLength(result.failures[0].raw_output, 'utf8')).toBeLessThanOrEqual(MAX_RAW_OUTPUT);
  });

  it('truncates large logs to 2MB with warning in triage', () => {
    const oversizedPayload = 'x'.repeat(MAX_LOG_INPUT + 1024);
    const log = `FAIL tests/foo.test.js > handles edge case\n   expected null to be "bar"\n${oversizedPayload}`;
    const result = diagnoseFailures(log, {});

    expect(result.failures).not.toHaveLength(0);
    expect(result.failures[0].category).toBe('test_logic');
    expect(result.triage).toContain('Warning');
    expect(result.triage).toContain('2 MB');
  });

  it('generateTriageReport returns markdown table and fix suggestions', () => {
    const log = 'FAIL tests/foo.test.js > handles edge case\n   expected null to be "bar"\nerror TS2304: Cannot find name "foo"';
    const result = diagnoseFailures(log, {});
    const report = generateTriageReport(result.failures, {});

    expect(report).toContain('| # | Category | File | Test Name | Line | Message |');
    expect(report).toContain('### Suggested Fixes');
    result.failures.forEach((failure) => {
      expect(report).toContain(generateFixSuggestion(failure));
    });
  });

  it('returns gracefully on empty/null input', () => {
    expect(diagnoseFailures('', {})).toEqual({ failures: [], triage: '' });
    expect(diagnoseFailures(null, {})).toEqual({ failures: [], triage: '' });
  });

  it('categorizes SqliteError as test_schema', () => {
    const log = 'FAIL tests/host-credentials.test.js > saves credential\nSqliteError: ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint';
    const result = diagnoseFailures(log, {});
    expect(result.failures.length).toBeGreaterThanOrEqual(1);
    const schemaFailure = result.failures.find(f => f.category === 'test_schema');
    expect(schemaFailure).toBeTruthy();
    expect(schemaFailure.message).toContain('ON CONFLICT');
  });

  it('categorizes "no column named" as test_schema', () => {
    const log = 'FAIL tests/close-handler.test.js > rollback\nSqliteError: table task_file_changes has no column named stash_ref';
    const result = diagnoseFailures(log, {});
    const schemaFailure = result.failures.find(f => f.category === 'test_schema');
    expect(schemaFailure).toBeTruthy();
  });

  it('categorizes spawn EPERM as test_platform', () => {
    const log = 'FAIL tests/bootstrap.test.js > startup\nError: spawn EPERM';
    const result = diagnoseFailures(log, {});
    const platformFailure = result.failures.find(f => f.category === 'test_platform');
    expect(platformFailure).toBeTruthy();
  });

  it('categorizes AssertionError as test_logic', () => {
    const log = "FAIL tests/handler.test.js > returns expected\nAssertionError: expected 'completed' to be 'failed'";
    const result = diagnoseFailures(log, {});
    const logicFailure = result.failures.find(f => f.category === 'test_logic');
    expect(logicFailure).toBeTruthy();
  });

  it('maps infrastructure category to infra', () => {
    const log = '##[error] Runner received shutdown signal';
    const result = diagnoseFailures(log, {});
    expect(result.failures[0].category).toBe('infra');
  });

  it('maps timeout conclusion to infra', () => {
    const result = diagnoseFailures('some log', { conclusion: 'timed_out' });
    expect(result.failures[0].category).toBe('infra');
  });

  it('returns structured categories with counts and suggested_actions', () => {
    const log = [
      'FAIL tests/host.test.js > saves credential',
      'SqliteError: ON CONFLICT clause does not match',
      'FAIL tests/handler.test.js > returns expected',
      "AssertionError: expected 'completed' to be 'failed'",
      '  5:7  error  Unexpected var  no-var',
    ].join('\n');

    const result = diagnoseFailures(log, {});

    expect(result.categories).toBeDefined();
    expect(result.categories.test_schema.count).toBe(1);
    expect(result.categories.test_logic.count).toBe(1);
    expect(result.categories.lint.count).toBe(1);
    expect(result.total_failures).toBe(3);
    expect(result.triage_summary).toContain('schema');
    expect(result.suggested_actions).toBeInstanceOf(Array);
    expect(result.suggested_actions.length).toBeGreaterThan(0);
    expect(result.triage).toContain('CI Failure Triage');
  });
});
