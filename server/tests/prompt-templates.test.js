import { describe, it, expect } from 'vitest';
const { buildPrompt, TEMPLATES } = require('../orchestrator/prompt-templates');

describe('prompt-templates', () => {
  describe('TEMPLATES', () => {
    it('exports decompose template', () => {
      expect(TEMPLATES.decompose).toBeDefined();
      expect(TEMPLATES.decompose.system).toContain('task decomposition');
    });
    it('exports diagnose template', () => {
      expect(TEMPLATES.diagnose).toBeDefined();
      expect(TEMPLATES.diagnose.system).toContain('failure');
    });
    it('exports review template', () => {
      expect(TEMPLATES.review).toBeDefined();
      expect(TEMPLATES.review.system).toContain('review');
    });
    it('each template has system, user, and schema fields', () => {
      for (const [name, template] of Object.entries(TEMPLATES)) {
        expect(template.system, `${name}.system`).toBeDefined();
        expect(template.user, `${name}.user`).toBeDefined();
        expect(template.schema, `${name}.schema`).toBeDefined();
      }
    });
  });

  describe('buildPrompt', () => {
    it('substitutes variables in user template', () => {
      const result = buildPrompt('decompose', {
        feature_name: 'TradeSystem',
        feature_description: 'Allow players to trade items',
        working_directory: '/project',
        project_structure: 'src/systems/, src/types/',
      });
      expect(result.system).toBe(TEMPLATES.decompose.system);
      expect(result.user).toContain('TradeSystem');
      expect(result.user).toContain('Allow players to trade items');
      expect(result.user).toContain('/project');
    });
    it('handles missing optional variables with empty string', () => {
      const result = buildPrompt('decompose', { feature_name: 'X', working_directory: '/p' });
      expect(result.user).not.toContain('{{');
    });
    it('throws for unknown template', () => {
      expect(() => buildPrompt('nonexistent', {})).toThrow(/unknown template/i);
    });
    it('builds diagnose prompt with error context', () => {
      const result = buildPrompt('diagnose', {
        task_description: 'Write tests for FooSystem',
        error_output: 'error TS2304: Cannot find name Foo',
        provider: 'codex',
        exit_code: '1',
        retry_count: '0',
      });
      expect(result.user).toContain('error TS2304');
      expect(result.user).toContain('codex');
    });
    it('includes output schema instruction in user prompt', () => {
      const result = buildPrompt('decompose', { feature_name: 'X', working_directory: '/p' });
      expect(result.user).toContain('JSON');
    });
  });
});
