'use strict';

const minimatch = require('minimatch');

const BUILTIN_RULES = {
  high: [
    { patterns: ['**/auth/**', '**/authentication/**', '**/authorization/**'], reason: 'auth_module' },
    { patterns: ['**/*crypto*', '**/*encrypt*', '**/*decrypt*', '**/*hash*'], reason: 'crypto_module', excludeTests: true },
    { patterns: ['**/*schema*', '**/migration*', '**/*.sql', '**/*.prisma'], reason: 'schema_change' },
    { patterns: ['**/*secret*', '**/.env*', '**/*credential*', '**/*token*'], reason: 'secrets_adjacent' },
    { patterns: ['**/api/routes*', '**/api/routes*/**', '**/controllers/**', '**/endpoints/**'], reason: 'public_api' },
    { patterns: ['**/*payment*', '**/*payment*/**', '**/*billing*', '**/*billing*/**', '**/*subscription*', '**/*subscription*/**'], reason: 'financial_module' },
    { patterns: ['**/*permission*', '**/*rbac*', '**/*acl*', '**/*role*'], reason: 'access_control' },
  ],
  medium: [
    { patterns: ['**/middleware/**', '**/hooks/**', '**/interceptors/**'], reason: 'cross_cutting' },
    { patterns: ['**/*config*', '**/*config*/**', '**/settings*', '**/settings*/**'], reason: 'configuration', excludePatterns: ['**/*lock*', '**/node_modules/**'] },
    { patterns: ['**/*cache*', '**/*session*', '**/*state*'], reason: 'stateful_module' },
    { patterns: ['**/*queue*', '**/*worker*', '**/*job*'], reason: 'async_infra' },
  ],
  low: [
    { patterns: ['**/*.test.*', '**/*.spec.*', '**/__tests__/**'], reason: 'test_file' },
    { patterns: ['**/*.md', '**/docs/**', '**/README*'], reason: 'documentation' },
    { patterns: ['**/*.css', '**/*.scss', '**/*.less'], reason: 'styling' },
  ],
};

const TEST_PATTERNS = ['**/*.test.*', '**/*.spec.*', '**/__tests__/**'];

function isTestFile(filePath) {
  return TEST_PATTERNS.some(p => minimatch(filePath, p, { dot: true }));
}

function matchesAny(filePath, patterns) {
  return patterns.some(p => minimatch(filePath, p, { dot: true }));
}

function scoreFileByPath(filePath, customPatterns = {}) {
  const normalizedPath = (filePath || '').replace(/\\/g, '/');
  const reasons = { high: [], medium: [], low: [] };

  if (isTestFile(normalizedPath)) {
    return { risk_level: 'low', risk_reasons: ['test_file'] };
  }

  for (const level of ['high', 'medium', 'low']) {
    const rules = [...BUILTIN_RULES[level], ...(customPatterns[level] || [])];
    for (const rule of rules) {
      if (rule.excludePatterns && matchesAny(normalizedPath, rule.excludePatterns)) continue;
      const patterns = rule.patterns || (rule.pattern ? [rule.pattern] : []);
      if (matchesAny(normalizedPath, patterns)) {
        reasons[level].push(rule.reason);
      }
    }
  }

  if (reasons.high.length > 0) return { risk_level: 'high', risk_reasons: [...new Set(reasons.high)] };
  if (reasons.medium.length > 0) return { risk_level: 'medium', risk_reasons: [...new Set(reasons.medium)] };
  if (reasons.low.length > 0) return { risk_level: 'low', risk_reasons: [...new Set(reasons.low)] };
  return { risk_level: 'low', risk_reasons: [] };
}

function scoreFilesByPath(filePaths, customPatterns = {}) {
  return filePaths.map(fp => ({ file_path: fp, ...scoreFileByPath(fp, customPatterns) }));
}

module.exports = { scoreFileByPath, scoreFilesByPath, BUILTIN_RULES };
