/**
 * Test Helpers for TORQUE
 *
 * Shared utilities for test files. This module is also picked up by vitest
 * via the tests/test-*.js glob, so it includes a trivial test to avoid
 * "0 tests" failures.
 */

const _path = require('path');

/**
 * Sensible config defaults for test mocks.
 * Matches what schema-seeds.js sets on a fresh DB.
 * Tests that mock db.getConfig should fall through to these
 * instead of returning null for unknown keys.
 */
const TEST_CONFIG_DEFAULTS = {
  default_provider: 'ollama',
  smart_routing_default_provider: 'aider-ollama',
  v2_auth_mode: 'permissive',
  default_timeout: '300',
  budget_check_enabled: '1',
  ollama_fast_model: 'qwen2.5-coder:32b',
  ollama_balanced_model: 'qwen2.5-coder:32b',
  ollama_quality_model: 'qwen2.5-coder:32b',
  max_concurrent: '2',
  stall_detection_enabled: '1',
  auto_start_ollama: '0',
};

/**
 * Create a getConfig mock implementation that returns sensible defaults.
 * Pass overrides to customize specific keys for your test.
 *
 *   mockDb.getConfig.mockImplementation(createConfigMock({ default_timeout: '60' }));
 */
function createConfigMock(overrides = {}) {
  const config = { ...TEST_CONFIG_DEFAULTS, ...overrides };
  return (key) => config[key] !== undefined ? config[key] : null;
}

/**
 * Create a unique test ID
 */
function uniqueId(prefix = 'test') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Extract task ID from MCP result
function extractTaskId(result) {
  if (result && result.content && result.content[0]) {
    const text = result.content[0].text || '';
    const patterns = [
      /Task ID:\s*`?([a-z0-9_-]+)`?/i,
      /\(ID:\s*([a-z0-9_-]+)\)/i,
      /task_id['":\s]+([a-z0-9_-]+)/i,
      /ID:\s*([a-z0-9_-]+)/i,
      /`([a-z0-9_-]{10,})`/
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return match[1];
    }
  }
  return null;
}

// Vitest needs at least one test in every matched file
describe('test-helpers', () => {
  it('exports utility functions', () => {
    expect(typeof uniqueId).toBe('function');
    expect(typeof sleep).toBe('function');
    expect(typeof extractTaskId).toBe('function');
    expect(uniqueId('foo')).toMatch(/^foo_/);
  });
});

module.exports = { uniqueId, sleep, extractTaskId, TEST_CONFIG_DEFAULTS, createConfigMock };
