import { createRequire } from 'module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadSkills } = require('../providers/claude-code/skills-loader');

describe('claude-code skills loader', () => {
  const tempDirs = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  function makeWorkingDir() {
    const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-claude-skills-'));
    tempDirs.push(workingDir);
    return workingDir;
  }

  function writeSkill(workingDir, name, content) {
    const skillDir = path.join(workingDir, '.claude', 'skills', name);
    fs.mkdirSync(skillDir, { recursive: true });
    const skillPath = path.join(skillDir, 'SKILL.md');
    fs.writeFileSync(skillPath, content, 'utf8');
    return skillPath;
  }

  it('returns an empty list when the working directory has no .claude/skills tree', () => {
    const workingDir = makeWorkingDir();

    expect(loadSkills(workingDir)).toEqual([]);
  });

  it('loads skill metadata and body from SKILL.md frontmatter', () => {
    const workingDir = makeWorkingDir();
    const skillPath = writeSkill(
      workingDir,
      'reviewer',
      [
        '---',
        'name: task-reviewer',
        'description: Reviews completed task output',
        '---',
        '# Reviewer',
        '',
        'Check the output carefully.',
      ].join('\n'),
    );

    expect(loadSkills(workingDir)).toEqual([
      {
        name: 'task-reviewer',
        description: 'Reviews completed task output',
        body: '# Reviewer\n\nCheck the output carefully.',
        path: skillPath,
      },
    ]);
  });

  it('falls back to the directory name when frontmatter fields are absent', () => {
    const workingDir = makeWorkingDir();
    const skillPath = writeSkill(
      workingDir,
      'plain-skill',
      'This skill has no frontmatter.',
    );

    expect(loadSkills(workingDir)).toEqual([
      {
        name: 'plain-skill',
        description: '',
        body: 'This skill has no frontmatter.',
        path: skillPath,
      },
    ]);
  });

  it('skips malformed skill frontmatter without failing the whole load', () => {
    const workingDir = makeWorkingDir();

    writeSkill(
      workingDir,
      'broken',
      [
        '---',
        'name broken-skill',
        'description: invalid yaml line',
        '---',
        'body',
      ].join('\n'),
    );

    const validPath = writeSkill(
      workingDir,
      'valid',
      [
        '---',
        'name: valid-skill',
        'description: still loads',
        '---',
        'usable body',
      ].join('\n'),
    );

    expect(loadSkills(workingDir)).toEqual([
      {
        name: 'valid-skill',
        description: 'still loads',
        body: 'usable body',
        path: validPath,
      },
    ]);
  });
});
