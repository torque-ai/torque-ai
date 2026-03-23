/**
 * Codex Intelligence Module Tests
 *
 * Tests local system intelligence for Codex provider:
 * - Project type detection
 * - Pre-task analysis (type checking, file metadata)
 * - Lightweight file context
 * - Enriched prompt builder
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const mod = require('../providers/codex-intelligence');

// Create a temp project directory for tests
let tempDir;
let nodeProjectDir;
let tsProjectDir;
let emptyProjectDir;

beforeAll(() => {
  tempDir = path.join(os.tmpdir(), `torque-codex-intel-test-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  // Create a Node.js project
  nodeProjectDir = path.join(tempDir, 'node-project');
  fs.mkdirSync(nodeProjectDir, { recursive: true });
  fs.writeFileSync(path.join(nodeProjectDir, 'package.json'), JSON.stringify({
    name: 'test-project',
    dependencies: { express: '^4.18.0' },
    devDependencies: { vitest: '^1.0.0', vite: '^5.0.0' }
  }));
  fs.writeFileSync(path.join(nodeProjectDir, 'index.js'), `
const express = require('express');

function startServer(port) {
  const app = express();
  app.get('/', (req, res) => res.send('hello'));
  return app.listen(port);
}

module.exports = { startServer };
`);
  fs.writeFileSync(path.join(nodeProjectDir, 'utils.js'), `
function formatDate(d) { return d.toISOString(); }
function parseQuery(q) { return new URLSearchParams(q); }
module.exports = { formatDate, parseQuery };
`);

  // Create a TypeScript project
  tsProjectDir = path.join(tempDir, 'ts-project');
  fs.mkdirSync(tsProjectDir, { recursive: true });
  fs.writeFileSync(path.join(tsProjectDir, 'package.json'), JSON.stringify({
    name: 'ts-test',
    devDependencies: { typescript: '^5.0.0', jest: '^29.0.0', webpack: '^5.0.0' }
  }));
  fs.writeFileSync(path.join(tsProjectDir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'es2020', strict: true }
  }));
  fs.mkdirSync(path.join(tsProjectDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tsProjectDir, 'src', 'app.ts'), `
export interface Config {
  port: number;
  host: string;
}

export class App {
  private config: Config;
  constructor(config: Config) {
    this.config = config;
  }
  start(): void {
    console.log(\`Starting on \${this.config.host}:\${this.config.port}\`);
  }
}
`);

  // Create an empty directory
  emptyProjectDir = path.join(tempDir, 'empty-project');
  fs.mkdirSync(emptyProjectDir, { recursive: true });

  // Initialize module with mock db
  mod.init({
    db: {
      getConfig: (key) => {
        if (key === 'verify_command') return 'npx vitest run';
        if (key === 'codex_pre_analysis') return '0'; // Disable tsc in tests
        return null;
      }
    },
    prompts: {
      detectTaskTypes: (desc) => {
        const types = [];
        if (desc.toLowerCase().includes('readme')) types.push('markdown');
        return types;
      },
      TASK_TYPE_INSTRUCTIONS: {
        'markdown': '\n### MARKDOWN RULES: Use indented code blocks'
      }
    }
  });
});

afterAll(() => {
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── detectProjectInfo ──────────────────────────────────────────────────

describe('detectProjectInfo', () => {
  it('detects Node.js project with vitest and vite', () => {
    const info = mod.detectProjectInfo(nodeProjectDir);
    expect(info.type).toBe('node');
    expect(info.language).toBe('javascript');
    expect(info.testFramework).toBe('vitest');
    expect(info.buildTool).toBe('vite');
    expect(info.hasTypeScript).toBe(false);
  });

  it('detects TypeScript project with jest and webpack', () => {
    const info = mod.detectProjectInfo(tsProjectDir);
    expect(info.type).toBe('node');
    expect(info.language).toBe('typescript');
    expect(info.testFramework).toBe('jest');
    expect(info.buildTool).toBe('webpack');
    expect(info.hasTypeScript).toBe(true);
  });

  it('returns unknown for empty directory', () => {
    const info = mod.detectProjectInfo(emptyProjectDir);
    expect(info.type).toBe('unknown');
    expect(info.language).toBe('unknown');
    expect(info.testFramework).toBeNull();
    expect(info.buildTool).toBeNull();
  });

  it('returns default for null workingDir', () => {
    const info = mod.detectProjectInfo(null);
    expect(info.type).toBe('unknown');
  });

  it('returns default for undefined workingDir', () => {
    const info = mod.detectProjectInfo(undefined);
    expect(info.type).toBe('unknown');
  });

  it('detects Rust project', () => {
    const rustDir = path.join(tempDir, 'rust-project');
    fs.mkdirSync(rustDir, { recursive: true });
    fs.writeFileSync(path.join(rustDir, 'Cargo.toml'), '[package]\nname = "test"');
    const info = mod.detectProjectInfo(rustDir);
    expect(info.type).toBe('rust');
    expect(info.language).toBe('rust');
  });

  it('detects Go project', () => {
    const goDir = path.join(tempDir, 'go-project');
    fs.mkdirSync(goDir, { recursive: true });
    fs.writeFileSync(path.join(goDir, 'go.mod'), 'module test\ngo 1.21');
    const info = mod.detectProjectInfo(goDir);
    expect(info.type).toBe('go');
    expect(info.language).toBe('go');
  });

  it('detects Python project via pyproject.toml', () => {
    const pyDir = path.join(tempDir, 'py-project');
    fs.mkdirSync(pyDir, { recursive: true });
    fs.writeFileSync(path.join(pyDir, 'pyproject.toml'), '[project]\nname = "test"');
    const info = mod.detectProjectInfo(pyDir);
    expect(info.type).toBe('python');
    expect(info.language).toBe('python');
  });

  it('detects Python project via requirements.txt', () => {
    const pyDir2 = path.join(tempDir, 'py-project-req');
    fs.mkdirSync(pyDir2, { recursive: true });
    fs.writeFileSync(path.join(pyDir2, 'requirements.txt'), 'flask==2.0\nrequests==2.28');
    const info = mod.detectProjectInfo(pyDir2);
    expect(info.type).toBe('python');
    expect(info.language).toBe('python');
  });

  it('detects mocha test framework', () => {
    const mochaDir = path.join(tempDir, 'mocha-project');
    fs.mkdirSync(mochaDir, { recursive: true });
    fs.writeFileSync(path.join(mochaDir, 'package.json'), JSON.stringify({
      devDependencies: { mocha: '^10.0.0' }
    }));
    const info = mod.detectProjectInfo(mochaDir);
    expect(info.testFramework).toBe('mocha');
  });

  it('detects ava test framework', () => {
    const avaDir = path.join(tempDir, 'ava-project');
    fs.mkdirSync(avaDir, { recursive: true });
    fs.writeFileSync(path.join(avaDir, 'package.json'), JSON.stringify({
      devDependencies: { ava: '^5.0.0' }
    }));
    const info = mod.detectProjectInfo(avaDir);
    expect(info.testFramework).toBe('ava');
  });

  it('detects esbuild build tool', () => {
    const esbuildDir = path.join(tempDir, 'esbuild-project');
    fs.mkdirSync(esbuildDir, { recursive: true });
    fs.writeFileSync(path.join(esbuildDir, 'package.json'), JSON.stringify({
      devDependencies: { esbuild: '^0.19.0' }
    }));
    const info = mod.detectProjectInfo(esbuildDir);
    expect(info.buildTool).toBe('esbuild');
  });

  it('detects rollup build tool', () => {
    const rollupDir = path.join(tempDir, 'rollup-project');
    fs.mkdirSync(rollupDir, { recursive: true });
    fs.writeFileSync(path.join(rollupDir, 'package.json'), JSON.stringify({
      devDependencies: { rollup: '^4.0.0' }
    }));
    const info = mod.detectProjectInfo(rollupDir);
    expect(info.buildTool).toBe('rollup');
  });

  it('detects TypeScript from tsconfig.json even without package.json', () => {
    const tsOnlyDir = path.join(tempDir, 'ts-only');
    fs.mkdirSync(tsOnlyDir, { recursive: true });
    fs.writeFileSync(path.join(tsOnlyDir, 'tsconfig.json'), '{}');
    const info = mod.detectProjectInfo(tsOnlyDir);
    expect(info.hasTypeScript).toBe(true);
    expect(info.language).toBe('typescript');
  });

  it('prefers vitest over jest when both present', () => {
    const bothDir = path.join(tempDir, 'both-test');
    fs.mkdirSync(bothDir, { recursive: true });
    fs.writeFileSync(path.join(bothDir, 'package.json'), JSON.stringify({
      devDependencies: { vitest: '^1.0.0', jest: '^29.0.0' }
    }));
    const info = mod.detectProjectInfo(bothDir);
    expect(info.testFramework).toBe('vitest');
  });
});

// ─── extractKeyExports ──────────────────────────────────────────────────

describe('extractKeyExports', () => {
  it('extracts exported functions', () => {
    const content = `
export function createApp() {}
export async function startServer() {}
function privateHelper() {}
`;
    const exports = mod.extractKeyExports(content, '.ts');
    expect(exports).toContain('fn:createApp');
    expect(exports).toContain('fn:startServer');
    expect(exports).toContain('fn:privateHelper');
  });

  it('extracts classes', () => {
    const content = `
export class MyService {}
export abstract class BaseHandler {}
`;
    const exports = mod.extractKeyExports(content, '.ts');
    expect(exports).toContain('class:MyService');
    expect(exports).toContain('class:BaseHandler');
  });

  it('extracts interfaces', () => {
    const content = `
export interface Config {
  port: number;
}
interface InternalState {}
`;
    const exports = mod.extractKeyExports(content, '.ts');
    expect(exports).toContain('iface:Config');
  });

  it('extracts module.exports keys when no function declarations', () => {
    // module.exports is a fallback — only used when no fn/class/iface found
    const content = `
const startServer = () => {};
const stopServer = () => {};
module.exports = { startServer, stopServer };
`;
    const exports = mod.extractKeyExports(content, '.js');
    expect(exports).toContain('exp:startServer');
    expect(exports).toContain('exp:stopServer');
  });

  it('returns empty for empty content', () => {
    expect(mod.extractKeyExports('', '.js')).toEqual([]);
    expect(mod.extractKeyExports(null, '.js')).toEqual([]);
  });

  it('limits to 15 exports', () => {
    const content = Array.from({ length: 20 }, (_, i) => `function fn${i}() {}`).join('\n');
    const exports = mod.extractKeyExports(content, '.js');
    expect(exports.length).toBeLessThanOrEqual(15);
  });

  it('handles mixed export styles', () => {
    const content = `
export function publicFn() {}
class MyClass {}
export interface MyInterface {}
module.exports = { other };
`;
    const exports = mod.extractKeyExports(content, '.ts');
    expect(exports).toContain('fn:publicFn');
    expect(exports).toContain('class:MyClass');
    expect(exports).toContain('iface:MyInterface');
    // module.exports should not be included when other exports found
  });
});

// ─── runPreAnalysis ─────────────────────────────────────────────────────

describe('runPreAnalysis', () => {
  it('returns file info for existing files', () => {
    const result = mod.runPreAnalysis(nodeProjectDir, ['index.js', 'utils.js']);
    expect(result.fileInfo).toHaveLength(2);
    expect(result.fileInfo[0].path).toBe('index.js');
    expect(result.fileInfo[0].lines).toBeGreaterThan(0);
    expect(result.fileInfo[0].size).toBeGreaterThan(0);
    expect(result.fileInfo[0].exports).toContain('fn:startServer');
  });

  it('returns zero info for nonexistent files', () => {
    const result = mod.runPreAnalysis(nodeProjectDir, ['nonexistent.js']);
    expect(result.fileInfo).toHaveLength(1);
    expect(result.fileInfo[0].size).toBe(0);
    expect(result.fileInfo[0].lines).toBe(0);
  });

  it('handles empty file list', () => {
    const result = mod.runPreAnalysis(nodeProjectDir, []);
    expect(result.fileInfo).toHaveLength(0);
    expect(result.existingErrors).toHaveLength(0);
  });

  it('handles null workingDir', () => {
    const result = mod.runPreAnalysis(null, ['file.js']);
    expect(result.fileInfo).toHaveLength(0);
  });

  it('handles null filePaths', () => {
    const result = mod.runPreAnalysis(nodeProjectDir, null);
    expect(result.fileInfo).toHaveLength(0);
  });

  it('extracts exports from TypeScript files', () => {
    const result = mod.runPreAnalysis(tsProjectDir, ['src/app.ts']);
    expect(result.fileInfo).toHaveLength(1);
    expect(result.fileInfo[0].exports).toContain('iface:Config');
    expect(result.fileInfo[0].exports).toContain('class:App');
  });
});

// ─── buildLightweightFileContext ────────────────────────────────────────

describe('buildLightweightFileContext', () => {
  it('builds file listing with sizes and exports', () => {
    const resolvedFiles = [
      { actual: 'index.js', mentioned: 'index.js' },
      { actual: 'utils.js', mentioned: 'utils.js' },
    ];
    const analysis = {
      fileInfo: [
        { path: 'index.js', size: 1500, lines: 45, exports: ['exp:startServer'] },
        { path: 'utils.js', size: 800, lines: 20, exports: ['exp:formatDate', 'exp:parseQuery'] },
      ]
    };
    const context = mod.buildLightweightFileContext(resolvedFiles, nodeProjectDir, analysis);
    expect(context).toContain('Target Files');
    expect(context).toContain('index.js');
    expect(context).toContain('45 lines');
    expect(context).toContain('exp:startServer');
    expect(context).toContain('utils.js');
    expect(context).toContain('exp:formatDate');
  });

  it('marks new files', () => {
    const resolvedFiles = [{ actual: 'new-file.ts', mentioned: 'new-file.ts' }];
    const analysis = { fileInfo: [{ path: 'new-file.ts', size: 0, lines: 0, exports: [] }] };
    const context = mod.buildLightweightFileContext(resolvedFiles, nodeProjectDir, analysis);
    expect(context).toContain('new file');
  });

  it('returns empty for no resolved files', () => {
    expect(mod.buildLightweightFileContext(null, nodeProjectDir, { fileInfo: [] })).toBe('');
    expect(mod.buildLightweightFileContext([], nodeProjectDir, { fileInfo: [] })).toBe('');
  });

  it('handles files not in analysis', () => {
    const resolvedFiles = [{ actual: 'mystery.js', mentioned: 'mystery.js' }];
    const analysis = { fileInfo: [] };
    const context = mod.buildLightweightFileContext(resolvedFiles, nodeProjectDir, analysis);
    expect(context).toContain('mystery.js');
    expect(context).toContain('new file');
  });
});

// ─── buildCodexEnrichedPrompt ───────────────────────────────────────────

describe('buildCodexEnrichedPrompt', () => {
  const baseTask = {
    task_description: 'Add a new endpoint to the API server',
    files: ['index.js'],
    project: 'test-project'
  };

  it('includes task description', () => {
    const prompt = mod.buildCodexEnrichedPrompt(
      baseTask,
      [{ actual: 'index.js', mentioned: 'index.js' }],
      nodeProjectDir,
      ''
    );
    expect(prompt).toContain('Add a new endpoint to the API server');
  });

  it('includes project info', () => {
    const prompt = mod.buildCodexEnrichedPrompt(
      baseTask,
      [{ actual: 'index.js', mentioned: 'index.js' }],
      nodeProjectDir,
      ''
    );
    expect(prompt).toContain('node');
    expect(prompt).toContain('vitest');
  });

  it('includes lightweight file context', () => {
    const prompt = mod.buildCodexEnrichedPrompt(
      baseTask,
      [{ actual: 'index.js', mentioned: 'index.js' }],
      nodeProjectDir,
      ''
    );
    expect(prompt).toContain('Target Files');
    expect(prompt).toContain('index.js');
  });

  it('includes quality rules', () => {
    const prompt = mod.buildCodexEnrichedPrompt(
      baseTask,
      [{ actual: 'index.js', mentioned: 'index.js' }],
      nodeProjectDir,
      ''
    );
    expect(prompt).toContain('Quality Rules');
    expect(prompt).toContain('CRITICAL RULES');
  });

  it('includes enrichment when provided', () => {
    const enrichment = '\n### IMPORTED TYPE SIGNATURES\ninterface Config { port: number; }';
    const prompt = mod.buildCodexEnrichedPrompt(
      baseTask,
      [{ actual: 'index.js', mentioned: 'index.js' }],
      nodeProjectDir,
      enrichment
    );
    expect(prompt).toContain('IMPORTED TYPE SIGNATURES');
    expect(prompt).toContain('interface Config');
  });

  it('includes verify command when configured', () => {
    const config = require('../config');
    const getSpy = vi.spyOn(config, 'get').mockImplementation((key) => (
      key === 'verify_command' ? 'npx vitest run' : null
    ));
    const prompt = mod.buildCodexEnrichedPrompt(
      baseTask,
      [{ actual: 'index.js', mentioned: 'index.js' }],
      nodeProjectDir,
      ''
    );
    expect(prompt).toContain('Verification');
    expect(prompt).toContain('npx vitest run');
    getSpy.mockRestore();
  });

  it('includes task type instructions for markdown tasks', () => {
    const mdTask = {
      ...baseTask,
      task_description: 'Write the README for this project'
    };
    const prompt = mod.buildCodexEnrichedPrompt(
      mdTask,
      [],
      nodeProjectDir,
      ''
    );
    expect(prompt).toContain('MARKDOWN RULES');
  });

  it('handles no resolved files', () => {
    const prompt = mod.buildCodexEnrichedPrompt(
      baseTask,
      [],
      nodeProjectDir,
      ''
    );
    expect(prompt).toContain('Add a new endpoint');
    expect(prompt).not.toContain('Target Files');
  });

  it('handles null resolved files', () => {
    const prompt = mod.buildCodexEnrichedPrompt(
      baseTask,
      null,
      nodeProjectDir,
      ''
    );
    expect(prompt).toContain('Add a new endpoint');
  });

  it('handles empty working directory', () => {
    const prompt = mod.buildCodexEnrichedPrompt(
      baseTask,
      [],
      emptyProjectDir,
      ''
    );
    expect(prompt).toContain('Add a new endpoint');
    // Should not contain project section since type is unknown
  });

  it('does not contain full file contents', () => {
    const prompt = mod.buildCodexEnrichedPrompt(
      baseTask,
      [{ actual: 'index.js', mentioned: 'index.js' }],
      nodeProjectDir,
      ''
    );
    // Should NOT contain the actual code from index.js
    expect(prompt).not.toContain("const express = require('express')");
    expect(prompt).not.toContain('app.get');
    // But should reference the file
    expect(prompt).toContain('index.js');
  });

  it('is significantly smaller than full file context', () => {
    const prompt = mod.buildCodexEnrichedPrompt(
      baseTask,
      [{ actual: 'index.js', mentioned: 'index.js' },
       { actual: 'utils.js', mentioned: 'utils.js' }],
      nodeProjectDir,
      ''
    );
    // Full file context would be several KB; enriched prompt should be much smaller
    expect(prompt.length).toBeLessThan(3000);
  });

  it('includes TypeScript project info for TS projects', () => {
    const prompt = mod.buildCodexEnrichedPrompt(
      { ...baseTask, task_description: 'Fix the App class' },
      [{ actual: 'src/app.ts', mentioned: 'app.ts' }],
      tsProjectDir,
      ''
    );
    expect(prompt).toContain('typescript');
    expect(prompt).toContain('TypeScript: yes');
  });
});

// ─── Integration: full flow ─────────────────────────────────────────────

describe('Integration', () => {
  it('produces a well-structured prompt for a typical code task', () => {
    const config = require('../config');
    const getSpy = vi.spyOn(config, 'get').mockImplementation((key) => (
      key === 'verify_command' ? 'npx vitest run' : null
    ));
    const task = {
      task_description: 'Add input validation to the startServer function in index.js',
      files: ['index.js'],
      project: 'test-project'
    };
    const resolvedFiles = [{ actual: 'index.js', mentioned: 'index.js' }];
    const enrichment = '\n### RECENT GIT CONTEXT\nRecent commits:\nabc123 fix: initial commit\n';

    const prompt = mod.buildCodexEnrichedPrompt(task, resolvedFiles, nodeProjectDir, enrichment);

    // Structure checks
    expect(prompt).toContain('## Task');
    expect(prompt).toContain('## Project');
    expect(prompt).toContain('## Target Files');
    expect(prompt).toContain('## Quality Rules');
    expect(prompt).toContain('## Verification');
    expect(prompt).toContain('RECENT GIT CONTEXT');

    // Content checks
    expect(prompt).toContain('input validation');
    expect(prompt).toContain('index.js');
    expect(prompt).toContain('vitest');
    expect(prompt).toContain('npx vitest run');
    getSpy.mockRestore();
  });

  it('handles complete empty context gracefully', () => {
    const task = {
      task_description: 'Create a new service',
      files: [],
      project: 'new-project'
    };
    const prompt = mod.buildCodexEnrichedPrompt(task, null, null, '');
    expect(prompt).toContain('Create a new service');
    expect(prompt).toContain('Quality Rules');
  });
});
