'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadPlanAuthoringGuide } = require('../factory/architect-runner');

describe('architect runner plan-authoring guide loading', () => {
  const tempDirs = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function createTempProject(name) {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
    tempDirs.push(projectDir);
    return projectDir;
  }

  it('returns project-owned docs/plan-authoring.md when present', () => {
    const projectDir = createTempProject('architect-guide-project');
    const projectGuidePath = path.join(projectDir, 'docs', 'plan-authoring.md');
    const projectGuide = '# Project Guide\n\nProject-specific rules.';

    fs.mkdirSync(path.dirname(projectGuidePath), { recursive: true });
    fs.writeFileSync(projectGuidePath, projectGuide);

    expect(loadPlanAuthoringGuide(projectDir)).toBe(projectGuide);
  });

  it('returns the TORQUE guide when the target project is the TORQUE repo layout', () => {
    const projectDir = createTempProject('architect-guide-torque');
    const torqueGuidePath = path.join(__dirname, '..', '..', 'docs', 'superpowers', 'plan-authoring.md');
    const torqueGuide = fs.readFileSync(torqueGuidePath, 'utf8').trim();

    fs.mkdirSync(path.join(projectDir, 'server', 'factory'), { recursive: true });

    expect(loadPlanAuthoringGuide(projectDir)).toBe(torqueGuide);
  });

  it('returns an empty string when the project has no guide and is not the TORQUE repo', () => {
    const projectDir = createTempProject('architect-guide-empty');

    expect(loadPlanAuthoringGuide(projectDir)).toBe('');
  });
});
