'use strict';

const _path = require('path');

// --- installMock pattern for CJS dependency injection ---
function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// Mock logger before requiring the module under test
const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn(() => mockLogger) };
installMock('../logger', mockLogger);

// Now require the module under test
const commandBuilders = require('../execution/command-builders');

// --- Shared mock factories ---

function makeWrapWithInstructions() {
  return vi.fn((desc, provider, model, ctx) => {
    const fc = ctx && ctx.fileContext ? `\n${ctx.fileContext}` : '';
    return `[wrapped:${provider}] ${desc}${fc}`;
  });
}

function makeProviderCfg(overrides = {}) {
  return {
    getEnrichmentConfig: vi.fn(() => ({ enabled: false, ...overrides })),
  };
}

function makeContextEnrichment() {
  return {
    enrichResolvedContext: vi.fn(() => 'enriched-context'),
  };
}

function makeCodexIntelligence() {
  return {
    buildCodexEnrichedPrompt: vi.fn((task, files, wd, enrichment) =>
      `enriched:${task.task_description}|files=${files.length}|enrich=${enrichment}`
    ),
  };
}

function makeDb() {
  return {};
}

function initModule(overrides = {}) {
  const deps = {
    wrapWithInstructions: makeWrapWithInstructions(),
    providerCfg: makeProviderCfg(),
    contextEnrichment: makeContextEnrichment(),
    codexIntelligence: makeCodexIntelligence(),
    db: makeDb(),
    nvmNodePath: null,
    ...overrides,
  };
  commandBuilders.init(deps);
  return deps;
}

// Helper to determine expected platform-dependent CLI path
const isWin = process.platform === 'win32';

describe('execution/command-builders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // init()
  // =========================================================================
  describe('init', () => {
    it('stores all injected dependencies without error', () => {
      expect(() => initModule()).not.toThrow();
    });

    it('accepts partial overrides (nvmNodePath set)', () => {
      expect(() => initModule({ nvmNodePath: '/usr/local/nvm/v20/bin' })).not.toThrow();
    });
  });

  // =========================================================================
  // buildClaudeCliCommand
  // =========================================================================
  describe('buildClaudeCliCommand', () => {
    it('returns fixed CLI args and wraps description via wrapWithInstructions', () => {
      const deps = initModule();
      const task = {
        task_description: 'Analyze code',
        files: ['a.js'],
        project: 'myproj',
      };
      const result = commandBuilders.buildClaudeCliCommand(task, null, 'file-ctx-string');

      expect(result.finalArgs).toEqual([
        '--dangerously-skip-permissions',
        '--disable-slash-commands',
        '--strict-mcp-config',
        '-p',
      ]);
      expect(deps.wrapWithInstructions).toHaveBeenCalledWith(
        'Analyze code',
        'claude-cli',
        null,
        { files: ['a.js'], project: 'myproj', fileContext: 'file-ctx-string' }
      );
      expect(result.stdinPrompt).toBe('[wrapped:claude-cli] Analyze code\nfile-ctx-string');
    });

    it('defaults cliPath to "claude" on non-Windows or "claude.cmd" on Windows', () => {
      initModule();
      const task = { task_description: 'test' };
      const result = commandBuilders.buildClaudeCliCommand(task, null, '');

      expect(result.cliPath).toBe(isWin ? 'claude.cmd' : 'claude');
    });

    it('uses providerConfig.cli_path when provided', () => {
      initModule();
      const task = { task_description: 'test' };
      const result = commandBuilders.buildClaudeCliCommand(task, { cli_path: '/custom/bin/claude' }, '');

      if (isWin) {
        // On Windows, a path without extension gets .cmd appended
        expect(result.cliPath).toBe('/custom/bin/claude.cmd');
      } else {
        expect(result.cliPath).toBe('/custom/bin/claude');
      }
    });

    it('does not append .cmd on Windows when cli_path already has an extension', () => {
      initModule();
      const task = { task_description: 'test' };
      const result = commandBuilders.buildClaudeCliCommand(task, { cli_path: 'C:\\tools\\claude.exe' }, '');

      // path.extname('C:\\tools\\claude.exe') === '.exe', so no .cmd appended
      expect(result.cliPath).toBe('C:\\tools\\claude.exe');
    });

    it('handles null resolvedFileContext gracefully', () => {
      initModule();
      const task = { task_description: 'test', files: null, project: null };
      const result = commandBuilders.buildClaudeCliCommand(task, null, null);

      expect(result.stdinPrompt).toBe('[wrapped:claude-cli] test');
    });

    it('handles empty string resolvedFileContext', () => {
      initModule();
      const task = { task_description: 'check', files: [] };
      const result = commandBuilders.buildClaudeCliCommand(task, null, '');

      expect(result.stdinPrompt).toBe('[wrapped:claude-cli] check');
    });

    it('passes task.files and task.project through to wrapWithInstructions', () => {
      const deps = initModule();
      const task = {
        task_description: 'do something',
        files: ['x.ts', 'y.ts'],
        project: 'proj-a',
      };
      commandBuilders.buildClaudeCliCommand(task, null, 'ctx');

      const callCtx = deps.wrapWithInstructions.mock.calls[0][3];
      expect(callCtx.files).toEqual(['x.ts', 'y.ts']);
      expect(callCtx.project).toBe('proj-a');
      expect(callCtx.fileContext).toBe('ctx');
    });
  });

  // =========================================================================
  // buildCodexCommand
  // =========================================================================
  describe('buildCodexCommand', () => {
    // --- Fallback path (no resolvedFiles or no working_directory) ---
    describe('fallback path (no resolved files)', () => {
      it('uses wrapWithInstructions when resolvedFiles is null', () => {
        const deps = initModule();
        const task = {
          task_description: 'Write tests',
          model: 'gpt-5-codex',
          auto_approve: false,
          working_directory: '/proj',
          files: ['f.js'],
          project: 'p',
        };
        const result = commandBuilders.buildCodexCommand(task, null, 'fallback-ctx', null);

        expect(deps.wrapWithInstructions).toHaveBeenCalledWith(
          'Write tests', 'codex', null,
          { files: ['f.js'], project: 'p', fileContext: 'fallback-ctx' }
        );
        expect(result.stdinPrompt).toBe('[wrapped:codex] Write tests\nfallback-ctx');
      });

      it('uses wrapWithInstructions when resolvedFiles is empty array', () => {
        const deps = initModule();
        const task = {
          task_description: 'Build feature',
          model: 'gpt-5-codex',
          working_directory: '/proj',
        };
        const result = commandBuilders.buildCodexCommand(task, null, 'ctx', []);

        expect(deps.wrapWithInstructions).toHaveBeenCalled();
        expect(result.stdinPrompt).toContain('[wrapped:codex]');
      });

      it('uses wrapWithInstructions when task has no working_directory', () => {
        const deps = initModule();
        const task = {
          task_description: 'Something',
          model: 'gpt-5-codex',
          working_directory: null,
        };
        const resolvedFiles = [{ actual: 'a.js', mentioned: 'a.js' }];
        const result = commandBuilders.buildCodexCommand(task, null, 'ctx', resolvedFiles);

        expect(deps.wrapWithInstructions).toHaveBeenCalled();
        expect(result.stdinPrompt).toContain('[wrapped:codex]');
      });
    });

    // --- Enriched path (resolvedFiles + working_directory) ---
    describe('enriched path (resolved files present)', () => {
      it('uses codexIntelligence when resolvedFiles and working_directory are present', () => {
        const deps = initModule({
          providerCfg: makeProviderCfg({ enabled: false }),
        });
        const task = {
          task_description: 'Implement feature',
          model: 'gpt-5-codex',
          working_directory: '/proj',
        };
        const resolvedFiles = [{ actual: '/proj/a.js', mentioned: 'a.js' }];
        const result = commandBuilders.buildCodexCommand(task, null, 'ctx', resolvedFiles);

        expect(deps.codexIntelligence.buildCodexEnrichedPrompt).toHaveBeenCalledWith(
          task, resolvedFiles, '/proj', ''
        );
        expect(result.stdinPrompt).toContain('enriched:Implement feature');
      });

      it('calls contextEnrichment when enrichment config is enabled', () => {
        const providerCfg = makeProviderCfg({ enabled: true });
        const contextEnrichment = makeContextEnrichment();
        const codexIntelligence = makeCodexIntelligence();
        const db = makeDb();
        initModule({ providerCfg, contextEnrichment, codexIntelligence, db });

        const task = {
          task_description: 'Add tests',
          working_directory: '/proj',
        };
        const resolvedFiles = [{ actual: '/proj/b.ts', mentioned: 'b.ts' }];
        commandBuilders.buildCodexCommand(task, null, '', resolvedFiles);

        expect(contextEnrichment.enrichResolvedContext).toHaveBeenCalledWith(
          resolvedFiles, '/proj', 'Add tests', db, expect.objectContaining({ enabled: true })
        );
        expect(codexIntelligence.buildCodexEnrichedPrompt).toHaveBeenCalledWith(
          task, resolvedFiles, '/proj', 'enriched-context'
        );
      });

      it('handles enrichment errors gracefully (non-fatal)', () => {
        const providerCfg = makeProviderCfg({ enabled: true });
        const contextEnrichment = {
          enrichResolvedContext: vi.fn(() => { throw new Error('enrichment boom'); }),
        };
        const codexIntelligence = makeCodexIntelligence();
        initModule({ providerCfg, contextEnrichment, codexIntelligence });

        const task = {
          task_description: 'Fix bug',
          working_directory: '/proj',
        };
        const resolvedFiles = [{ actual: '/proj/c.js', mentioned: 'c.js' }];

        // Should not throw
        const result = commandBuilders.buildCodexCommand(task, null, '', resolvedFiles);

        // Falls through with empty enrichment
        expect(codexIntelligence.buildCodexEnrichedPrompt).toHaveBeenCalledWith(
          task, resolvedFiles, '/proj', ''
        );
        expect(result.stdinPrompt).toContain('enriched:Fix bug');
      });

      it('skips enrichment call when config is disabled', () => {
        const providerCfg = makeProviderCfg({ enabled: false });
        const contextEnrichment = makeContextEnrichment();
        initModule({ providerCfg, contextEnrichment });

        const task = {
          task_description: 'Update',
          working_directory: '/proj',
        };
        const resolvedFiles = [{ actual: '/proj/d.js', mentioned: 'd.js' }];
        commandBuilders.buildCodexCommand(task, null, '', resolvedFiles);

        expect(contextEnrichment.enrichResolvedContext).not.toHaveBeenCalled();
      });
    });

    // --- CLI args construction ---
    describe('codex CLI args', () => {
      it('always starts with exec and --skip-git-repo-check', () => {
        initModule();
        const task = { task_description: 'test', model: 'gpt-5', working_directory: '/w' };
        const result = commandBuilders.buildCodexCommand(task, null, 'ctx', null);

        expect(result.finalArgs[0]).toBe('exec');
        expect(result.finalArgs[1]).toBe('--skip-git-repo-check');
      });

      it('includes -m flag when model differs from "codex"', () => {
        initModule();
        const task = { task_description: 'test', model: 'gpt-5-codex' };
        const result = commandBuilders.buildCodexCommand(task, null, '', null);

        const mIdx = result.finalArgs.indexOf('-m');
        expect(mIdx).toBeGreaterThan(-1);
        expect(result.finalArgs[mIdx + 1]).toBe('gpt-5-codex');
      });

      it('omits -m flag when model is "codex"', () => {
        initModule();
        const task = { task_description: 'test', model: 'codex' };
        const result = commandBuilders.buildCodexCommand(task, null, '', null);

        expect(result.finalArgs).not.toContain('-m');
      });

      it('omits -m flag when model is null/undefined', () => {
        initModule();
        const task = { task_description: 'test', model: null };
        const result = commandBuilders.buildCodexCommand(task, null, '', null);

        expect(result.finalArgs).not.toContain('-m');
      });

      it('omits -m flag when model is empty string (falsy)', () => {
        initModule();
        const task = { task_description: 'test', model: '' };
        const result = commandBuilders.buildCodexCommand(task, null, '', null);

        expect(result.finalArgs).not.toContain('-m');
      });

      it('adds --full-auto when auto_approve is falsy', () => {
        initModule();
        const task = { task_description: 'test', auto_approve: 0 };
        const result = commandBuilders.buildCodexCommand(task, null, '', null);

        expect(result.finalArgs).toContain('--full-auto');
        expect(result.finalArgs).not.toContain('--dangerously-bypass-approvals-and-sandbox');
      });

      it('adds --dangerously-bypass-approvals-and-sandbox when auto_approve is truthy', () => {
        initModule();
        const task = { task_description: 'test', auto_approve: 1 };
        const result = commandBuilders.buildCodexCommand(task, null, '', null);

        expect(result.finalArgs).toContain('--dangerously-bypass-approvals-and-sandbox');
        expect(result.finalArgs).not.toContain('--full-auto');
      });

      it('adds -C working_directory when present', () => {
        initModule();
        const task = { task_description: 'test', working_directory: '/my/project' };
        const result = commandBuilders.buildCodexCommand(task, null, '', null);

        const cIdx = result.finalArgs.indexOf('-C');
        expect(cIdx).toBeGreaterThan(-1);
        expect(result.finalArgs[cIdx + 1]).toBe('/my/project');
      });

      it('omits -C when working_directory is null', () => {
        initModule();
        const task = { task_description: 'test', working_directory: null };
        const result = commandBuilders.buildCodexCommand(task, null, '', null);

        expect(result.finalArgs).not.toContain('-C');
      });

      it('always ends with "-" (stdin prompt marker)', () => {
        initModule();
        const task = { task_description: 'test', model: 'x', working_directory: '/w', auto_approve: 1 };
        const result = commandBuilders.buildCodexCommand(task, null, '', null);

        expect(result.finalArgs[result.finalArgs.length - 1]).toBe('-');
      });

      it('arg order: exec, --skip-git-repo-check, [-m model], approval flag, [-C dir], -', () => {
        initModule();
        const task = {
          task_description: 'test',
          model: 'gpt-5',
          auto_approve: 0,
          working_directory: '/proj',
        };
        const result = commandBuilders.buildCodexCommand(task, null, '', null);

        const args = result.finalArgs;
        expect(args[0]).toBe('exec');
        expect(args[1]).toBe('--skip-git-repo-check');
        expect(args.indexOf('-m')).toBe(2);
        expect(args.indexOf('--full-auto')).toBeGreaterThan(args.indexOf('-m'));
        expect(args.indexOf('-C')).toBeGreaterThan(args.indexOf('--full-auto'));
        expect(args[args.length - 1]).toBe('-');
      });
    });

    // --- CLI path resolution ---
    describe('cliPath resolution', () => {
      it('uses providerConfig.cli_path when provided', () => {
        initModule();
        const task = { task_description: 'test' };
        const result = commandBuilders.buildCodexCommand(task, { cli_path: '/usr/bin/codex' }, '', null);

        if (isWin) {
          expect(result.cliPath).toBe('/usr/bin/codex.cmd');
        } else {
          expect(result.cliPath).toBe('/usr/bin/codex');
        }
      });

      it('does not append .cmd when providerConfig.cli_path has extension', () => {
        initModule();
        const task = { task_description: 'test' };
        const result = commandBuilders.buildCodexCommand(task, { cli_path: 'C:\\bin\\codex.exe' }, '', null);

        expect(result.cliPath).toBe('C:\\bin\\codex.exe');
      });

      it('defaults to codex/codex.cmd when no providerConfig', () => {
        initModule({ nvmNodePath: null });
        const task = { task_description: 'test' };
        const result = commandBuilders.buildCodexCommand(task, null, '', null);

        if (isWin) {
          expect(result.cliPath).toBe('codex.cmd');
        } else {
          expect(result.cliPath).toBe('codex');
        }
      });

      if (!isWin) {
        it('uses nvmNodePath when set (non-Windows, no providerConfig)', () => {
          initModule({ nvmNodePath: '/home/user/.nvm/versions/node/v20/bin' });
          const task = { task_description: 'test' };
          const result = commandBuilders.buildCodexCommand(task, null, '', null);

          expect(result.cliPath).toBe('/home/user/.nvm/versions/node/v20/bin/node');
          expect(result.finalArgs[0]).toBe('/home/user/.nvm/versions/node/v20/bin/codex');
          // Original args follow
          expect(result.finalArgs[1]).toBe('exec');
        });
      }

      it('providerConfig.cli_path takes priority over nvmNodePath', () => {
        initModule({ nvmNodePath: '/nvm/bin' });
        const task = { task_description: 'test' };
        const cliPathValue = isWin ? 'C:\\tools\\codex.exe' : '/tools/codex';
        const result = commandBuilders.buildCodexCommand(task, { cli_path: cliPathValue }, '', null);

        expect(result.cliPath).toBe(cliPathValue);
        // Should NOT prepend nvm args
        expect(result.finalArgs[0]).toBe('exec');
      });

      it('providerConfig with empty object (no cli_path) falls through to default', () => {
        initModule({ nvmNodePath: null });
        const task = { task_description: 'test' };
        const result = commandBuilders.buildCodexCommand(task, {}, '', null);

        expect(result.cliPath).toBe(isWin ? 'codex.cmd' : 'codex');
      });
    });

    // --- Combined scenarios ---
    describe('full integration', () => {
      it('builds complete codex command with all options set', () => {
        initModule();
        const task = {
          task_description: 'Implement auth system',
          model: 'o3-pro',
          auto_approve: 1,
          working_directory: '/project/root',
          files: ['src/auth.ts'],
          project: 'myapp',
        };
        const result = commandBuilders.buildCodexCommand(task, null, 'file-context', null);

        expect(result.finalArgs).toEqual([
          'exec',
          '--skip-git-repo-check',
          '-m', 'o3-pro',
          '--dangerously-bypass-approvals-and-sandbox',
          '-C', '/project/root',
          '-',
        ]);
        expect(result.stdinPrompt).toContain('Implement auth system');
        expect(result.cliPath).toBe(isWin ? 'codex.cmd' : 'codex');
      });

      it('builds minimal codex command (no model, no working_directory, no auto_approve)', () => {
        initModule();
        const task = {
          task_description: 'Quick fix',
        };
        const result = commandBuilders.buildCodexCommand(task, null, '', null);

        expect(result.finalArgs).toEqual([
          'exec',
          '--skip-git-repo-check',
          '--full-auto',
          '-',
        ]);
      });
    });
  });
});
