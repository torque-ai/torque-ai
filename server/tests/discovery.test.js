const path = require('path');
const os = require('os');
const fs = require('fs');
const { setupTestDb, teardownTestDb, safeTool, getText, resetTables } = require('./vitest-setup');

describe('Project Discovery Scanning', () => {
  let projectDir;

  beforeAll(() => {
    setupTestDb('discovery-scan');
  });

  afterAll(() => {
    teardownTestDb();
  });

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-discovery-test-'));
  });

  afterEach(() => {
    if (projectDir && fs.existsSync(projectDir)) {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  function writeFile(relativePath, content = '') {
    const fullPath = path.join(projectDir, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    if (Buffer.isBuffer(content)) {
      fs.writeFileSync(fullPath, content);
    } else {
      fs.writeFileSync(fullPath, content, 'utf8');
    }
  }

  function mkdir(relativePath) {
    fs.mkdirSync(path.join(projectDir, relativePath), { recursive: true });
  }

  async function scanProject(extraArgs = {}) {
    const result = await safeTool('scan_project', {
      path: projectDir,
      ...extraArgs
    });
    expect(result.isError).toBeFalsy();
    return getText(result).replace(/\\/g, '/');
  }

  function missingFilesInOrder(output) {
    const matches = [...output.matchAll(/^- (.+?) \((\d+) lines\)$/gm)];
    return matches.map(m => ({ file: m[1], lines: Number(m[2]) }));
  }

  describe('File Scanning', () => {
    it('scanDirectory returns file list with sizes', async () => {
      writeFile('src/alpha.ts', 'a\nb\nc');
      writeFile('src/beta.js', 'x\ny');

      const text = await scanProject({ checks: ['file_sizes'] });
      expect(text).toContain('### File Sizes');
      expect(text).toContain('**2 code files, 5 total lines**');
      expect(text).toContain('| src/alpha.ts | 3 |');
      expect(text).toContain('| src/beta.js | 2 |');
    });

    it('scanDirectory respects ignore_dirs (node_modules, .git, dist)', async () => {
      writeFile('src/keep.ts', 'export const keep = true;');
      writeFile('node_modules/pkg/index.js', 'console.log("skip");');
      writeFile('.git/hooks/pre-commit', 'echo skip');
      writeFile('dist/bundle.js', 'console.log("skip");');

      const text = await scanProject({ checks: ['summary'] });
      expect(text).toContain('**Total files:** 1');
      expect(text).toContain('| src | 1 |');
      expect(text).not.toContain('node_modules');
      expect(text).not.toContain('.git');
      expect(text).not.toContain('dist');
    });

    it('scanDirectory handles empty directories', async () => {
      mkdir('src');
      mkdir('docs');

      const text = await scanProject({ checks: ['summary'] });
      expect(text).toContain('**Total files:** 0');
    });

    it('scanDirectory handles nested directories', async () => {
      writeFile('src/core/feature/deep/module.ts', 'export const x = 1;');

      const text = await scanProject({ checks: ['summary'] });
      expect(text).toContain('**Total files:** 1');
      expect(text).toContain('| src | 1 |');
      expect(text).toContain('| .ts | 1 |');
    });

    it('counts files by extension correctly', async () => {
      writeFile('src/a.ts', 'export const a = 1;');
      writeFile('src/b.ts', 'export const b = 2;');
      writeFile('src/c.js', 'module.exports = {};');
      writeFile('README', 'no extension');

      const text = await scanProject({ checks: ['summary'] });
      expect(text).toContain('| .ts | 2 |');
      expect(text).toContain('| .js | 1 |');
      expect(text).toContain('| (no ext) | 1 |');
    });
  });

  describe('Test Gap Detection', () => {
    it('findMissingTests identifies source files without test files', async () => {
      writeFile('src/foo.ts', 'export const foo = 1;');
      writeFile('src/bar.ts', 'export const bar = 2;\nexport const baz = 3;');
      writeFile('src/foo.test.ts', 'describe("foo", () => {});');

      const text = await scanProject({ checks: ['missing_tests'], test_pattern: '.test.ts' });
      expect(text).toContain('### Test Coverage');
      expect(text).toContain('**1/2 source files have tests (50%)**');
      expect(text).toContain('src/bar.ts');
      expect(text).not.toContain('src/foo.ts (');
    });

    it('findMissingTests respects custom test_pattern', async () => {
      writeFile('src/math.ts', 'export const add = (a, b) => a + b;');
      writeFile('src/math.spec.ts', 'describe("math", () => {});');

      const text = await scanProject({
        checks: ['missing_tests'],
        test_pattern: '.spec.ts'
      });
      expect(text).toContain('**1/1 source files have tests (100%)**');
      expect(text).not.toContain('Missing tests (');
    });

    it('findMissingTests skips test files themselves', async () => {
      writeFile('src/only.test.ts', 'describe("only", () => {});');
      writeFile('src/real.ts', 'export const real = true;');

      const text = await scanProject({ checks: ['missing_tests'], test_pattern: '.test.ts' });
      expect(text).toContain('**0/1 source files have tests (0%)**');
      expect(text).not.toContain('only.test.ts (');
      expect(text).toContain('src/real.ts');
    });

    it('findMissingTests sorts by file size (largest first)', async () => {
      writeFile('src/small.ts', 'a\nb');
      writeFile('src/large.ts', Array.from({ length: 12 }, (_, i) => `line${i}`).join('\n'));

      const text = await scanProject({ checks: ['missing_tests'] });
      const missing = missingFilesInOrder(text);
      expect(missing[0].file).toBe('src/large.ts');
      expect(missing[1].file).toBe('src/small.ts');
      expect(missing[0].lines).toBeGreaterThan(missing[1].lines);
    });

    it('findMissingTests handles .jsx/.tsx extensions', async () => {
      writeFile('src/App.jsx', 'export function App() { return null; }');
      writeFile('src/Button.tsx', 'export const Button = () => null;');
      writeFile('src/App.test.tsx', 'describe("App", () => {});');

      const text = await scanProject({
        checks: ['missing_tests'],
        test_pattern: '.test.tsx'
      });
      expect(text).toContain('**1/2 source files have tests (50%)**');
      expect(text).toContain('src/Button.tsx');
      expect(text).not.toContain('src/App.jsx (');
    });
  });

  describe('TODO Scanning', () => {
    it('findTodos detects TODO comments', async () => {
      writeFile('src/todo.ts', 'const x = 1;\n// TODO: implement this\nexport default x;');

      const text = await scanProject({ checks: ['todos'] });
      expect(text).toContain('### TODOs/FIXMEs');
      expect(text).toContain('**1 found**');
      expect(text).toContain('**TODO** src/todo.ts:2');
    });

    it('findTodos detects FIXME, HACK, XXX, TEMP', async () => {
      writeFile(
        'src/markers.ts',
        [
          '// FIXME: fix edge case',
          '// HACK: temporary patch',
          '// XXX: revisit logic',
          '// TEMP: remove before release',
        ].join('\n')
      );

      const text = await scanProject({ checks: ['todos'] });
      expect(text).toContain('**4 found**');
      expect(text).toContain('**FIXME**');
      expect(text).toContain('**HACK**');
      expect(text).toContain('**XXX**');
      expect(text).toContain('**TEMP**');
    });

    it('findTodos returns file path and line number', async () => {
      writeFile('src/nested/todo-lines.ts', 'line1\nline2\n// TODO line3');

      const text = await scanProject({ checks: ['todos'] });
      expect(text).toContain('src/nested/todo-lines.ts:3');
    });

    it('findTodos skips binary files', async () => {
      writeFile('assets/image.png', Buffer.from('TODO in binary file should be ignored', 'utf8'));
      writeFile('src/code.ts', '// TODO: tracked');

      const text = await scanProject({ checks: ['todos'] });
      expect(text).toContain('**1 found**');
      expect(text).toContain('src/code.ts');
      expect(text).not.toContain('assets/image.png');
    });

    it('findTodos respects ignore patterns', async () => {
      writeFile('ignoreme/skip.ts', '// TODO: should be skipped');
      writeFile('src/include.ts', '// TODO: should be included');

      const text = await scanProject({
        checks: ['todos'],
        ignore_dirs: ['ignoreme']
      });
      expect(text).toContain('**1 found**');
      expect(text).toContain('src/include.ts');
      expect(text).not.toContain('ignoreme/skip.ts');
    });

    it('findTodos filters to requested marker types', async () => {
      writeFile(
        'src/filtered.ts',
        [
          '// TODO: keep this out',
          '// FIXME: include this',
          '// HACK: include this too',
          '// TEMP: keep this out too',
        ].join('\n')
      );

      const text = await scanProject({
        checks: ['todos'],
        todo_types: ['FIXME', 'HACK']
      });
      expect(text).toContain('**2 found**');
      expect(text).toContain('**FIXME** src/filtered.ts:2');
      expect(text).toContain('**HACK** src/filtered.ts:3');
      expect(text).not.toContain('**TODO**');
      expect(text).not.toContain('**TEMP**');
    });

    it('findTodos scopes TODO discovery to explicit source_dirs', async () => {
      writeFile('server/handlers/keep.js', '// FIXME: include handlers debt');
      writeFile('server/execution/keep.js', '// HACK: include execution debt');
      writeFile('dashboard/skip.js', '// FIXME: do not include dashboard debt');

      const text = await scanProject({
        checks: ['todos'],
        source_dirs: ['server/handlers', 'server/execution'],
        todo_types: ['FIXME', 'HACK']
      });
      expect(text).toContain('**2 found**');
      expect(text).toContain('server/handlers/keep.js:1');
      expect(text).toContain('server/execution/keep.js:1');
      expect(text).not.toContain('dashboard/skip.js');
    });

    it('findTodos can return every match when todo_limit is zero', async () => {
      writeFile(
        'src/unlimited.ts',
        [
          '// TODO: first',
          '// TODO: second',
          '// TODO: third',
        ].join('\n')
      );

      const text = await scanProject({
        checks: ['todos'],
        todo_limit: 0
      });
      expect(text).toContain('**3 found**');
      expect(text).toContain('src/unlimited.ts:1');
      expect(text).toContain('src/unlimited.ts:2');
      expect(text).toContain('src/unlimited.ts:3');
    });

    it('findTodos comment-only mode ignores regex and string literals', async () => {
      writeFile(
        'src/comment-only.ts',
        [
          "const todoPattern = /\\b(TODO|FIXME|HACK|XXX|TEMP)\\b/i;",
          "const label = '// FIXME: string literal only';",
          '// FIXME: real comment',
        ].join('\n')
      );

      const text = await scanProject({
        checks: ['todos'],
        todo_types: ['FIXME', 'HACK'],
        todo_comments_only: true
      });
      expect(text).toContain('**1 found**');
      expect(text).toContain('**FIXME** src/comment-only.ts:3');
      expect(text).not.toContain('src/comment-only.ts:1');
      expect(text).not.toContain('src/comment-only.ts:2');
    });
  });

  describe('Dependency Analysis', () => {
    it('analyzeDependencies reads package.json', async () => {
      writeFile(
        'package.json',
        JSON.stringify({
          name: 'demo-project',
          version: '1.2.3',
          scripts: { build: 'node build.js', test: 'vitest run' },
          dependencies: { express: '^4.0.0' },
          devDependencies: { vitest: '^4.0.0' }
        }, null, 2)
      );

      const text = await scanProject({ checks: ['dependencies'] });
      expect(text).toContain('### Dependencies');
      expect(text).toContain('**demo-project** v1.2.3');
      expect(text).toContain('**Scripts:** build, test');
      expect(text).toContain('**Dependencies (1):** express');
      expect(text).toContain('**Dev dependencies (1):** vitest');
    });

    it('analyzeDependencies handles missing package.json', async () => {
      writeFile('src/app.ts', 'export const app = true;');

      const text = await scanProject({ checks: ['dependencies'] });
      expect(text).toContain('### Dependencies');
      expect(text).not.toContain('Failed to parse package.json');
    });

    it('analyzeDependencies extracts devDependencies', async () => {
      writeFile(
        'package.json',
        JSON.stringify({
          name: 'deps-only',
          devDependencies: { eslint: '^9.0.0', vitest: '^4.0.0' }
        }, null, 2)
      );

      const text = await scanProject({ checks: ['dependencies'] });
      expect(text).toContain('**Dev dependencies (2):** eslint, vitest');
    });
  });

  describe('File Size Analysis', () => {
    it('getFileSizes returns sorted list by line count', async () => {
      writeFile('src/tiny.ts', '1');
      writeFile('src/medium.ts', '1\n2\n3\n4');
      writeFile('src/large.ts', Array.from({ length: 9 }, (_, i) => `${i}`).join('\n'));

      const text = await scanProject({ checks: ['file_sizes'] });
      const largeIndex = text.indexOf('| src/large.ts | 9 |');
      const mediumIndex = text.indexOf('| src/medium.ts | 4 |');
      const tinyIndex = text.indexOf('| src/tiny.ts | 1 |');
      expect(largeIndex).toBeGreaterThan(-1);
      expect(mediumIndex).toBeGreaterThan(-1);
      expect(tinyIndex).toBeGreaterThan(-1);
      expect(largeIndex).toBeLessThan(mediumIndex);
      expect(mediumIndex).toBeLessThan(tinyIndex);
    });

    it('getFileSizes handles empty files', async () => {
      writeFile('src/empty.ts', '');
      writeFile('src/nonempty.ts', 'line1\nline2');

      const text = await scanProject({ checks: ['file_sizes'] });
      expect(text).toContain('| src/empty.ts | 1 |');
      expect(text).toContain('| src/nonempty.ts | 2 |');
    });

    it('getLargestFiles returns top N files', async () => {
      for (let i = 1; i <= 20; i++) {
        writeFile(`src/file-${i}.ts`, Array.from({ length: i }, () => 'x').join('\n'));
      }

      const text = await scanProject({ checks: ['file_sizes'] });
      const rows = (text.match(/^\| src\/file-\d+\.ts \| \d+ \|$/gm) || []).length;
      expect(rows).toBe(15);
      expect(text).toContain('| src/file-20.ts | 20 |');
      expect(text).not.toContain('| src/file-1.ts | 1 |');
    });
  });

  describe('Summary Generation', () => {
    it('generateSummary returns structured project overview', async () => {
      writeFile('src/a.ts', 'export const a = 1;');
      writeFile('tests/a.test.ts', 'describe("a", () => {});');

      const text = await scanProject({ checks: ['summary'] });
      expect(text).toContain('### Summary');
      expect(text).toContain('| Directory | Files |');
      expect(text).toContain('| Extension | Files |');
    });

    it('generateSummary counts by directory', async () => {
      writeFile('src/one.ts', 'export const one = 1;');
      writeFile('src/two.ts', 'export const two = 2;');
      writeFile('tests/one.test.ts', 'describe("one", () => {});');
      writeFile('docs/readme.md', '# docs');

      const text = await scanProject({ checks: ['summary'] });
      expect(text).toContain('| src | 2 |');
      expect(text).toContain('| tests | 1 |');
      expect(text).toContain('| docs | 1 |');
    });

    it('generateSummary counts by extension', async () => {
      writeFile('src/a.ts', 'export const a = 1;');
      writeFile('src/b.tsx', 'export const B = () => null;');
      writeFile('src/c.js', 'module.exports = {};');
      writeFile('docs/notes.md', 'notes');

      const text = await scanProject({ checks: ['summary'] });
      expect(text).toContain('| .ts | 1 |');
      expect(text).toContain('| .tsx | 1 |');
      expect(text).toContain('| .js | 1 |');
      expect(text).toContain('| .md | 1 |');
    });
  });
});

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

function loadDiscoveryWithBonjour(mockBonjour) {
  delete require.cache[require.resolve('../discovery')];
  installMock('bonjour-service', {
    Bonjour: vi.fn(function MockBonjour() {
      return mockBonjour;
    }),
  });
  return require('../discovery');
}

describe('Bonjour Discovery Host Identities', () => {
  let configCore;
  let hostManagement;
  let loadedDiscovery = null;

  beforeAll(() => {
    setupTestDb('discovery-mdns');
    configCore = require('../db/config-core');
    hostManagement = require('../db/host-management');
  });

  afterAll(() => {
    teardownTestDb();
  });

  beforeEach(() => {
    resetTables(['ollama_hosts', 'config']);
  });

  afterEach(() => {
    if (loadedDiscovery) {
      loadedDiscovery.shutdownDiscovery();
      loadedDiscovery = null;
    }
    delete require.cache[require.resolve('../discovery')];
    delete require.cache[require.resolve('bonjour-service')];
    vi.restoreAllMocks();
  });

  function setDiscoveryConfig(overrides = {}) {
    const config = {
      discovery_enabled: '1',
      discovery_advertise: '1',
      discovery_browse: '1',
      ollama_host: 'http://127.0.0.1:11434',
      ...overrides,
    };

    for (const [key, value] of Object.entries(config)) {
      configCore.setConfig(key, value);
    }
  }

  function mockLocalNetwork(address = '192.168.50.10') {
    vi.spyOn(os, 'hostname').mockReturnValue('alpha');
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({
      Ethernet: [
        { family: 'IPv4', internal: false, address },
      ],
    });
  }

  function stubDiscoveryHttp() {
    const http = require('http');
    const https = require('https');
    const request = {
      on: vi.fn().mockReturnThis(),
      destroy: vi.fn(),
    };

    vi.spyOn(http, 'get').mockImplementation(() => request);
    vi.spyOn(https, 'get').mockImplementation(() => request);
  }

  it('includes the port in the advertised Bonjour service identity', () => {
    const mockAdvertiser = { stop: vi.fn() };
    const mockBrowser = { on: vi.fn(), stop: vi.fn() };
    const publish = vi.fn(() => mockAdvertiser);
    const find = vi.fn(() => mockBrowser);

    setDiscoveryConfig({
      discovery_browse: '0',
      ollama_host: 'http://127.0.0.1:22434',
    });
    mockLocalNetwork();

    loadedDiscovery = loadDiscoveryWithBonjour({
      publish,
      find,
      destroy: vi.fn(),
    });

    const result = loadedDiscovery.initDiscovery();

    expect(result).toEqual({ success: true });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      name: 'alpha-ollama-22434',
      type: 'ollama',
      port: 22434,
      txt: expect.objectContaining({
        id: 'alpha-22434',
        name: 'alpha Ollama',
        url: 'http://192.168.50.10:22434',
      }),
    }));
    expect(find).not.toHaveBeenCalled();
  });

  it('derives discovered host ids from the service url so same-host different-port services do not collide', () => {
    const handlers = {};
    const mockBrowser = {
      on: vi.fn((event, handler) => {
        handlers[event] = handler;
      }),
      stop: vi.fn(),
    };

    setDiscoveryConfig({
      discovery_advertise: '0',
    });
    mockLocalNetwork();
    stubDiscoveryHttp();

    loadedDiscovery = loadDiscoveryWithBonjour({
      publish: vi.fn(),
      find: vi.fn(() => mockBrowser),
      destroy: vi.fn(),
    });

    const result = loadedDiscovery.initDiscovery();

    expect(result).toEqual({ success: true });
    expect(typeof handlers.up).toBe('function');

    handlers.up({
      name: 'labbox-ollama',
      host: '10.0.0.20',
      port: 11434,
      txt: {
        id: 'labbox',
        name: 'Labbox Ollama',
        url: 'http://10.0.0.20:11434',
      },
    });

    handlers.up({
      name: 'labbox-ollama',
      host: '10.0.0.20',
      port: 22434,
      txt: {
        id: 'labbox',
        name: 'Labbox Ollama',
        url: 'http://10.0.0.20:22434',
      },
    });

    const hosts = hostManagement.listOllamaHosts()
      .slice()
      .sort((left, right) => left.url.localeCompare(right.url));

    expect(hosts).toHaveLength(0);
    expect(hosts).toEqual([]);
  });
});
