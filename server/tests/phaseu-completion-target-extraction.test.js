'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  extractEditTargetPaths,
  verifyCompletedTaskArtifacts,
} = require('../factory/plan-executor');

function makeTask(rawMarkdown, completed = true) {
  return {
    task_number: 2,
    task_title: 'task',
    steps: [],
    raw_markdown: rawMarkdown,
    completed,
  };
}

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phaseu-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('Phase U: edit-target extraction', () => {
  describe('extractEditTargetPaths', () => {
    it('captures bare filename after Edit verb (the bitsy task 2 case)', () => {
      // Live bug: bitsy plan 735 task 2 says
      //   "Edit `pyproject.toml`. ... matching ... used by `.github/workflows/python-ci.yml`"
      // The reference path was being treated as the edit target. Phase U
      // should extract pyproject.toml (the actual target) and ignore the
      // reference (it's not preceded by an action verb).
      const md = `## Task 2: Add ruff settings

- [x] **Step 1: Configure**

    Edit \`pyproject.toml\`. Set a stable target-version matching the lowest Python version used by \`.github/workflows/python-ci.yml\`, and ensure the lint gate targets \`bitsy\` and \`tests\`.`;
      const targets = extractEditTargetPaths(makeTask(md));
      expect(targets).toEqual(['pyproject.toml']);
    });

    it('captures slashed paths after action verbs', () => {
      const md = 'Create `src/foo.js` with a default export.';
      expect(extractEditTargetPaths(makeTask(md))).toEqual(['src/foo.js']);
    });

    it('captures both targets when multiple verb-anchored paths exist', () => {
      const md = 'Edit `pyproject.toml` and create `src/foo.js`.';
      expect(extractEditTargetPaths(makeTask(md))).toEqual(['pyproject.toml', 'src/foo.js']);
    });

    it('rejects bracketed config keys like `[tool.ruff]`', () => {
      const md = 'Configure `[tool.ruff]` block.';
      expect(extractEditTargetPaths(makeTask(md))).toEqual([]);
    });

    it('rejects bare module names with no dot or slash', () => {
      // "Configure target-version" should not be treated as a path.
      const md = 'Configure `bitsy` package settings.';
      expect(extractEditTargetPaths(makeTask(md))).toEqual([]);
    });

    it('returns empty list when no verb precedes a backticked identifier', () => {
      // The bitsy bug-source: a path is mentioned as a reference, not after a verb.
      const md = 'The `.github/workflows/python-ci.yml` is the reference.';
      expect(extractEditTargetPaths(makeTask(md))).toEqual([]);
    });

    it('dedupes repeated targets', () => {
      const md = 'Edit `pyproject.toml`. Then update `pyproject.toml` again.';
      expect(extractEditTargetPaths(makeTask(md))).toEqual(['pyproject.toml']);
    });

    it('handles common verb forms: modify/update/configure/wire/replace', () => {
      const md = `Modify \`a.js\`. Update \`b.js\`. Configure \`c.json\`. Wire \`d.ts\`. Replace \`e.py\`.`;
      expect(extractEditTargetPaths(makeTask(md))).toEqual(['a.js', 'b.js', 'c.json', 'd.ts', 'e.py']);
    });

    it('normalizes Windows backslashes to forward slashes', () => {
      const md = 'Edit `src\\foo\\bar.js`.';
      expect(extractEditTargetPaths(makeTask(md))).toEqual(['src/foo/bar.js']);
    });
  });

  describe('verifyCompletedTaskArtifacts (Phase U integration)', () => {
    it('trusts [x] when the bare filename target exists (bitsy bug fix)', () => withTmpDir((dir) => {
      // Reproduce the exact bitsy plan 735 task 2 scenario.
      fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[tool.ruff]\n');
      // Note: .github/workflows/python-ci.yml does NOT exist (the source bug).
      const md = `## Task 2

- [x] **Step 1**

    Edit \`pyproject.toml\`. Use the version from \`.github/workflows/python-ci.yml\`.`;
      const result = verifyCompletedTaskArtifacts(makeTask(md), dir);
      expect(result.trust).toBe(true);
      expect(result.reason).toBe('all_artifacts_present');
      expect(result.extractor).toBe('edit_target');
    }));

    it('mistrusts [x] when the actual edit target is missing', () => withTmpDir((dir) => {
      const md = 'Edit `pyproject.toml`.';
      // pyproject.toml deliberately not created
      const result = verifyCompletedTaskArtifacts(makeTask(md), dir);
      expect(result.trust).toBe(false);
      expect(result.reason).toBe('no_artifacts_present');
      expect(result.missing).toEqual(['pyproject.toml']);
    }));

    it('falls back to slash-path extractor when no verb-anchored target exists', () => withTmpDir((dir) => {
      // Plans that just list paths without "Edit X" framing should still
      // get the legacy verification.
      fs.writeFileSync(path.join(dir, 'a.js'), '');
      const md = 'Files: `src/a.js` and `src/b.js`.';
      // mkdir to make src/a.js path resolve correctly
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src/a.js'), '');
      const result = verifyCompletedTaskArtifacts(makeTask(md), dir);
      expect(result.extractor).toBe('slash_path_fallback');
    }));

    it('returns no_extractable_paths trust=true when nothing extractable', () => withTmpDir((dir) => {
      const md = 'Just some prose. No paths here.';
      const result = verifyCompletedTaskArtifacts(makeTask(md), dir);
      expect(result.trust).toBe(true);
      expect(result.reason).toBe('no_extractable_paths');
    }));

    it('returns trust=true when working_directory is missing', () => {
      const md = 'Edit `pyproject.toml`.';
      const result = verifyCompletedTaskArtifacts(makeTask(md), null);
      expect(result.trust).toBe(true);
      expect(result.reason).toBe('no_working_directory');
    });

    it('partial_artifacts_present when one of multiple targets exists', () => withTmpDir((dir) => {
      fs.writeFileSync(path.join(dir, 'a.js'), '');
      const md = 'Edit `a.js`. Create `b.js`.';
      const result = verifyCompletedTaskArtifacts(makeTask(md), dir);
      expect(result.trust).toBe(true);
      expect(result.reason).toBe('partial_artifacts_present');
      expect(result.missing).toEqual(['b.js']);
    }));
  });
});
