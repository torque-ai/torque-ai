'use strict';

/**
 * Tests for filterSensitiveEnv and SENSITIVE_ENV_PATTERNS
 */

const { filterSensitiveEnv, SENSITIVE_ENV_PATTERNS } = require('../remote/remote-test-routing');

describe('filterSensitiveEnv()', () => {
  it('strips API_KEY, TOKEN, and PASSWORD vars', () => {
    const input = {
      API_KEY: 'api-secret',
      TOKEN: 'oauth-token',
      PASSWORD: 'pwd123',
      SAFE_VAR: 'safe',
    };

    const result = filterSensitiveEnv(input);

    expect(result).toEqual({
      SAFE_VAR: 'safe',
    });
  });

  it('passes through safe variables like PATH and HOME', () => {
    const input = {
      PATH: '/usr/bin',
      HOME: '/tmp/home',
      CUSTOM: 'ok',
    };

    const result = filterSensitiveEnv(input);

    expect(result).toEqual({
      PATH: '/usr/bin',
      HOME: '/tmp/home',
      CUSTOM: 'ok',
    });
  });

  it('returns undefined for undefined input', () => {
    expect(filterSensitiveEnv(undefined)).toBeUndefined();
  });
});

describe('SENSITIVE_ENV_PATTERNS', () => {
  it('matches documented sensitive keys', () => {
    const expectedKeys = [
      'TORQUE_AGENT_SECRET',
      'TORQUE_AGENT_SECRET_STASH',
      'API_KEY',
      'SECRET',
      'TOKEN',
      'AUTH_TOKEN',
      'AWS_ACCESS_KEY_ID',
      'AZURE_CLIENT_SECRET',
      'GCP_SERVICE_ACCOUNT',
      'GOOGLE_API_KEY',
      'DEEPINFRA_API_KEY',
      'HYPERBOLIC_API_KEY',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GITHUB_TOKEN',
      'GH_TOKEN',
      'NPM_TOKEN',
      'NUGET_API_KEY',
      'DATABASE_URL',
      'DB_PASSWORD',
      'REDIS_URL',
      'SMTP_PASSWORD',
      'MAIL_PASSWORD',
      'TORQUE_AGENT_SECRET_KEY',
      'CREDENTIAL',
      'PASSWORD',
      'CREDENTIALS',
    ];

    for (const key of expectedKeys) {
      const matched = SENSITIVE_ENV_PATTERNS.some((pattern) => pattern.test(key));
      expect(matched).toBe(true);
    }
  });
});
