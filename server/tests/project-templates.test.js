'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  detectProjectType,
  getTemplate,
  listTemplates,
} = require('../templates/registry');

const tempDirs = [];

function createTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-project-template-'));
  tempDirs.push(dir);
  return dir;
}

function writeFile(rootDir, relativePath, content) {
  const fullPath = path.join(rootDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('project template registry', () => {
  it('detects Node.js project from package.json', () => {
    const dir = createTempDir();
    writeFile(dir, 'package.json', JSON.stringify({ name: 'node-app' }));

    const detected = detectProjectType(dir);

    expect(detected).not.toBeNull();
    expect(detected.id).toBe('nodejs');
    expect(detected.score).toBe(1);
    expect(detected.confidence).toBe(1);
  });

  it('detects Next.js project (framework beats language)', () => {
    const dir = createTempDir();
    writeFile(dir, 'package.json', JSON.stringify({
      name: 'next-app',
      dependencies: {
        next: '^15.0.0',
        react: '^19.0.0',
      },
    }));
    writeFile(dir, 'tsconfig.json', JSON.stringify({ compilerOptions: { strict: true } }));

    const detected = detectProjectType(dir);

    expect(detected).not.toBeNull();
    expect(detected.id).toBe('nextjs');
    expect(detected.priority).toBe(110);
    expect(detected.matched_markers).toContain('package.json');
    expect(detected.matched_dependencies).toContain('next');
  });

  it('detects Python project from requirements.txt', () => {
    const dir = createTempDir();
    writeFile(dir, 'requirements.txt', 'flask==3.0.0\nrequests==2.31.0\n');

    const detected = detectProjectType(dir);

    expect(detected).not.toBeNull();
    expect(detected.id).toBe('python');
    expect(detected.matched_markers).toContain('requirements.txt');
  });

  it('detects Go project from go.mod', () => {
    const dir = createTempDir();
    writeFile(dir, 'go.mod', 'module example.com/demo\n\ngo 1.22\n');

    const detected = detectProjectType(dir);

    expect(detected).not.toBeNull();
    expect(detected.id).toBe('go');
    expect(detected.score).toBe(1);
  });

  it('returns null for unknown project type', () => {
    const dir = createTempDir();
    writeFile(dir, 'README.md', '# Empty project\n');

    expect(detectProjectType(dir)).toBeNull();
  });

  it('listTemplates returns all built-in templates', () => {
    const templates = listTemplates();
    const ids = templates.map((template) => template.id).sort();

    expect(templates).toHaveLength(10);
    expect(ids).toEqual([
      'csharp',
      'django',
      'go',
      'nextjs',
      'nodejs',
      'python',
      'react',
      'rust',
      'typescript',
      'vue',
    ]);
  });

  it('getTemplate returns specific template by id', () => {
    const template = getTemplate('typescript');

    expect(template).toEqual({
      id: 'typescript',
      markers: ['tsconfig.json'],
      priority: 60,
      agent_context: 'TypeScript project. Use strict types. Run tsc --noEmit to type-check.',
    });
  });

  it('framework priority beats language priority', () => {
    const dir = createTempDir();
    writeFile(dir, 'package.json', JSON.stringify({
      name: 'react-app',
      dependencies: {
        react: '^19.0.0',
      },
    }));
    writeFile(dir, 'tsconfig.json', JSON.stringify({ compilerOptions: { jsx: 'react-jsx' } }));

    const detected = detectProjectType(dir);

    expect(detected).not.toBeNull();
    expect(detected.id).toBe('react');
    expect(detected.priority).toBeGreaterThan(getTemplate('nodejs').priority);
    expect(detected.priority).toBeGreaterThan(getTemplate('typescript').priority);
  });
});
