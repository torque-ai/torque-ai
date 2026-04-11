'use strict';

const { parseFindingsMarkdown, loadLatestFindings } = require('../factory/findings-parser');
const path = require('path');
const fs = require('fs');
const os = require('os');

describe('findings-parser', () => {
  describe('parseFindingsMarkdown', () => {
    test('parses findings with severity and status', () => {
      const md = [
        '# Security Scan',
        '3 findings: 1 critical, 1 high, 1 low.',
        '',
        '## Findings',
        '',
        '### [CRITICAL] SQL injection in user endpoint',
        '- File: src/api/users.js:42',
        '- Description: User input passed directly to query.',
        '- Status: NEW',
        '',
        '### [HIGH] Missing auth on admin route',
        '- File: src/api/admin.js:10',
        '- Description: No authentication middleware.',
        '- Status: NEW',
        '',
        '### [LOW] Console.log left in production code',
        '- File: src/utils/debug.js:5',
        '- Description: Debug logging in production.',
        '- Status: DEFERRED',
      ].join('\n');

      const result = parseFindingsMarkdown(md);
      expect(result).toHaveLength(3);
      expect(result[0].severity).toBe('critical');
      expect(result[0].title).toBe('SQL injection in user endpoint');
      expect(result[0].file).toBe('src/api/users.js:42');
      expect(result[0].status).toBe('NEW');
      expect(result[1].severity).toBe('high');
      expect(result[2].status).toBe('DEFERRED');
    });

    test('returns empty findings for no findings section', () => {
      const result = parseFindingsMarkdown('# Empty scan\nNo issues found.');
      expect(result).toEqual([]);
    });
  });

  describe('loadLatestFindings', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'findings-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('finds latest file matching scan type', () => {
      fs.writeFileSync(path.join(tmpDir, '2026-04-01-security-scan.md'), 'old');
      fs.writeFileSync(path.join(tmpDir, '2026-04-04-security-scan.md'), 'new');

      const result = loadLatestFindings(tmpDir, 'security');
      expect(result.source).toContain('2026-04-04-security-scan.md');
    });

    test('returns empty findings when no matching files', () => {
      const result = loadLatestFindings(tmpDir, 'security');
      expect(result.source).toBeNull();
      expect(result.findings).toEqual([]);
    });

    test('matches sweep suffix', () => {
      fs.writeFileSync(path.join(tmpDir, '2026-04-05-security-sweep.md'), 'sweep');
      const result = loadLatestFindings(tmpDir, 'security');
      expect(result.source).toContain('security-sweep.md');
    });
  });
});
