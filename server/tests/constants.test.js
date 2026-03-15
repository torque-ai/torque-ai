'use strict';

const {
  CODE_EXTENSIONS, SOURCE_EXTENSIONS, UI_EXTENSIONS, CONFIG_EXTENSIONS,
  BASELINE_EXTENSIONS, SYNTAX_CHECK_EXTENSIONS, FILE_INDEX_EXTENSIONS,
  LLM_ARTIFACT_PATTERNS, BASE_LLM_RULES, TASK_TIMEOUTS, PROVIDER_DEFAULT_TIMEOUTS,
  MODEL_TIER_THRESHOLDS,
} = require('../constants');
const { sanitizeLLMOutput, stripMarkdownFences, stripArtifactMarkers } = require('../utils/sanitize');
const { parseModelSizeB, isSmallModel, getModelSizeCategory, isThinkingModel } = require('../utils/model');
const { parseGitStatusLine } = require('../utils/git');

// ─── constants.js ────────────────────────────────────────────────────────────

describe('constants.js', () => {
  describe('Extension Sets', () => {
    it('CODE_EXTENSIONS contains core language extensions', () => {
      expect(CODE_EXTENSIONS.has('.js')).toBe(true);
      expect(CODE_EXTENSIONS.has('.ts')).toBe(true);
      expect(CODE_EXTENSIONS.has('.py')).toBe(true);
      expect(CODE_EXTENSIONS.has('.cs')).toBe(true);
      expect(CODE_EXTENSIONS.has('.go')).toBe(true);
      expect(CODE_EXTENSIONS.has('.rs')).toBe(true);
      expect(CODE_EXTENSIONS.has('.cpp')).toBe(true);
    });

    it('SOURCE_EXTENSIONS is a subset of CODE_EXTENSIONS', () => {
      for (const ext of SOURCE_EXTENSIONS) {
        expect(CODE_EXTENSIONS.has(ext)).toBe(true);
      }
    });

    it('UI_EXTENSIONS contains UI file types', () => {
      expect(UI_EXTENSIONS.has('.jsx')).toBe(true);
      expect(UI_EXTENSIONS.has('.tsx')).toBe(true);
      expect(UI_EXTENSIONS.has('.html')).toBe(true);
      expect(UI_EXTENSIONS.has('.vue')).toBe(true);
      expect(UI_EXTENSIONS.has('.svelte')).toBe(true);
      expect(UI_EXTENSIONS.has('.xaml')).toBe(true);
    });

    it('CONFIG_EXTENSIONS contains config file types', () => {
      expect(CONFIG_EXTENSIONS.has('.json')).toBe(true);
      expect(CONFIG_EXTENSIONS.has('.yaml')).toBe(true);
      expect(CONFIG_EXTENSIONS.has('.yml')).toBe(true);
      expect(CONFIG_EXTENSIONS.has('.toml')).toBe(true);
    });

    it('CODE and CONFIG sets do not overlap', () => {
      for (const ext of CONFIG_EXTENSIONS) {
        expect(CODE_EXTENSIONS.has(ext)).toBe(false);
      }
    });

    it('BASELINE_EXTENSIONS is an array (not Set)', () => {
      expect(Array.isArray(BASELINE_EXTENSIONS)).toBe(true);
      expect(BASELINE_EXTENSIONS).toContain('.cs');
      expect(BASELINE_EXTENSIONS).toContain('.xaml');
      expect(BASELINE_EXTENSIONS).toContain('.ts');
      expect(BASELINE_EXTENSIONS).toContain('.py');
    });

    it('SYNTAX_CHECK_EXTENSIONS contains syntax-checkable types', () => {
      expect(SYNTAX_CHECK_EXTENSIONS.has('.js')).toBe(true);
      expect(SYNTAX_CHECK_EXTENSIONS.has('.ts')).toBe(true);
      expect(SYNTAX_CHECK_EXTENSIONS.has('.cs')).toBe(true);
      expect(SYNTAX_CHECK_EXTENSIONS.has('.java')).toBe(true);
    });

    it('FILE_INDEX_EXTENSIONS is a superset of CODE + UI + CONFIG', () => {
      for (const ext of CODE_EXTENSIONS) {
        expect(FILE_INDEX_EXTENSIONS.has(ext)).toBe(true);
      }
      for (const ext of UI_EXTENSIONS) {
        expect(FILE_INDEX_EXTENSIONS.has(ext)).toBe(true);
      }
      for (const ext of CONFIG_EXTENSIONS) {
        expect(FILE_INDEX_EXTENSIONS.has(ext)).toBe(true);
      }
      // Plus extras
      expect(FILE_INDEX_EXTENSIONS.has('.md')).toBe(true);
      expect(FILE_INDEX_EXTENSIONS.has('.sql')).toBe(true);
      expect(FILE_INDEX_EXTENSIONS.has('.csproj')).toBe(true);
    });
  });

  describe('LLM_ARTIFACT_PATTERNS', () => {
    it('has 3 patterns', () => {
      expect(LLM_ARTIFACT_PATTERNS).toHaveLength(3);
    });

    it('each pattern is a regex', () => {
      for (const p of LLM_ARTIFACT_PATTERNS) {
        expect(p).toBeInstanceOf(RegExp);
      }
    });
  });

  describe('BASE_LLM_RULES', () => {
    it('contains critical rules text', () => {
      expect(BASE_LLM_RULES).toContain('NEVER create stub');
      expect(BASE_LLM_RULES).toContain('NEVER overwrite large files');
      expect(BASE_LLM_RULES).toContain('CRITICAL RULES');
    });
  });

  describe('TASK_TIMEOUTS', () => {
    it('has all expected keys', () => {
      const expected = [
        'GIT_STATUS', 'GIT_ADD', 'GIT_ADD_ALL', 'GIT_COMMIT',
        'STARTUP', 'FORCE_KILL_DELAY', 'DEFAULT_TASK_MINUTES',
        'OLLAMA_API', 'HTTP_REQUEST', 'HEALTH_CHECK', 'FILE_WRITE', 'PROCESS_SPAWN',
      ];
      for (const key of expected) {
        expect(TASK_TIMEOUTS).toHaveProperty(key);
        expect(typeof TASK_TIMEOUTS[key]).toBe('number');
      }
    });

    it('values are positive', () => {
      for (const [_key, val] of Object.entries(TASK_TIMEOUTS)) {
        expect(val).toBeGreaterThan(0);
      }
    });
  });

  describe('PROVIDER_DEFAULT_TIMEOUTS', () => {
    it('has all provider keys', () => {
      const providers = ['codex', 'claude-cli', 'aider-ollama', 'hashline-ollama',
                         'hashline-openai', 'ollama', 'anthropic', 'groq'];
      for (const p of providers) {
        expect(PROVIDER_DEFAULT_TIMEOUTS).toHaveProperty(p);
      }
    });
  });

  describe('MODEL_TIER_THRESHOLDS', () => {
    it('documents size cutoffs for model tiers', () => {
      expect(MODEL_TIER_THRESHOLDS).toEqual({
        SMALL_MAX_B: 8,
        MEDIUM_MAX_B: 20,
      });
    });
  });
});

// ─── utils/sanitize.js ──────────────────────────────────────────────────────

describe('utils/sanitize.js', () => {
  describe('stripMarkdownFences', () => {
    it('removes fenced code blocks', () => {
      expect(stripMarkdownFences('```js\nconst x = 1;\n```')).toBe('const x = 1;\n');
    });

    it('removes bare fences', () => {
      expect(stripMarkdownFences('```\nfoo\n```')).toBe('foo\n');
    });

    it('returns null/empty gracefully', () => {
      expect(stripMarkdownFences(null)).toBe(null);
      expect(stripMarkdownFences('')).toBe('');
    });

    it('handles nested fences', () => {
      const input = '```ts\nconst a = 1;\n```\nsome text\n```py\nx = 2\n```';
      const result = stripMarkdownFences(input);
      expect(result).not.toContain('```');
    });
  });

  describe('stripArtifactMarkers', () => {
    it('removes <<<__newText__>>>', () => {
      expect(stripArtifactMarkers('hello<<<__newText__>>> world')).toBe('hello world');
    });

    it('removes <<<__oldText__>>>', () => {
      expect(stripArtifactMarkers('foo<<<__oldText__>>>bar')).toBe('foobar');
    });

    it('removes <<<__endText__>>>', () => {
      expect(stripArtifactMarkers('line<<<__endText__>>>')).toBe('line');
    });

    it('removes all 3 marker types at once', () => {
      const input = '<<<__newText__>>>a<<<__oldText__>>>b<<<__endText__>>>c';
      expect(stripArtifactMarkers(input)).toBe('abc');
    });

    it('returns null/empty gracefully', () => {
      expect(stripArtifactMarkers(null)).toBe(null);
      expect(stripArtifactMarkers('')).toBe('');
    });
  });

  describe('sanitizeLLMOutput', () => {
    it('strips thinking tags', () => {
      const input = '<think>reasoning here</think>\nactual output';
      expect(sanitizeLLMOutput(input)).toBe('actual output');
    });

    it('strips artifacts + fences + thinking in one pass', () => {
      const input = '<think>hmm</think>\n```js\ncode<<<__newText__>>>\n```';
      const result = sanitizeLLMOutput(input);
      expect(result).not.toContain('<think>');
      expect(result).not.toContain('```');
      expect(result).not.toContain('<<<__newText__>>>');
    });

    it('returns null/empty gracefully', () => {
      expect(sanitizeLLMOutput(null)).toBe(null);
      expect(sanitizeLLMOutput('')).toBe('');
    });

    it('leaves clean text unchanged', () => {
      expect(sanitizeLLMOutput('hello world')).toBe('hello world');
    });
  });
});

// ─── utils/model.js ─────────────────────────────────────────────────────────

describe('utils/model.js', () => {
  describe('parseModelSizeB', () => {
    it('parses colon-delimited sizes', () => {
      expect(parseModelSizeB('qwen2.5-coder:32b')).toBe(32);
      expect(parseModelSizeB('gemma3:4b')).toBe(4);
      expect(parseModelSizeB('qwen3:8b')).toBe(8);
    });

    it('parses dash-delimited sizes', () => {
      expect(parseModelSizeB('model-7b-instruct')).toBe(7);
    });

    it('parses underscore-delimited sizes', () => {
      expect(parseModelSizeB('model_14b')).toBe(14);
    });

    it('parses decimal sizes', () => {
      expect(parseModelSizeB('model:1.5b')).toBe(1.5);
    });

    it('returns 0 for unparseable names', () => {
      expect(parseModelSizeB('gpt-4')).toBe(0);
      expect(parseModelSizeB('claude-3')).toBe(0);
      expect(parseModelSizeB(null)).toBe(0);
      expect(parseModelSizeB('')).toBe(0);
    });
  });

  describe('isSmallModel', () => {
    it('returns true for <=8B models', () => {
      expect(isSmallModel('qwen3:8b')).toBe(true);
      expect(isSmallModel('gemma3:4b')).toBe(true);
      expect(isSmallModel('model:1.5b')).toBe(true);
    });

    it('returns false for large models', () => {
      expect(isSmallModel('qwen2.5-coder:32b')).toBe(false);
      expect(isSmallModel('codestral:22b')).toBe(false);
    });

    it('detects mini/tiny keywords', () => {
      expect(isSmallModel('gpt-4-mini')).toBe(true);
      expect(isSmallModel('some-tiny-model')).toBe(true);
    });

    it('returns false for null/empty', () => {
      expect(isSmallModel(null)).toBe(false);
      expect(isSmallModel('')).toBe(false);
    });
  });

  describe('getModelSizeCategory', () => {
    it('returns correct categories', () => {
      expect(getModelSizeCategory('gemma3:4b')).toBe('small');
      expect(getModelSizeCategory('qwen3:8b')).toBe('small');
      expect(getModelSizeCategory('deepseek-r1:14b')).toBe('medium');
      expect(getModelSizeCategory('qwen2.5-coder:32b')).toBe('large');
    });

    it('returns unknown for unparseable', () => {
      expect(getModelSizeCategory('gpt-4')).toBe('unknown');
    });
  });

  describe('isThinkingModel', () => {
    it('detects deepseek-r1', () => {
      expect(isThinkingModel('deepseek-r1:14b')).toBe(true);
    });

    it('detects qwq', () => {
      expect(isThinkingModel('qwq:32b')).toBe(true);
    });

    it('detects deepseek-r2', () => {
      expect(isThinkingModel('deepseek-r2:8b')).toBe(true);
    });

    it('returns false for non-thinking models', () => {
      expect(isThinkingModel('qwen3:8b')).toBe(false);
      expect(isThinkingModel('gemma3:4b')).toBe(false);
    });

    it('returns false for null/empty', () => {
      expect(isThinkingModel(null)).toBe(false);
      expect(isThinkingModel('')).toBe(false);
    });
  });
});

// ─── utils/git.js ───────────────────────────────────────────────────────────

describe('utils/git.js', () => {
  describe('parseGitStatusLine', () => {
    it('parses modified file', () => {
      const result = parseGitStatusLine('M  src/foo.ts');
      expect(result).not.toBeNull();
      expect(result.indexStatus).toBe('M');
      expect(result.workStatus).toBe(' ');
      expect(result.filePath).toBe('src/foo.ts');
      expect(result.isModified).toBe(true);
      expect(result.isNew).toBe(false);
      expect(result.isDeleted).toBe(false);
    });

    it('parses untracked file', () => {
      const result = parseGitStatusLine('?? new-file.js');
      expect(result).not.toBeNull();
      expect(result.filePath).toBe('new-file.js');
      expect(result.isNew).toBe(true);
      expect(result.isModified).toBe(false);
    });

    it('parses deleted file', () => {
      const result = parseGitStatusLine('D  deleted.js');
      expect(result).not.toBeNull();
      expect(result.filePath).toBe('deleted.js');
      expect(result.isDeleted).toBe(true);
    });

    it('parses added file', () => {
      const result = parseGitStatusLine('A  staged.ts');
      expect(result).not.toBeNull();
      expect(result.indexStatus).toBe('A');
      expect(result.isNew).toBe(true);
    });

    it('parses renamed file', () => {
      const result = parseGitStatusLine('R  old.ts -> new.ts');
      expect(result).not.toBeNull();
      expect(result.isRenamed).toBe(true);
    });

    it('handles quoted paths', () => {
      const result = parseGitStatusLine('M  "path with spaces.ts"');
      expect(result).not.toBeNull();
      expect(result.filePath).toBe('path with spaces.ts');
    });

    it('parses working-tree modified file', () => {
      const result = parseGitStatusLine(' M src/bar.js');
      expect(result).not.toBeNull();
      expect(result.indexStatus).toBe(' ');
      expect(result.workStatus).toBe('M');
      expect(result.isModified).toBe(true);
    });

    it('returns null for empty/short lines', () => {
      expect(parseGitStatusLine(null)).toBeNull();
      expect(parseGitStatusLine('')).toBeNull();
      expect(parseGitStatusLine('ab')).toBeNull();
    });

    it('returns null for line with empty path', () => {
      expect(parseGitStatusLine('M  ')).toBeNull();
    });
  });
});
