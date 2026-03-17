'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  loadDefaultConfig, loadTemplate, listTemplates,
  loadProjectConfig, saveProjectConfig, deleteProjectConfig,
  validateConfig, deepMerge, mergeConfig,
  substituteVariables,
} = require('../orchestrator/config-loader');

let tmpDir;

beforeEach(() => {
  tmpDir = path.join(os.tmpdir(), `torque-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  if (tmpDir) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

describe('loadDefaultConfig', () => {
  it('returns valid config with all required fields', () => {
    const config = loadDefaultConfig();
    expect(config).toBeTruthy();
    expect(config.template).toBe('default');
    expect(config.decompose).toBeTruthy();
    expect(config.decompose.steps).toEqual(['types', 'data', 'events', 'system', 'tests', 'wire']);
    expect(config.diagnose).toBeTruthy();
    expect(config.diagnose.recovery_actions).toBeInstanceOf(Array);
    expect(config.diagnose.escalation_threshold).toBe(3);
    expect(config.review).toBeTruthy();
    expect(config.review.criteria).toBeInstanceOf(Array);
    expect(config.review.auto_approve_threshold).toBe(85);
    expect(config.review.strict_mode).toBe(false);
    expect(config.confidence_threshold).toBe(0.4);
    expect(config.temperature).toBe(0.3);
    expect(config.provider).toBeNull();
    expect(config.model).toBeNull();
  });

  it('returns a deep clone (mutations do not affect subsequent calls)', () => {
    const a = loadDefaultConfig();
    a.decompose.steps.push('extra');
    a.review.criteria = [];
    const b = loadDefaultConfig();
    expect(b.decompose.steps).not.toContain('extra');
    expect(b.review.criteria.length).toBeGreaterThan(0);
  });
});

describe('loadTemplate', () => {
  it('loads game-dev template with correct steps', () => {
    const t = loadTemplate('game-dev');
    expect(t).toBeTruthy();
    expect(t.name).toBe('game-dev');
    expect(t.decompose.steps).toEqual(['types', 'data', 'events', 'system', 'tests', 'wire']);
    expect(t.decompose.project_context).toContain('ECS');
  });

  it('returns null for nonexistent template', () => {
    expect(loadTemplate('nonexistent-template-xyz')).toBeNull();
  });

  it('returns null for invalid input', () => {
    expect(loadTemplate(null)).toBeNull();
    expect(loadTemplate('')).toBeNull();
    expect(loadTemplate(123)).toBeNull();
  });

  it('sanitizes path traversal attempts', () => {
    expect(loadTemplate('../../../etc/passwd')).toBeNull();
    expect(loadTemplate('../../secret')).toBeNull();
  });
});

describe('listTemplates', () => {
  it('returns 6+ built-in templates', () => {
    const templates = listTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(6);
    const names = templates.map(t => t.name);
    expect(names).toContain('default');
    expect(names).toContain('game-dev');
    expect(names).toContain('web-api');
    expect(names).toContain('frontend');
    expect(names).toContain('cli-tool');
    expect(names).toContain('library');
  });

  it('marks built-in templates with source=built-in', () => {
    const templates = listTemplates();
    for (const t of templates) {
      expect(t.source).toBe('built-in');
    }
  });

  it('project templates override built-in with same name', () => {
    const projDir = path.join(tmpDir, '.torque', 'templates');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'default.json'), JSON.stringify({
      name: 'default', description: 'project override', decompose: { steps: ['only-one'] }
    }));
    const templates = listTemplates(tmpDir);
    const defaults = templates.filter(t => t.name === 'default');
    expect(defaults.length).toBe(1);
    expect(defaults[0].source).toBe('project');
    expect(defaults[0].description).toBe('project override');
  });
});

describe('mergeConfig', () => {
  it('project overrides user overrides defaults', () => {
    const defaults = { temperature: 0.3, provider: null, decompose: { steps: ['a', 'b'] } };
    const user = { temperature: 0.5 };
    const project = { temperature: 0.8 };
    const merged = mergeConfig(project, user, defaults);
    expect(merged.temperature).toBe(0.8);
  });

  it('arrays are replaced, not concatenated', () => {
    const defaults = { decompose: { steps: ['a', 'b', 'c'] } };
    const user = { decompose: { steps: ['x', 'y'] } };
    const merged = mergeConfig(null, user, defaults);
    expect(merged.decompose.steps).toEqual(['x', 'y']);
  });

  it('null values in higher layers are skipped', () => {
    const defaults = { temperature: 0.3, provider: 'ollama' };
    const user = { temperature: null, provider: null };
    const merged = mergeConfig(null, user, defaults);
    expect(merged.temperature).toBe(0.3);
    expect(merged.provider).toBe('ollama');
  });

  it('deeply merges nested objects', () => {
    const defaults = { decompose: { steps: ['a'], project_context: 'base', coding_standards: 'default' } };
    const user = { decompose: { project_context: 'user-ctx' } };
    const merged = mergeConfig(null, user, defaults);
    expect(merged.decompose.project_context).toBe('user-ctx');
    expect(merged.decompose.coding_standards).toBe('default');
    expect(merged.decompose.steps).toEqual(['a']);
  });
});

describe('validateConfig', () => {
  it('valid config passes', () => {
    const config = loadDefaultConfig();
    const result = validateConfig(config);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('invalid steps (non-array) fails', () => {
    const result = validateConfig({ decompose: { steps: 'not-array' } });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('steps'))).toBe(true);
  });

  it('steps with empty string fails', () => {
    const result = validateConfig({ decompose: { steps: ['a', ''] } });
    expect(result.valid).toBe(false);
  });

  it('escalation_threshold > 100 fails', () => {
    const result = validateConfig({ diagnose: { escalation_threshold: 101 } });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('escalation_threshold'))).toBe(true);
  });

  it('auto_approve_threshold > 100 fails', () => {
    const result = validateConfig({ review: { auto_approve_threshold: 150 } });
    expect(result.valid).toBe(false);
  });

  it('confidence_threshold > 1 fails', () => {
    const result = validateConfig({ confidence_threshold: 1.5 });
    expect(result.valid).toBe(false);
  });

  it('temperature > 2 fails', () => {
    const result = validateConfig({ temperature: 3 });
    expect(result.valid).toBe(false);
  });

  it('non-boolean strict_mode fails', () => {
    const result = validateConfig({ review: { strict_mode: 'yes' } });
    expect(result.valid).toBe(false);
  });

  it('non-string provider fails', () => {
    const result = validateConfig({ provider: 42 });
    expect(result.valid).toBe(false);
  });

  it('unknown keys are ignored (no error)', () => {
    const result = validateConfig({ totally_unknown_key: true, another: 'hello' });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('null/non-object config fails', () => {
    expect(validateConfig(null).valid).toBe(false);
    expect(validateConfig('string').valid).toBe(false);
  });
});

describe('loadProjectConfig', () => {
  it('returns null for missing file', () => {
    expect(loadProjectConfig(tmpDir)).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    const dir = path.join(tmpDir, '.torque');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'strategic.json'), 'NOT JSON {{{', 'utf8');
    expect(loadProjectConfig(tmpDir)).toBeNull();
  });

  it('returns null when no workingDirectory', () => {
    expect(loadProjectConfig(null)).toBeNull();
    expect(loadProjectConfig(undefined)).toBeNull();
  });
});

describe('substituteVariables', () => {
  it('replaces {{var}} with values', () => {
    const result = substituteVariables('Create {{feature_name}} with {{count}} items', {
      feature_name: 'UserProfile',
      count: 5
    });
    expect(result).toBe('Create UserProfile with 5 items');
  });

  it('leaves unknown {{vars}} as-is', () => {
    const result = substituteVariables('Hello {{known}} and {{unknown}}', { known: 'world' });
    expect(result).toBe('Hello world and {{unknown}}');
  });

  it('handles null/non-string input gracefully', () => {
    expect(substituteVariables(null, {})).toBeNull();
    expect(substituteVariables(undefined, {})).toBeUndefined();
    expect(substituteVariables(42, {})).toBe(42);
  });
});

describe('saveProjectConfig + loadProjectConfig round-trip', () => {
  it('saves and loads config correctly', () => {
    const config = { temperature: 0.7, decompose: { steps: ['a', 'b'] }, custom: 'value' };
    saveProjectConfig(tmpDir, config);
    const loaded = loadProjectConfig(tmpDir);
    expect(loaded).toEqual(config);
  });

  it('overwrites existing config', () => {
    saveProjectConfig(tmpDir, { temperature: 0.3 });
    saveProjectConfig(tmpDir, { temperature: 0.9 });
    const loaded = loadProjectConfig(tmpDir);
    expect(loaded.temperature).toBe(0.9);
  });

  it('deleteProjectConfig removes the file', () => {
    saveProjectConfig(tmpDir, { temperature: 0.3 });
    expect(loadProjectConfig(tmpDir)).toBeTruthy();
    const deleted = deleteProjectConfig(tmpDir);
    expect(deleted).toBe(true);
    expect(loadProjectConfig(tmpDir)).toBeNull();
  });

  it('deleteProjectConfig returns false for missing file', () => {
    expect(deleteProjectConfig(tmpDir)).toBe(false);
  });

  it('saveProjectConfig throws without workingDirectory', () => {
    expect(() => saveProjectConfig(null, {})).toThrow('working_directory');
  });
});

describe('deepMerge', () => {
  it('returns target when source is null', () => {
    const target = { a: 1 };
    expect(deepMerge(target, null)).toEqual({ a: 1 });
  });

  it('returns target when source is non-object', () => {
    const target = { a: 1 };
    expect(deepMerge(target, 'string')).toEqual({ a: 1 });
  });

  it('does not mutate target or source', () => {
    const target = { a: { b: 1 } };
    const source = { a: { c: 2 } };
    const result = deepMerge(target, source);
    expect(target).toEqual({ a: { b: 1 } });
    expect(source).toEqual({ a: { c: 2 } });
    expect(result).toEqual({ a: { b: 1, c: 2 } });
  });
});
