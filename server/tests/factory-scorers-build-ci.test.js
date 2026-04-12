'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { score } = require('../factory/scorers/build-ci');

describe('build-ci scorer', () => {
  let tempDir;

  function writeFile(relativePath, content = '') {
    const filePath = path.join(tempDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }

  function createHighScoreFixture() {
    writeFile('.github/workflows/ci.yml');
    writeFile('.github/workflows/release.yml');
    writeFile(
      'package.json',
      JSON.stringify({
        scripts: {
          build: 'x',
          test: 'x',
          lint: 'x',
          typecheck: 'x',
        },
      }),
    );
    writeFile('.eslintrc.json', '{}');
    writeFile('.husky/pre-commit');
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorer-buildci-'));
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test('high-score path: full CI/build/lint/hooks wiring', () => {
    createHighScoreFixture();

    const result = score(tempDir, {}, null);

    expect(result.score).toBeGreaterThanOrEqual(90);
    expect(result.details.source).toBe('build_ci_signals');
    expect(result.details.ciWorkflowCount).toBe(2);
    expect(result.details.hasBuild).toBe(true);
    expect(result.details.hasTest).toBe(true);
    expect(result.details.hasLint).toBe(true);
    expect(result.details.hasTypecheck).toBe(true);
    expect(result.details.hasLintConfig).toBe(true);
    expect(result.details.hasPreCommit).toBe(true);
  });

  test('low-score path: empty project', () => {
    const result = score(tempDir, {}, null);
    const findingTitles = result.findings.map((finding) => finding.title);

    expect(result.score).toBeLessThanOrEqual(5);
    expect(result.findings.length).toBeGreaterThanOrEqual(4);
    expect(findingTitles).toEqual(expect.arrayContaining([
      'No CI configuration detected',
      'No test script in any package.json',
      'No ESLint config detected',
      'No pre-commit hooks detected (.husky or .git/hooks/pre-commit)',
    ]));
  });

  test('partial: only CI configured', () => {
    writeFile('.github/workflows/build.yml');

    const result = score(tempDir, {}, null);

    expect(result.score).toBeGreaterThanOrEqual(15);
    expect(result.score).toBeLessThanOrEqual(30);
    expect(result.details.ciWorkflowCount).toBe(1);
  });

  test('edge case: missing projectPath', () => {
    const nullResult = score(null, {}, null);
    const emptyResult = score('', {}, null);

    for (const result of [nullResult, emptyResult]) {
      expect(result.score).toBe(50);
      expect(result.details.reason).toBe('no_project_path');
    }
  });

  test('package.json in subdirectory: server/package.json scripts counted', () => {
    writeFile(
      'server/package.json',
      JSON.stringify({
        scripts: {
          test: 'x',
        },
      }),
    );

    const result = score(tempDir, {}, null);

    expect(result.details.hasTest).toBe(true);
  });

  test('clamp: score stays in [0,100]', () => {
    createHighScoreFixture();

    const result = score(tempDir, {}, null);

    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });
});
