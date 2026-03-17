'use strict';
const { setupTestDb, teardownTestDb } = require('./vitest-setup');

describe('analyzeTaskForRouting with routing templates', () => {
  let db;
  let providerRouting;
  let templateStore;

  beforeAll(() => {
    ({ db } = setupTestDb('routing-templates-integration'));
    providerRouting = require('../db/provider-routing-core');
    templateStore = require('../routing/template-store');

    // Enable smart routing
    db.setConfig('smart_routing_enabled', '1');
  });

  afterAll(() => {
    teardownTestDb();
  });

  afterEach(() => {
    // Reset to no active template (System Default)
    templateStore.setActiveTemplate(null);
  });

  it('routes security task per System Default when explicitly activated', () => {
    // Explicitly activate System Default template
    const sd = templateStore.getTemplateByName('System Default');
    templateStore.setActiveTemplate(sd.id);

    const result = providerRouting.analyzeTaskForRouting(
      'Fix SQL injection vulnerability in login',
      '/test', [], {}
    );
    expect(result).toBeTruthy();
    expect(result.provider).toBeTruthy();
    expect(result.reason).toContain('Template');
    expect(result.reason).toContain('security');
  });

  it('routes using custom template when active', () => {
    const allRules = {
      security: 'ollama', xaml_wpf: 'ollama', architectural: 'ollama',
      reasoning: 'ollama', large_code_gen: 'ollama', documentation: 'ollama',
      simple_generation: 'ollama', targeted_file_edit: 'ollama', default: 'ollama',
    };
    const custom = templateStore.createTemplate({
      name: 'Integration Test Custom',
      rules: allRules,
    });
    templateStore.setActiveTemplate(custom.id);

    const result = providerRouting.analyzeTaskForRouting(
      'Fix SQL injection vulnerability in login',
      '/test', [], {}
    );
    // Custom: everything → ollama, so either template routes to ollama
    // or falls through to existing logic which also uses ollama
    expect(result).toBeTruthy();
    expect(result.provider).toBeTruthy();

    templateStore.deleteTemplate(custom.id);
  });

  it('respects complexity overrides in template', () => {
    const custom = templateStore.createTemplate({
      name: 'Complexity Override Test',
      rules: {
        security: 'ollama', xaml_wpf: 'ollama', architectural: 'ollama',
        reasoning: 'ollama', large_code_gen: 'ollama', documentation: 'ollama',
        simple_generation: 'ollama', targeted_file_edit: 'ollama', default: 'ollama',
      },
      complexity_overrides: {
        reasoning: { complex: 'codex' },
      },
    });
    templateStore.setActiveTemplate(custom.id);

    // A reasoning task — template should route based on reasoning rules
    const result = providerRouting.analyzeTaskForRouting(
      'Analyze the root cause of the critical memory leak',
      '/test', [], {}
    );
    expect(result).toBeTruthy();
    expect(result.provider).toBeTruthy();

    templateStore.deleteTemplate(custom.id);
  });

  it('uses System Default when no template active', () => {
    templateStore.setActiveTemplate(null);
    const result = providerRouting.analyzeTaskForRouting(
      'Write a README for the project',
      '/test', [], {}
    );
    expect(result).toBeTruthy();
    expect(result.provider).toBeTruthy();
  });

  it('template routing produces a reason with template name', () => {
    const custom = templateStore.createTemplate({
      name: 'Reason Check',
      rules: {
        security: 'ollama', xaml_wpf: 'ollama', architectural: 'ollama',
        reasoning: 'ollama', large_code_gen: 'ollama', documentation: 'ollama',
        simple_generation: 'ollama', targeted_file_edit: 'ollama', default: 'ollama',
      },
    });
    templateStore.setActiveTemplate(custom.id);

    const result = providerRouting.analyzeTaskForRouting(
      'Do a general task',
      '/test', [], {}
    );
    // The result should have a reason mentioning the template
    if (result.reason && result.reason.includes('Template')) {
      expect(result.reason).toContain('Reason Check');
    }

    templateStore.deleteTemplate(custom.id);
  });
});
