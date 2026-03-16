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
      category: 'test',
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
      category: 'infrastructure',
    });
    expect(result.failures[0].message).toContain('shutdown signal');
  });

  it('detects timeout from conclusion metadata', () => {
    const log = 'build finished with exit code 124';
    const result = diagnoseFailures(log, { conclusion: 'timed_out' });

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      category: 'timeout',
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
    expect(result.failures[0].category).toBe('test');
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
});

