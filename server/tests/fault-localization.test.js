'use strict';

import { describe, expect, it, beforeEach } from 'vitest';

const { createFaultLocalization } = require('../validation/fault-localization');

let fl;

beforeEach(() => {
  fl = createFaultLocalization({ logger: { debug() {}, info() {}, warn() {} } });
});

describe('fault-localization', () => {
  describe('rankSuspiciousFiles — vitest JSON output', () => {
    it('computes Ochiai scores correctly and sorts descending', () => {
      // fileA: 2 fails out of 2 tests → Ochiai = 2 / sqrt(3 * 2) = 2/sqrt(6) ≈ 0.8165
      // fileB: 1 fail out of 3 tests  → Ochiai = 1 / sqrt(3 * 3) = 1/3       ≈ 0.3333
      // fileC: 0 fails out of 1 test  → Ochiai = 0 (fileFailed === 0)
      const vitestJson = JSON.stringify({
        testResults: [
          {
            name: 'server/fileA.test.js',
            assertionResults: [
              { status: 'failed' },
              { status: 'failed' },
            ],
          },
          {
            name: 'server/fileB.test.js',
            assertionResults: [
              { status: 'failed' },
              { status: 'passed' },
              { status: 'passed' },
            ],
          },
          {
            name: 'server/fileC.test.js',
            assertionResults: [
              { status: 'passed' },
            ],
          },
        ],
      });

      const ranked = fl.rankSuspiciousFiles({ verifyOutput: vitestJson });

      expect(ranked).toHaveLength(3);

      // fileA has highest score (2 fails / sqrt(3 * 2))
      expect(ranked[0].filePath).toBe('server/fileA.test.js');
      expect(ranked[0].failedTests).toBe(2);
      expect(ranked[0].passedTests).toBe(0);
      expect(ranked[0].score).toBeCloseTo(2 / Math.sqrt(3 * 2), 4);

      // fileB is second (1 fail / sqrt(3 * 3))
      expect(ranked[1].filePath).toBe('server/fileB.test.js');
      expect(ranked[1].failedTests).toBe(1);
      expect(ranked[1].passedTests).toBe(2);
      expect(ranked[1].score).toBeCloseTo(1 / Math.sqrt(3 * 3), 4);

      // fileC has zero fails → score 0
      expect(ranked[2].filePath).toBe('server/fileC.test.js');
      expect(ranked[2].score).toBe(0);
    });
  });

  describe('rankSuspiciousFiles — stack-trace-only output', () => {
    it('extracts file paths from stack traces when no structured format detected', () => {
      const stackOutput = [
        'Error: something broke',
        '    at Object.<anonymous> (server/api-server.js:42:10)',
        '    at Module._compile (node:internal/modules/cjs/loader:1234:14)',
        '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
        '',
        'Caused by:',
        '    at Foo.bar (server/handlers/mcp-tools.js:100:5)',
      ].join('\n');

      const ranked = fl.rankSuspiciousFiles({ verifyOutput: stackOutput });

      expect(ranked.length).toBeGreaterThanOrEqual(2);
      const paths = ranked.map(r => r.filePath);
      expect(paths).toContain('server/api-server.js');
      expect(paths).toContain('server/handlers/mcp-tools.js');
      // Stack-trace fallback assigns synthetic scores
      for (const r of ranked) {
        expect(r.failedTests).toBe(1);
        expect(r.passedTests).toBe(0);
        expect(r.score).toBeGreaterThan(0);
      }
    });
  });

  describe('extractFailingTestFiles', () => {
    it('extracts and deduplicates paths from multiline error output', () => {
      const output = [
        'FAIL Tests failed',
        '    at Object.<anonymous> (server/api-server.js:42:10)',
        '    at Runner.run (server/api-server.js:100:3)',
        '    at Object.<anonymous> (server/tools.js:15:8)',
        '    at internal (node_modules/vitest/dist/something.js:1:1)',
      ].join('\n');

      const files = fl.extractFailingTestFiles(output);

      // Should be deduplicated and exclude node_modules
      expect(files).toContain('server/api-server.js');
      expect(files).toContain('server/tools.js');
      // api-server.js appears twice but should be deduplicated
      expect(files.filter(f => f === 'server/api-server.js')).toHaveLength(1);
      // node_modules paths should be excluded
      expect(files.every(f => !f.includes('node_modules'))).toBe(true);
    });
  });

  describe('formatLocalizationContext', () => {
    it('formats ranked files into a markdown table with header and scores', () => {
      const ranked = [
        { filePath: 'server/foo.js', score: 0.8165, failedTests: 2, passedTests: 0 },
        { filePath: 'server/bar.js', score: 0.3333, failedTests: 1, passedTests: 2 },
        { filePath: 'server/baz.js', score: 0.0, failedTests: 0, passedTests: 1 },
      ];

      const output = fl.formatLocalizationContext(ranked);

      expect(output).toContain('## Fault Localization');
      expect(output).toContain('server/foo.js');
      expect(output).toContain('server/bar.js');
      expect(output).toContain('server/baz.js');
      expect(output).toContain('0.8165');
      expect(output).toContain('0.3333');
      expect(output).toContain('0.0000');
      // Should contain markdown table structure
      expect(output).toContain('| Rank | File |');
    });
  });

  describe('edge cases', () => {
    it('rankSuspiciousFiles returns empty array for empty output', () => {
      expect(fl.rankSuspiciousFiles({ verifyOutput: '' })).toEqual([]);
      expect(fl.rankSuspiciousFiles({ verifyOutput: undefined })).toEqual([]);
      expect(fl.rankSuspiciousFiles({})).toEqual([]);
    });

    it('Ochiai with zero totalFailed returns 0, not NaN', () => {
      // All tests pass — no failures at all
      const vitestJson = JSON.stringify({
        testResults: [
          {
            name: 'server/all-pass.test.js',
            assertionResults: [
              { status: 'passed' },
              { status: 'passed' },
            ],
          },
        ],
      });

      const ranked = fl.rankSuspiciousFiles({ verifyOutput: vitestJson });

      // All scores should be 0, none should be NaN
      for (const r of ranked) {
        expect(r.score).toBe(0);
        expect(Number.isNaN(r.score)).toBe(false);
      }
    });
  });
});
