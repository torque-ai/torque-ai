/**
 * Tests for server/routing/template-store.js
 *
 * Covers: preset seeding, CRUD operations, active template management,
 * resolveProvider logic, and validation rules.
 */

const { setupTestDbModule, teardownTestDb } = require('./vitest-setup');

let mod;

beforeAll(() => {
  ({ mod } = setupTestDbModule('../routing/template-store', 'routing-templates'));
  mod.ensureTable();
  mod.seedPresets();
});

afterAll(() => teardownTestDb());

// Helper: build a valid rules object for creating custom templates
function validRules(overrides = {}) {
  return {
    security: 'ollama',
    xaml_wpf: 'ollama',
    architectural: 'ollama',
    reasoning: 'ollama',
    large_code_gen: 'ollama',
    documentation: 'ollama',
    simple_generation: 'ollama',
    targeted_file_edit: 'ollama',
    plan_generation: 'ollama',
    default: 'ollama',
    ...overrides,
  };
}

// ============================================
// Preset Seeding
// ============================================

describe('seedPresets', () => {
  it('loads at least 5 preset templates', () => {
    const all = mod.listTemplates();
    const presets = all.filter(t => t.preset);
    expect(presets.length).toBeGreaterThanOrEqual(5);
  });

  it('all presets are marked preset=true', () => {
    const all = mod.listTemplates();
    const presets = all.filter(t => t.preset);
    for (const p of presets) {
      expect(p.preset).toBe(true);
    }
  });

  it('System Default preset exists', () => {
    const tmpl = mod.getTemplateByName('System Default');
    expect(tmpl).not.toBeNull();
    expect(tmpl.preset).toBe(true);
    // Default category has cerebras as primary
    const defaultRule = Array.isArray(tmpl.rules.default) ? tmpl.rules.default : [tmpl.rules.default];
    expect(defaultRule[0]).toBeDefined();
  });

  it('Cost Saver preset exists', () => {
    const tmpl = mod.getTemplateByName('Cost Saver');
    expect(tmpl).not.toBeNull();
    expect(tmpl.rules.default).toBeDefined();
  });

  it('Codex Primary routes plan_generation to codex first, not ollama', () => {
    // Template name and `description` both promise codex primary. Previously the
    // plan_generation rule put ollama first, so factory plans were written by a
    // small local model and then rejected by the plan-quality gate — SpudgetBooks
    // stalled because no plan ever passed and no execute task ever ran.
    const tmpl = mod.getTemplateByName('Codex Primary');
    expect(tmpl).not.toBeNull();
    const chain = Array.isArray(tmpl.rules.plan_generation)
      ? tmpl.rules.plan_generation
      : [tmpl.rules.plan_generation];
    const providers = chain.map((r) => (typeof r === 'string' ? r : r.provider));
    expect(providers[0]).toBe('codex');
    // ollama may remain as a last-resort fallback but must not be first.
    expect(providers[0]).not.toBe('ollama');
    expect(providers.length).toBeGreaterThanOrEqual(2);
  });

  it('Legacy Fallback (auto) preset exists with the categories promoted from matchProviderByPattern', () => {
    // Phase A of the routing-templates fold-in: the security / xaml_wpf
    // / architectural / reasoning / large_code_gen routing that used to
    // live as hardcoded if-blocks in db/smart-routing.js
    // matchProviderByPattern was promoted into this preset. The preset
    // runs as the tail template (after explicit per-task / active
    // templates) so operators can read, edit, or disable the rules
    // visibly. The hardcoded matchProviderByPattern remains as a
    // defense-in-depth fallback for environments where the preset
    // isn't seeded.
    const tmpl = mod.getTemplateByName('Legacy Fallback (auto)');
    expect(tmpl).not.toBeNull();
    expect(tmpl.preset).toBe(true);
    // security category mirrors the old "anthropic → claude-cli" cascade.
    const securityChain = Array.isArray(tmpl.rules.security)
      ? tmpl.rules.security
      : [tmpl.rules.security];
    const securityProviders = securityChain.map((r) => (typeof r === 'string' ? r : r.provider));
    expect(securityProviders).toEqual(['anthropic', 'claude-cli']);
    // xaml_wpf went to codex.
    const xamlChain = Array.isArray(tmpl.rules.xaml_wpf) ? tmpl.rules.xaml_wpf : [tmpl.rules.xaml_wpf];
    expect(xamlChain.map((r) => r.provider)).toEqual(['codex']);
    // The three large-model categories share the deepinfra → hyperbolic → ollama-cloud chain.
    for (const cat of ['architectural', 'reasoning', 'large_code_gen']) {
      const chain = Array.isArray(tmpl.rules[cat]) ? tmpl.rules[cat] : [tmpl.rules[cat]];
      expect(chain.map((r) => r.provider)).toEqual(['deepinfra', 'hyperbolic', 'ollama-cloud']);
    }
    // Categories not handled by matchProviderByPattern have empty chains
    // so they fall through to the next pipeline stage (complexity / legacy
    // rules / default) instead of being rescued by the preset's default.
    for (const cat of ['documentation', 'simple_generation', 'plan_generation', 'targeted_file_edit', 'default']) {
      expect(tmpl.rules[cat]).toEqual([]);
    }
  });

  it('Quality First routes plan_generation to codex first, not ollama-cloud', () => {
    const tmpl = mod.getTemplateByName('Quality First');
    expect(tmpl).not.toBeNull();
    const chain = Array.isArray(tmpl.rules.plan_generation)
      ? tmpl.rules.plan_generation
      : [tmpl.rules.plan_generation];
    const providers = chain.map((r) => (typeof r === 'string' ? r : r.provider));
    expect(providers[0]).toBe('codex');
    expect(providers[0]).not.toBe('ollama-cloud');
    expect(providers.length).toBeGreaterThanOrEqual(2);
  });

  it('Ollama Cloud Primary routes code categories to ollama-cloud first', () => {
    const tmpl = mod.getTemplateByName('Ollama Cloud Primary');
    expect(tmpl).not.toBeNull();

    const editChain = Array.isArray(tmpl.rules.targeted_file_edit)
      ? tmpl.rules.targeted_file_edit
      : [tmpl.rules.targeted_file_edit];
    const planChain = Array.isArray(tmpl.rules.plan_generation)
      ? tmpl.rules.plan_generation
      : [tmpl.rules.plan_generation];
    const largeCodeChain = Array.isArray(tmpl.rules.large_code_gen)
      ? tmpl.rules.large_code_gen
      : [tmpl.rules.large_code_gen];

    expect(editChain[0].provider).toBe('ollama-cloud');
    expect(planChain[0].provider).toBe('ollama-cloud');
    expect(largeCodeChain[0].provider).toBe('ollama-cloud');
  });

  it('Ollama Cloud Primary keeps non-ollama providers out of the fallback chain until codex', () => {
    const tmpl = mod.getTemplateByName('Ollama Cloud Primary');
    expect(tmpl).not.toBeNull();

    const chains = [];
    for (const [category, value] of Object.entries(tmpl.rules)) {
      chains.push({ name: `rules.${category}`, value });
    }
    for (const [category, overrides] of Object.entries(tmpl.complexity_overrides || {})) {
      for (const [complexity, value] of Object.entries(overrides || {})) {
        chains.push({ name: `complexity_overrides.${category}.${complexity}`, value });
      }
    }

    for (const chain of chains) {
      const entries = Array.isArray(chain.value) ? chain.value : [{ provider: chain.value }];
      const providers = entries.map((entry) => entry.provider);
      expect(providers[0], chain.name).toBe('ollama-cloud');
      expect(providers.at(-1), chain.name).toBe('codex');
      expect(providers.slice(0, -1), chain.name).toEqual(
        expect.arrayContaining(['ollama-cloud'])
      );
      expect(providers.slice(0, -1).every((provider) => provider === 'ollama-cloud'), chain.name)
        .toBe(true);
    }
  });

  it('preset IDs follow preset-<filename> convention', () => {
    const tmpl = mod.getTemplate('preset-system-default');
    expect(tmpl).not.toBeNull();
    expect(tmpl.name).toBe('System Default');
  });

  it('seedPresets is idempotent (INSERT OR REPLACE)', () => {
    const countBefore = mod.listTemplates().filter(t => t.preset).length;
    mod.seedPresets();
    const countAfter = mod.listTemplates().filter(t => t.preset).length;
    expect(countAfter).toBe(countBefore);
  });
});

// ============================================
// CRUD Operations
// ============================================

describe('createTemplate', () => {
  it('creates a custom template', () => {
    const tmpl = mod.createTemplate({
      name: 'My Custom',
      description: 'Test template',
      rules: validRules(),
      complexity_overrides: {},
    });
    expect(tmpl).not.toBeNull();
    expect(tmpl.id).toBeDefined();
    expect(tmpl.name).toBe('My Custom');
    expect(tmpl.preset).toBe(false);
    expect(tmpl.created_at).toBeDefined();
  });

  it('rejects duplicate name', () => {
    expect(() => mod.createTemplate({
      name: 'My Custom',
      description: 'Duplicate',
      rules: validRules(),
    })).toThrow();
  });

  it('trims whitespace from name', () => {
    const tmpl = mod.createTemplate({
      name: '  Trimmed Name  ',
      rules: validRules(),
    });
    expect(tmpl.name).toBe('Trimmed Name');
  });
});

describe('getTemplate / getTemplateByName', () => {
  it('retrieves by id', () => {
    const created = mod.createTemplate({ name: 'Get By Id', rules: validRules() });
    const fetched = mod.getTemplate(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched.name).toBe('Get By Id');
  });

  it('retrieves by name', () => {
    const fetched = mod.getTemplateByName('System Default');
    expect(fetched).not.toBeNull();
    expect(fetched.id).toBe('preset-system-default');
  });

  it('returns null for non-existent id', () => {
    expect(mod.getTemplate('does-not-exist')).toBeNull();
  });

  it('returns null for non-existent name', () => {
    expect(mod.getTemplateByName('Nope')).toBeNull();
  });
});

describe('updateTemplate', () => {
  it('updates a custom template', () => {
    const created = mod.createTemplate({ name: 'Update Me', rules: validRules() });
    const updated = mod.updateTemplate(created.id, { description: 'Updated desc' });
    expect(updated.description).toBe('Updated desc');
    expect(updated.name).toBe('Update Me');
  });

  it('rejects update on preset template', () => {
    const preset = mod.getTemplateByName('System Default');
    expect(() => mod.updateTemplate(preset.id, { description: 'Nope' }))
      .toThrow(/preset/i);
  });

  it('throws on non-existent template', () => {
    expect(() => mod.updateTemplate('fake-id', { name: 'X' }))
      .toThrow(/not found/i);
  });

  it('partial update preserves unchanged fields', () => {
    const created = mod.createTemplate({
      name: 'Partial Update',
      description: 'Original',
      rules: validRules({ default: 'codex' }),
    });
    const updated = mod.updateTemplate(created.id, { description: 'Changed' });
    expect(updated.description).toBe('Changed');
    expect(updated.rules.default).toBe('codex');
  });
});

describe('deleteTemplate', () => {
  it('deletes a custom template', () => {
    const created = mod.createTemplate({ name: 'Delete Me', rules: validRules() });
    const result = mod.deleteTemplate(created.id);
    expect(result.deleted).toBe(true);
    expect(mod.getTemplate(created.id)).toBeNull();
  });

  it('rejects deletion of preset template', () => {
    const preset = mod.getTemplateByName('System Default');
    expect(() => mod.deleteTemplate(preset.id)).toThrow(/preset/i);
  });

  it('returns deleted:false for non-existent id', () => {
    const result = mod.deleteTemplate('nonexistent');
    expect(result.deleted).toBe(false);
  });

  it('clears active_routing_template config when deleting the active template', () => {
    const created = mod.createTemplate({ name: 'Active Then Delete', rules: validRules() });
    mod.setActiveTemplate(created.id);
    expect(mod.getActiveTemplate().id).toBe(created.id);
    mod.deleteTemplate(created.id);
    // Should fall back to System Default
    const active = mod.getActiveTemplate();
    expect(active.name).toBe('System Default');
  });
});

// ============================================
// Active Template Management
// ============================================

describe('getActiveTemplate / setActiveTemplate', () => {
  it('defaults to System Default when none is set', () => {
    // Clear any active template
    mod.setActiveTemplate(null);
    const active = mod.getActiveTemplate();
    expect(active).not.toBeNull();
    expect(active.name).toBe('System Default');
  });

  it('returns explicitly set template', () => {
    const ql = mod.getTemplateByName('Quality First');
    mod.setActiveTemplate(ql.id);
    const active = mod.getActiveTemplate();
    expect(active.id).toBe(ql.id);
    expect(active.name).toBe('Quality First');
    // Clean up
    mod.setActiveTemplate(null);
  });

  it('throws when setting non-existent template as active', () => {
    expect(() => mod.setActiveTemplate('nonexistent'))
      .toThrow(/not found/i);
  });

  it('falls back to System Default when active template is deleted', () => {
    const created = mod.createTemplate({ name: 'Ephemeral', rules: validRules() });
    mod.setActiveTemplate(created.id);
    mod.deleteTemplate(created.id);
    const active = mod.getActiveTemplate();
    expect(active.name).toBe('System Default');
  });
});

// ============================================
// resolveProvider
// ============================================

describe('resolveProvider', () => {
  it('returns base rule for category', () => {
    const tmpl = mod.getTemplateByName('System Default');
    expect(mod.resolveProvider(tmpl, 'security', 'normal').provider).toBe('codex');
    expect(mod.resolveProvider(tmpl, 'large_code_gen', 'normal').provider).toBe('codex');
  });

  it('applies complexity override when present', () => {
    const tmpl = mod.getTemplateByName('System Default');
    // System Default has complexity override for targeted_file_edit → complex → <git-user>
    expect(mod.resolveProvider(tmpl, 'targeted_file_edit', 'complex').provider).toBe('codex');
  });

  it('falls back to base rule when complexity has no override', () => {
    const tmpl = mod.getTemplateByName('System Default');
    // 'simple' is not overridden for targeted_file_edit
    expect(mod.resolveProvider(tmpl, 'targeted_file_edit', 'simple').provider).toBe('cerebras');
  });

  it('falls back to default for unknown category', () => {
    const tmpl = mod.getTemplateByName('System Default');
    // Unknown category falls back to 'default' rule — cerebras is first
    expect(mod.resolveProvider(tmpl, 'unknown_category', 'normal').provider).toBe('cerebras');
  });

  it('returns null for null template', () => {
    expect(mod.resolveProvider(null, 'security', 'normal')).toBeNull();
  });
});

// ============================================
// Validation
// ============================================

describe('validateTemplate', () => {
  it('valid template passes', () => {
    const result = mod.validateTemplate({
      name: 'Valid',
      rules: validRules(),
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects missing name', () => {
    const result = mod.validateTemplate({ rules: validRules() });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /name/i.test(e))).toBe(true);
  });

  it('rejects empty name', () => {
    const result = mod.validateTemplate({ name: '  ', rules: validRules() });
    expect(result.valid).toBe(false);
  });

  it('rejects name exceeding max length', () => {
    const result = mod.validateTemplate({ name: 'X'.repeat(101), rules: validRules() });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /100/i.test(e))).toBe(true);
  });

  it('rejects missing rules.default', () => {
    const rules = validRules();
    delete rules.default;
    const result = mod.validateTemplate({ name: 'No Default', rules });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /default/i.test(e))).toBe(true);
  });

  it('rejects missing category keys', () => {
    const rules = { default: 'ollama' }; // missing all other categories
    const result = mod.validateTemplate({ name: 'Incomplete', rules });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /security/i.test(e))).toBe(true);
  });

  it('rejects missing rules object', () => {
    const result = mod.validateTemplate({ name: 'No Rules' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /rules/i.test(e))).toBe(true);
  });

  it('rejects invalid complexity level', () => {
    const result = mod.validateTemplate({
      name: 'Bad Complexity',
      rules: validRules(),
      complexity_overrides: {
        security: { extreme: 'codex' },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /extreme/i.test(e))).toBe(true);
  });

  it('accepts valid complexity levels', () => {
    const result = mod.validateTemplate({
      name: 'Good Complexity',
      rules: validRules(),
      complexity_overrides: {
        security: { simple: 'ollama', normal: 'deepinfra', complex: 'codex' },
      },
    });
    expect(result.valid).toBe(true);
  });
});
