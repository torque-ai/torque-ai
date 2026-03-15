'use strict';

const {
  parseTaskOutput,
  snippetHash,
  deduplicateFindings,
  checkFalsePositiveHistory,
  processTaskResult,
} = require('../audit/aggregator');

describe('parseTaskOutput', () => {
  it('returns findings when output is raw JSON array', () => {
    const output = JSON.stringify([
      { file_path: '/tmp/a.js', line_start: 1, category: 'security' },
    ]);
    const result = parseTaskOutput(output);

    expect(result.parseError).toBeNull();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].file_path).toBe('/tmp/a.js');
  });

  it('extracts findings from JSON fenced markdown block', () => {
    const output = [
      '```json',
      JSON.stringify([{ file_path: '/tmp/b.js', line_start: 2, category: 'style' }]),
      '```',
    ].join('\n');

    const result = parseTaskOutput(output);

    expect(result.parseError).toBeNull();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].file_path).toBe('/tmp/b.js');
  });

  it('finds JSON array in mixed text output', () => {
    const output = [
      'Preflight complete.',
      'Here is what I found:',
      JSON.stringify([{ file_path: '/tmp/c.js', line_start: 3, category: 'lint' }]),
      'Done.',
    ].join('\n');

    const result = parseTaskOutput(output);

    expect(result.parseError).toBeNull();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].category).toBe('lint');
  });

  it('returns parseError for unparseable output', () => {
    const result = parseTaskOutput('not valid json at all');

    expect(result.parseError).not.toBeNull();
    expect(result.findings).toHaveLength(0);
  });

  it('handles [] as valid empty findings', () => {
    const result = parseTaskOutput('[]');

    expect(result.parseError).toBeNull();
    expect(result.findings).toHaveLength(0);
  });
});

describe('snippetHash', () => {
  it('returns consistent 16 char hash from normalized snippet', () => {
    const first = snippetHash('  const   test = 1; \n\n return test  ');
    const second = snippetHash('const test = 1; return test');

    expect(first).toHaveLength(16);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(first).toBe(second);
  });

  it('returns null for null snippet', () => {
    expect(snippetHash(null)).toBeNull();
  });
});

describe('deduplicateFindings', () => {
  it('deduplicates by file_path, line_start, and subcategory/category', () => {
    const findings = [
      { file_path: '/tmp/a.js', line_start: 10, category: 'security', title: 'first' },
      { file_path: '/tmp/a.js', line_start: 10, category: 'security', title: 'duplicate' },
      { file_path: '/tmp/a.js', line_start: 11, category: 'security', title: 'unique' },
      { file_path: '/tmp/a.js', line_start: 10, subcategory: 'style', title: 'another-unique' },
    ];

    const deduplicated = deduplicateFindings(findings);

    expect(deduplicated).toHaveLength(3);
    expect(deduplicated[0].title).toBe('first');
    expect(deduplicated[1].title).toBe('unique');
    expect(deduplicated[2].title).toBe('another-unique');
  });
});

describe('checkFalsePositiveHistory', () => {
  it('downgrades confidence for matching false positive', () => {
    const finding = {
      file_path: '/tmp/a.js',
      line_start: 5,
      category: 'security',
      subcategory: 'sql',
      confidence: 95,
      snippet_hash: 'abc123',
    };
    const pastFPs = [
      {
        file_path: '/tmp/a.js',
        subcategory: 'sql',
        snippet_hash: 'abc123',
      },
    ];

    const updated = checkFalsePositiveHistory(finding, pastFPs);

    expect(updated).toEqual({ ...finding, confidence: 'low' });
  });

  it('returns finding unchanged when no false positive match exists', () => {
    const finding = {
      file_path: '/tmp/a.js',
      category: 'security',
      subcategory: 'sql',
      confidence: 80,
      snippet_hash: 'abc123',
    };
    const pastFPs = [
      {
        file_path: '/tmp/a.js',
        subcategory: 'style',
        snippet_hash: 'different',
      },
    ];

    const updated = checkFalsePositiveHistory(finding, pastFPs);

    expect(updated).toBe(finding);
  });
});

describe('processTaskResult', () => {
  it('parses, enriches, inserts findings, and updates run counters', async () => {
    const matchingHash = snippetHash('SELECT * FROM users');
    const outputFindings = [
      {
        file_path: '/tmp/a.js',
        line_start: 1,
        category: 'security',
        subcategory: 'sql',
        severity: 3,
        confidence: 90,
        snippet: 'SELECT * FROM users',
        title: 'SQL issue',
      },
      {
        file_path: '/tmp/a.js',
        line_start: 1,
        category: 'security',
        subcategory: 'sql',
        severity: 2,
        confidence: 85,
        snippet: 'SELECT * FROM users',
        title: 'duplicate SQL issue',
      },
      {
        file_path: '/tmp/b.js',
        line_start: 20,
        category: 'quality',
        subcategory: 'style',
        severity: 1,
        confidence: 99,
        snippet: 'foo + bar',
        title: 'Style issue',
      },
    ];

    const auditStore = {
      getAuditRun: vi.fn().mockImplementation((runId) => {
        if (runId === 'run-1') {
          return {
            parse_failures: 0,
            total_findings: 4,
            project_path: '/tmp/project',
          };
        }

        return { parse_failures: 0, total_findings: 0 };
      }),
      getFalsePositives: vi.fn().mockReturnValue([
        {
          file_path: '/tmp/a.js',
          subcategory: 'sql',
          snippet_hash: matchingHash,
        },
      ]),
      insertFindings: vi.fn().mockReturnValue(['id-1', 'id-2']),
      updateAuditRun: vi.fn().mockReturnValue(1),
    };

    const result = await processTaskResult({
      taskId: 'task-1',
      output: JSON.stringify(outputFindings),
      provider: 'provider-x',
      model: 'model-y',
      auditRunId: 'run-1',
      filePaths: ['/tmp/a.js', '/tmp/b.js'],
    }, auditStore);

    expect(auditStore.getFalsePositives).toHaveBeenCalledWith('/tmp/project');
    expect(auditStore.insertFindings).toHaveBeenCalledOnce();
    expect(auditStore.insertFindings).toHaveBeenCalledWith([
      expect.objectContaining({
        audit_run_id: 'run-1',
        provider: 'provider-x',
        model: 'model-y',
        task_id: 'task-1',
        file_path: '/tmp/a.js',
        line_start: 1,
        snippet_hash: matchingHash,
        confidence: 'low',
      }),
      expect.objectContaining({
        audit_run_id: 'run-1',
        provider: 'provider-x',
        model: 'model-y',
        task_id: 'task-1',
        file_path: '/tmp/b.js',
        line_start: 20,
        snippet_hash: snippetHash('foo + bar'),
      }),
    ]);

    expect(auditStore.updateAuditRun).toHaveBeenCalledWith('run-1', { total_findings: 6 });
    expect(result).toEqual({ inserted: 2, parseError: null });
  });
});
