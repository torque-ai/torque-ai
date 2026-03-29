'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createTemplateRegistry } = require('../templates/registry');
const { createProjectDetector } = require('../templates/detector');

describe('project template registry', () => {
  it('loadTemplates loads all 13 templates', () => {
    const registry = createTemplateRegistry();
    const templates = registry.loadTemplates();

    expect(templates.size).toBe(13);
  });

  it('getTemplate("nextjs") returns template with inherited nodejs fields', () => {
    const registry = createTemplateRegistry();
    const nextjs = registry.getTemplate('nextjs');
    const nodejs = registry.getTemplate('nodejs');

    expect(nextjs).not.toBeNull();
    expect(nodejs).not.toBeNull();
    expect(nextjs.id).toBe('nextjs');
    expect(nextjs.category).toBe('framework');
    expect(nextjs.priority).toBe(110);
    expect(nextjs.extends).toBe('nodejs');
    expect(nextjs.verify_command_suggestion).toBe('npx next build');
    expect(nextjs.detection.files).toEqual(expect.arrayContaining(nodejs.detection.files));
    expect(nextjs.detection.dependencies).toEqual(
      expect.arrayContaining([{ file: 'package.json', key: 'next' }]),
    );
  });

  it('getAllTemplates returns templates sorted by priority desc', () => {
    const registry = createTemplateRegistry();
    const all = registry.getAllTemplates();

    expect(all).toHaveLength(13);
    for (let i = 0; i < all.length - 1; i += 1) {
      expect(all[i].priority).toBeGreaterThanOrEqual(all[i + 1].priority);
    }
  });

  it('extends merges parent and child agent_context', () => {
    const registry = createTemplateRegistry();
    const nextjs = registry.getTemplate('nextjs');
    const nodejs = registry.getTemplate('nodejs');

    expect(nextjs.agent_context.startsWith(nodejs.agent_context)).toBe(true);
    expect(nextjs.agent_context).toContain('\n\n');
  });

  it('unknown template returns null', () => {
    const registry = createTemplateRegistry();
    const template = registry.getTemplate('non-existent-template');

    expect(template).toBeNull();
  });
});

describe('project template detector', () => {
  let tempDirs = [];

  function createTempDir() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-template-detector-'));
    tempDirs.push(tempDir);
    return tempDir;
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  it('detectProjectType finds nodejs project (package.json exists)', () => {
    const registry = createTemplateRegistry();
    const detector = createProjectDetector({ templateRegistry: registry });
    const workingDir = createTempDir();
    fs.writeFileSync(path.join(workingDir, 'package.json'), '{}', 'utf8');

    const result = detector.detectProjectType(workingDir);

    expect(result).not.toBeNull();
    expect(result.template.id).toBe('nodejs');
  });

  it('detectProjectType finds nextjs project (package.json with next dependency)', () => {
    const registry = createTemplateRegistry();
    const detector = createProjectDetector({ templateRegistry: registry });
    const workingDir = createTempDir();
    fs.writeFileSync(
      path.join(workingDir, 'package.json'),
      JSON.stringify({ dependencies: { next: '^14.0.0' } }),
      'utf8',
    );

    const result = detector.detectProjectType(workingDir);

    expect(result).not.toBeNull();
    expect(result.template.id).toBe('nextjs');
  });

  it('detectProjectType finds python project (requirements.txt exists)', () => {
    const registry = createTemplateRegistry();
    const detector = createProjectDetector({ templateRegistry: registry });
    const workingDir = createTempDir();
    fs.writeFileSync(path.join(workingDir, 'requirements.txt'), 'Django==5.0.3', 'utf8');

    const result = detector.detectProjectType(workingDir);

    expect(result).not.toBeNull();
    expect(result.template.id).toBe('python');
  });

  it('priority resolution: framework template (nextjs) beats language template (nodejs)', () => {
    const registry = createTemplateRegistry();
    const detector = createProjectDetector({ templateRegistry: registry });
    const workingDir = createTempDir();
    fs.writeFileSync(
      path.join(workingDir, 'package.json'),
      JSON.stringify({ dependencies: { next: '^14.0.0', react: '^18.0.0' } }),
      'utf8',
    );

    const result = detector.detectProjectType(workingDir);

    expect(result).not.toBeNull();
    expect(result.template.id).toBe('nextjs');
    expect(result.template.priority).toBe(110);
    expect(result.score).toBeGreaterThan(50);
  });

  it('detectDependency finds key in package.json dependencies', () => {
    const registry = createTemplateRegistry();
    const detector = createProjectDetector({ templateRegistry: registry });
    const workingDir = createTempDir();
    const packageJson = path.join(workingDir, 'package.json');
    fs.writeFileSync(
      packageJson,
      JSON.stringify({ dependencies: { react: '^19.0.0' } }),
      'utf8',
    );

    const found = detector.detectDependency(packageJson, 'react');

    expect(found).toBe(true);
  });

  it('detectDependency finds key in requirements.txt', () => {
    const registry = createTemplateRegistry();
    const detector = createProjectDetector({ templateRegistry: registry });
    const workingDir = createTempDir();
    const requirements = path.join(workingDir, 'requirements.txt');
    fs.writeFileSync(requirements, 'Flask==3.0.0', 'utf8');

    const found = detector.detectDependency(requirements, 'flask');

    expect(found).toBe(true);
  });

  it('detectProjectType returns null for empty directory', () => {
    const registry = createTemplateRegistry();
    const detector = createProjectDetector({ templateRegistry: registry });
    const workingDir = createTempDir();

    const result = detector.detectProjectType(workingDir);

    expect(result).toBeNull();
  });
});
