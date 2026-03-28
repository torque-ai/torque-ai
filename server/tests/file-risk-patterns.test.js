describe('file-risk-patterns', () => {
  let scoreFilePath;

  beforeEach(() => {
    const { scoreFileByPath } = require('../db/file-risk-patterns');
    scoreFilePath = scoreFileByPath;
  });

  describe('high risk patterns', () => {
    it.each([
      ['auth/session.js', 'auth_module'],
      ['authentication/login.ts', 'auth_module'],
      ['crypto-utils.js', 'crypto_module'],
      ['schema/users.sql', 'schema_change'],
      ['.env.production', 'secrets_adjacent'],
      ['api/routes/users.js', 'public_api'],
      ['payment/stripe.js', 'financial_module'],
      ['permission-check.js', 'access_control'],
    ])('%s should be high risk with reason %s', (filePath, expectedReason) => {
      const result = scoreFilePath(filePath);
      expect(result.risk_level).toBe('high');
      expect(result.risk_reasons).toContain(expectedReason);
    });
  });

  describe('medium risk patterns', () => {
    it.each([
      ['middleware/cors.js', 'cross_cutting'],
      ['config/database.js', 'configuration'],
      ['cache-manager.js', 'stateful_module'],
      ['queue/worker.js', 'async_infra'],
    ])('%s should be medium risk with reason %s', (filePath, expectedReason) => {
      const result = scoreFilePath(filePath);
      expect(result.risk_level).toBe('medium');
      expect(result.risk_reasons).toContain(expectedReason);
    });
  });

  describe('low risk patterns', () => {
    it.each([
      ['tests/unit/auth.test.js', 'test_file'],
      ['docs/README.md', 'documentation'],
      ['styles/main.css', 'styling'],
    ])('%s should be low risk with reason %s', (filePath, expectedReason) => {
      const result = scoreFilePath(filePath);
      expect(result.risk_level).toBe('low');
      expect(result.risk_reasons).toContain(expectedReason);
    });
  });

  describe('precedence', () => {
    it('high beats medium when both match', () => {
      const result = scoreFilePath('auth/config.js');
      expect(result.risk_level).toBe('high');
    });

    it('test files are low even if path contains crypto keyword', () => {
      const result = scoreFilePath('tests/crypto-utils.test.js');
      expect(result.risk_level).toBe('low');
      expect(result.risk_reasons).toContain('test_file');
    });

    it('unmatched files default to low with no reasons', () => {
      const result = scoreFilePath('src/utils/format-date.js');
      expect(result.risk_level).toBe('low');
      expect(result.risk_reasons).toHaveLength(0);
    });
  });

  describe('scoreFiles batch', () => {
    it('scores multiple files and returns per-file results', () => {
      const { scoreFilesByPath } = require('../db/file-risk-patterns');
      const results = scoreFilesByPath([
        'auth/session.js',
        'src/utils/format.js',
        'docs/README.md',
      ]);

      expect(results).toHaveLength(3);
      expect(results[0].risk_level).toBe('high');
      expect(results[1].risk_level).toBe('low');
      expect(results[2].risk_level).toBe('low');
    });
  });

  describe('custom patterns', () => {
    it('merges custom high-risk patterns with built-in', () => {
      const result = scoreFilePath('special/handler.js', {
        high: [{ patterns: ['**/special/**'], reason: 'special_zone' }],
      });

      expect(result.risk_level).toBe('high');
      expect(result.risk_reasons).toContain('special_zone');
    });
  });
});
