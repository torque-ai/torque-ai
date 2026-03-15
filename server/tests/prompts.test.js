'use strict';

/**
 * Unit Tests: providers/prompts.js
 *
 * Tests task type detection, instruction templates, and prompt wrapping
 * with mocked database config access.
 */

describe('Prompts Module', () => {
  let prompts;
  let mockDb;

  beforeEach(() => {
    prompts = require('../providers/prompts');

    mockDb = {
      getConfig: vi.fn().mockReturnValue(null),
    };
    prompts.init({ db: mockDb });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── TASK_TYPE_INSTRUCTIONS ────────────────────────────────

  describe('TASK_TYPE_INSTRUCTIONS', () => {
    it('has xml-documentation key with C# rules', () => {
      expect(prompts.TASK_TYPE_INSTRUCTIONS['xml-documentation']).toBeDefined();
      expect(prompts.TASK_TYPE_INSTRUCTIONS['xml-documentation']).toContain('XML DOCUMENTATION RULES');
    });

    it('has markdown key with P67 rules', () => {
      expect(prompts.TASK_TYPE_INSTRUCTIONS['markdown']).toBeDefined();
      expect(prompts.TASK_TYPE_INSTRUCTIONS['markdown']).toContain('MARKDOWN FILE RULES');
    });

    it('has small-model key with guidance', () => {
      expect(prompts.TASK_TYPE_INSTRUCTIONS['small-model']).toBeDefined();
      expect(prompts.TASK_TYPE_INSTRUCTIONS['small-model']).toContain('SMALL MODEL CONSTRAINTS');
      expect(prompts.TASK_TYPE_INSTRUCTIONS['small-model']).toContain('Focus on ONE file at a time');
    });

    it('has medium-model key with guidance', () => {
      expect(prompts.TASK_TYPE_INSTRUCTIONS['medium-model']).toBeDefined();
      expect(prompts.TASK_TYPE_INSTRUCTIONS['medium-model']).toContain('MEDIUM MODEL GUIDANCE');
    });
  });

  // ── DEFAULT_INSTRUCTION_TEMPLATES ─────────────────────────

  describe('DEFAULT_INSTRUCTION_TEMPLATES', () => {
    it('has aider-ollama template with placeholder tokens', () => {
      const tmpl = prompts.DEFAULT_INSTRUCTION_TEMPLATES['aider-ollama'];
      expect(tmpl).toBeDefined();
      expect(tmpl).toContain('{TASK_DESCRIPTION}');
      expect(tmpl).toContain('{FILES}');
      expect(tmpl).toContain('{TASK_TYPE_INSTRUCTIONS}');
    });

    it('has claude-cli template', () => {
      expect(prompts.DEFAULT_INSTRUCTION_TEMPLATES['claude-cli']).toBeDefined();
      expect(prompts.DEFAULT_INSTRUCTION_TEMPLATES['claude-cli']).toContain('{TASK_DESCRIPTION}');
    });

    it('has codex template', () => {
      expect(prompts.DEFAULT_INSTRUCTION_TEMPLATES['codex']).toBeDefined();
      expect(prompts.DEFAULT_INSTRUCTION_TEMPLATES['codex']).toContain('{TASK_DESCRIPTION}');
    });
  });

  // ── detectTaskTypes ───────────────────────────────────────

  describe('detectTaskTypes', () => {
    it('detects xml-documentation from "xml doc" keyword', () => {
      const types = prompts.detectTaskTypes('Add xml doc comments to MyClass.cs');
      expect(types).toContain('xml-documentation');
    });

    it('detects xml-documentation from "/// <summary" pattern', () => {
      const types = prompts.detectTaskTypes('Ensure all methods have /// <summary> tags');
      expect(types).toContain('xml-documentation');
    });

    it('detects xml-documentation from "add summary comment" compound', () => {
      const types = prompts.detectTaskTypes('Add a summary comment to each public method');
      expect(types).toContain('xml-documentation');
    });

    it('detects markdown from ".md" extension', () => {
      const types = prompts.detectTaskTypes('Create a CONTRIBUTING.md file');
      expect(types).toContain('markdown');
    });

    it('detects markdown from "readme" keyword', () => {
      const types = prompts.detectTaskTypes('Write a README for the project');
      expect(types).toContain('markdown');
    });

    it('detects markdown from "changelog" keyword', () => {
      const types = prompts.detectTaskTypes('Update the changelog with latest changes');
      expect(types).toContain('markdown');
    });

    it('detects file-creation from "create file" keyword', () => {
      const types = prompts.detectTaskTypes('Create file src/utils/helper.ts');
      expect(types).toContain('file-creation');
    });

    it('detects file-creation from "create a new" keyword', () => {
      const types = prompts.detectTaskTypes('Create a new module for logging');
      expect(types).toContain('file-creation');
    });

    it('detects file-creation from "create ... .ts" regex', () => {
      const types = prompts.detectTaskTypes('Create helper.ts with utility functions');
      expect(types).toContain('file-creation');
    });

    it('does not detect file-creation for existing test file extension work', () => {
      const types = prompts.detectTaskTypes('Extend the existing test file tests/auth.test.js with more retry coverage');
      expect(types).not.toContain('file-creation');
      expect(types).toContain('single-file-task');
    });

    it('does not detect file-creation for add-cases phrasing against a test file', () => {
      const types = prompts.detectTaskTypes('Add cases to tests/auth.test.js for timeout and retry handling');
      expect(types).not.toContain('file-creation');
      expect(types).toContain('single-file-task');
    });

    it('detects single-file-task when exactly one file is referenced', () => {
      const types = prompts.detectTaskTypes('Fix the bug in utils/parser.js');
      expect(types).toContain('single-file-task');
    });

    it('does not detect single-file-task when multiple files are referenced', () => {
      const types = prompts.detectTaskTypes('Refactor utils/parser.js and utils/logger.js');
      expect(types).not.toContain('single-file-task');
    });

    it('detects multiple types simultaneously', () => {
      const types = prompts.detectTaskTypes('Create file README.md with xml doc examples');
      expect(types).toContain('markdown');
      expect(types).toContain('file-creation');
      expect(types).toContain('xml-documentation');
    });

    it('returns empty array when no types match', () => {
      const types = prompts.detectTaskTypes('Refactor the authentication module');
      expect(types).toEqual([]);
    });

    it('handles empty string input', () => {
      const types = prompts.detectTaskTypes('');
      expect(types).toEqual([]);
    });
  });

  // ── getInstructionTemplate ────────────────────────────────

  describe('getInstructionTemplate', () => {
    it('returns model-specific template from db when available', () => {
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'instruction_template_aider-ollama_gemma3:4b') return 'model-specific-template';
        return null;
      });

      const result = prompts.getInstructionTemplate('aider-ollama', 'gemma3:4b');
      expect(result).toBe('model-specific-template');
      expect(mockDb.getConfig).toHaveBeenCalledWith('instruction_template_aider-ollama_gemma3:4b');
    });

    it('falls back to provider-specific template from db', () => {
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'instruction_template_aider-ollama') return 'provider-specific-template';
        return null;
      });

      const result = prompts.getInstructionTemplate('aider-ollama', 'qwen3:8b');
      expect(result).toBe('provider-specific-template');
    });

    it('falls back to default template when db has no overrides', () => {
      mockDb.getConfig.mockReturnValue(null);
      const result = prompts.getInstructionTemplate('aider-ollama', 'qwen3:8b');
      expect(result).toBe(prompts.DEFAULT_INSTRUCTION_TEMPLATES['aider-ollama']);
    });

    it('falls back to codex template for unknown provider', () => {
      mockDb.getConfig.mockReturnValue(null);
      const result = prompts.getInstructionTemplate('unknown-provider', null);
      expect(result).toBe(prompts.DEFAULT_INSTRUCTION_TEMPLATES['codex']);
    });

    it('checks model-specific key before provider key', () => {
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'instruction_template_codex_gpt-5.3') return 'model-hit';
        if (key === 'instruction_template_codex') return 'provider-hit';
        return null;
      });

      const result = prompts.getInstructionTemplate('codex', 'gpt-5.3');
      expect(result).toBe('model-hit');
    });
  });

  // ── wrapWithInstructions ──────────────────────────────────

  describe('wrapWithInstructions', () => {
    it('returns raw description when wrapping is disabled via "0"', () => {
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'instruction_wrapping_enabled') return '0';
        return null;
      });

      const result = prompts.wrapWithInstructions('do something', 'codex', 'gpt-5.3');
      expect(result).toBe('do something');
    });

    it('returns raw description when wrapping is disabled via "false"', () => {
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'instruction_wrapping_enabled') return 'false';
        return null;
      });

      const result = prompts.wrapWithInstructions('do something', 'codex', 'gpt-5.3');
      expect(result).toBe('do something');
    });

    it('replaces {TASK_DESCRIPTION} placeholder with task text', () => {
      const result = prompts.wrapWithInstructions('Fix the parser bug', 'codex', null);
      expect(result).toContain('Fix the parser bug');
      expect(result).not.toContain('{TASK_DESCRIPTION}');
    });

    it('replaces {FILES} placeholder with provided file list', () => {
      const result = prompts.wrapWithInstructions(
        'Update code',
        'aider-ollama',
        null,
        { files: ['src/app.ts', 'src/utils.ts'] }
      );
      expect(result).toContain('src/app.ts, src/utils.ts');
      expect(result).not.toContain('{FILES}');
    });

    it('replaces {FILES} with default text when no files provided', () => {
      const result = prompts.wrapWithInstructions('Update code', 'aider-ollama', null, {});
      expect(result).toContain('As specified in the task');
    });

    it('includes task type instructions for detected types', () => {
      const result = prompts.wrapWithInstructions(
        'Add xml doc comments to Service.cs',
        'aider-ollama',
        null
      );
      expect(result).toContain('XML DOCUMENTATION RULES');
    });

    it('includes small-model guidance for small models', () => {
      const result = prompts.wrapWithInstructions(
        'Fix a bug in helper.js',
        'aider-ollama',
        'gemma3:4b'
      );
      expect(result).toContain('SMALL MODEL CONSTRAINTS');
    });

    it('does not include small-model guidance for large models', () => {
      const result = prompts.wrapWithInstructions(
        'Fix a bug in helper.js',
        'aider-ollama',
        'qwen2.5-coder:32b'
      );
      expect(result).not.toContain('SMALL MODEL CONSTRAINTS');
    });

    it('includes medium-model guidance for medium models', () => {
      const result = prompts.wrapWithInstructions(
        'Fix a bug in helper.js',
        'aider-ollama',
        'deepseek-r1:14b'
      );
      expect(result).toContain('MEDIUM MODEL GUIDANCE');
    });

    it('adds P70 thinking model suffix for aider-ollama with deepseek-r1', () => {
      const result = prompts.wrapWithInstructions(
        'Refactor the module',
        'aider-ollama',
        'deepseek-r1:14b'
      );
      expect(result).toContain('STOP — OUTPUT FORMAT REMINDER (P70)');
      expect(result).toContain('PARSE ERROR');
    });

    it('does not add P70 suffix for non-thinking models', () => {
      const result = prompts.wrapWithInstructions(
        'Refactor the module',
        'aider-ollama',
        'qwen3:8b'
      );
      expect(result).not.toContain('P70');
    });

    it('does not add P70 suffix for thinking model on non-aider provider', () => {
      const result = prompts.wrapWithInstructions(
        'Refactor the module',
        'codex',
        'deepseek-r1:14b'
      );
      expect(result).not.toContain('P70');
    });

    it('appends file context when template has {FILE_CONTEXT} placeholder', () => {
      const ctx = { fileContext: '\n### File Context:\nLine 1: import foo\n' };
      const result = prompts.wrapWithInstructions('Update code', 'aider-ollama', null, ctx);
      expect(result).toContain('### File Context:');
    });

    it('appends file context at end when template lacks {FILE_CONTEXT} placeholder', () => {
      // Use a custom template from db that has no {FILE_CONTEXT} placeholder
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'instruction_template_codex') return 'Simple: {TASK_DESCRIPTION}';
        return null;
      });
      const ctx = { fileContext: '\n### File Context:\ncontentXYZ\n' };
      const result = prompts.wrapWithInstructions('Do task', 'codex', null, ctx);
      expect(result).toContain('contentXYZ');
    });

    it('caps file context for small local models', () => {
      const fileContext = 'x'.repeat(2200);
      const result = prompts.wrapWithInstructions(
        'Update code',
        'aider-ollama',
        'gemma3:4b',
        { fileContext }
      );
      expect(result).toContain('[... truncated to 2048 bytes for small model ...]');
      expect(result).not.toContain('x'.repeat(2200));
    });

    it('caps small model context for hashline-ollama providers', () => {
      const fileContext = 'x'.repeat(5000);
      const result = prompts.wrapWithInstructions(
        'Fix bug',
        'hashline-ollama',
        'gemma3:4b',
        { fileContext }
      );
      const longestContextChunk = Math.max(
        ...(result.match(/x+/g) || ['']).map((chunk) => chunk.length)
      );

      expect(result).toContain('truncated to 2048 bytes for small model');
      expect(longestContextChunk).toBeLessThanOrEqual(2100);
    });

    it('caps file context for medium local models', () => {
      const fileContext = 'y'.repeat(6500);
      const result = prompts.wrapWithInstructions(
        'Update code',
        'aider-ollama',
        'deepseek-r1:14b',
        { fileContext }
      );
      expect(result).toContain('[... truncated to 6144 bytes for medium model ...]');
      expect(result).not.toContain('y'.repeat(6500));
    });

    it('uses unknown tier cap for unclassified local models', () => {
      const fileContext = 'z'.repeat(4300);
      const result = prompts.wrapWithInstructions(
        'Update code',
        'aider-ollama',
        'gpt-4',
        { fileContext }
      );
      expect(result).toContain('[... truncated to 4096 bytes for unknown model ...]');
      expect(result).not.toContain('z'.repeat(4300));
    });

    it('does not cap large model context for hashline-ollama providers', () => {
      const fileContext = 'x'.repeat(5000);
      const result = prompts.wrapWithInstructions(
        'Fix bug',
        'hashline-ollama',
        'qwen2.5-coder:32b',
        { fileContext }
      );

      expect(result).toContain(fileContext);
      expect(result).not.toContain('truncated to');
    });

    it('does not cap file context for cloud providers', () => {
      const fileContext = 'w'.repeat(9000);
      const result = prompts.wrapWithInstructions(
        'Update code',
        'codex',
        'gpt-5.3',
        { fileContext }
      );
      expect(result).toContain(fileContext);
      expect(result).not.toContain('truncated to');
    });

    it('does not cap file context for codex cloud providers', () => {
      const fileContext = 'x'.repeat(10000);
      const result = prompts.wrapWithInstructions(
        'Fix bug',
        'codex',
        'gpt-5.3-codex-spark',
        { fileContext }
      );

      expect(result).toContain(fileContext);
      expect(result).not.toContain('truncated to');
    });

    it('reinforces output format for small ollama models', () => {
      const result = prompts.wrapWithInstructions(
        'Fix bug',
        'ollama',
        'gemma3:4b',
        {}
      );

      expect(result).toMatch(/SMALL MODEL CONSTRAINTS|Focus on ONE file/);
    });

    it('adds medium model guidance for ollama models', () => {
      const result = prompts.wrapWithInstructions(
        'Fix bug',
        'ollama',
        'qwen2.5:14b',
        {}
      );

      expect(result).toContain('MEDIUM MODEL GUIDANCE');
    });

    it('does not add small or medium guidance for large ollama models', () => {
      const result = prompts.wrapWithInstructions(
        'Fix bug',
        'ollama',
        'qwen2.5-coder:32b',
        {}
      );

      expect(result).not.toContain('SMALL MODEL CONSTRAINTS');
      expect(result).not.toContain('MEDIUM MODEL GUIDANCE');
    });
  });
});
