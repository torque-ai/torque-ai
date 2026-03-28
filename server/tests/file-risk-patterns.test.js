describe('file-risk-patterns', () => {
  let scoreFilePath;

  beforeEach(() => {
    const { scoreFileByPath } = require('../db/file-risk-patterns');
    scoreFilePath = scoreFileByPath;
  });

  describe('high risk patterns', () => {
    it.each([
      ['server/auth/session.js', 'auth_module'],
      ['src/authentication/login.ts', 'auth_module'],
      ['lib/authorization/rbac.js', 'auth_module'],
      ['server/crypto-utils.js', 'crypto_module'],
      ['src/encrypt-data.ts', 'crypto_module'],
      ['db/schema/users.sql', 'schema_change'],
      ['prisma/migrations/001.prisma', 'schema_change'],
      ['server/.env.production', 'secrets_adjacent'],
      ['src/credential-store.js', 'secrets_adjacent'],
      ['server/api/routes/users.js', 'public_api'],
      ['src/controllers/auth.ts', 'public_api'],
      ['server/payment/stripe.js', 'financial_module'],
      ['src/billing/invoice.ts', 'financial_module'],
      ['server/permission-check.js', 'access_control'],
      ['src/rbac/roles.ts', 'access_control'],
    ])('%s should be high risk with reason %s', (filePath, expectedReason) => {
      const result = scoreFilePath(filePath);
      expect(result.risk_level).toBe('high');
      expect(result.risk_reasons).toContain(expectedReason);
    });
  });

  describe('medium risk patterns', () => {
    it.each([
      ['server/middleware/cors.js', 'cross_cutting'],
      ['src/hooks/useAuth.ts', 'cross_cutting'],
      ['server/config/database.js', 'configuration'],
      ['src/cache-manager.js', 'stateful_module'],
      ['server/queue/worker.js', 'async_infra'],
    ])('%s should be medium risk with reason %s', (filePath, expectedReason) => {
      const result = scoreFilePath(filePath);
      expect(result.risk_level).toBe('medium');
      expect(result.risk_reasons).toContain(expectedReason);
    });
  });

  describe('low risk patterns', () => {
    it.each([
      ['tests/unit/auth.test.js', 'test_file'],
      ['src/__tests__/utils.spec.ts', 'test_file'],
      ['docs/README.md', 'documentation'],
      ['src/styles/main.css', 'styling'],
    ])('%s should be low risk with reason %s', (filePath, expectedReason) => {
      const result = scoreFilePath(filePath);
      expect(result.risk_level).toBe('low');
      expect(result.risk_reasons).toContain(expectedReason);
    });
  });

  describe('precedence', () => {
    it('high beats medium when both match', () => {
      const result = scoreFilePath('server/auth/config.js');
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
        'server/auth/session.js',
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
      const result = scoreFilePath('src/special/handler.js', {
        high: [{ patterns: ['**/special/**'], reason: 'special_zone' }],
      });
      expect(result.risk_level).toBe('high');
      expect(result.risk_reasons).toContain('special_zone');
    });
  });
});
