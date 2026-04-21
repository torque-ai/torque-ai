'use strict';

const path = require('path');
const { validatePlansDir } = require('../factory/plans-dir-validator');

describe('validatePlansDir', () => {
  const projectPath = path.join(path.sep === '\\' ? 'C:\\tmp' : '/tmp', 'sample-project');

  it('rejects the auto-generated output directory', () => {
    const result = validatePlansDir({
      projectPath,
      plansDir: path.join(projectPath, 'docs', 'superpowers', 'plans', 'auto-generated'),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/auto-generated/i);
  });

  it('rejects a nested path under auto-generated', () => {
    const result = validatePlansDir({
      projectPath,
      plansDir: path.join(projectPath, 'docs', 'superpowers', 'plans', 'auto-generated', 'sub'),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/auto-generated/i);
  });

  it('rejects paths that are not inside the project', () => {
    const outside = path.join(path.sep === '\\' ? 'C:\\tmp' : '/tmp', 'other-project', 'docs', 'plans');
    const result = validatePlansDir({
      projectPath,
      plansDir: outside,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/outside project/i);
  });

  it('accepts a safe backlog directory inside the project', () => {
    const result = validatePlansDir({
      projectPath,
      plansDir: path.join(projectPath, 'docs', 'superpowers', 'plans', 'backlog'),
    });
    expect(result.ok).toBe(true);
  });

  it('rejects empty / non-string plansDir', () => {
    expect(validatePlansDir({ projectPath, plansDir: '' }).ok).toBe(false);
    expect(validatePlansDir({ projectPath, plansDir: null }).ok).toBe(false);
    expect(validatePlansDir({ projectPath, plansDir: 5 }).ok).toBe(false);
  });
});
