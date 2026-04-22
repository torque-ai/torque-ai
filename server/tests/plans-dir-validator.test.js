'use strict';

const path = require('path');
const { validatePlansDir } = require('../factory/plans-dir-validator');

describe('plans_dir validator', () => {
  it('accepts the project plans intake directory', () => {
    const projectPath = path.resolve('C:/repo/app');
    const plansDir = path.join(projectPath, 'docs', 'superpowers', 'plans');

    expect(validatePlansDir({ projectPath, plansDir })).toBe(path.resolve(plansDir));
  });

  it('rejects the auto-generated output directory', () => {
    const projectPath = path.resolve('C:/repo/app');
    const plansDir = path.join(projectPath, 'docs', 'superpowers', 'plans', 'auto-generated');

    expect(() => validatePlansDir({ projectPath, plansDir }))
      .toThrow(/auto-generated/);
  });

  it('rejects a plans directory outside the project', () => {
    const projectPath = path.resolve('C:/repo/app');
    const plansDir = path.resolve('C:/repo/other/plans');

    expect(() => validatePlansDir({ projectPath, plansDir }))
      .toThrow(/inside project path/);
  });
});
