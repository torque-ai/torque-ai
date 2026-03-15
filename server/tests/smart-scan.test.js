// vitest globals (describe, it, expect, beforeEach, afterEach, vi) provided by globals: true
const fs = require('fs');
const os = require('os');
const path = require('path');

let testDir;

function tmpFile(relPath, content) {
  const abs = path.join(testDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

beforeEach(() => {
  testDir = path.join(os.tmpdir(), `torque-smart-scan-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  if (testDir && fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

describe('parseImports', () => {
  let parseImports;

  beforeEach(() => {
    ({ parseImports } = require('../utils/smart-scan'));
  });

  it('extracts ES module named imports', () => {
    const depFile = tmpFile('src/utils.js', 'export function foo() {}');
    const mainFile = tmpFile('src/main.js', "import { foo } from './utils';\nconsole.log(foo());");

    const imports = parseImports(mainFile);
    expect(imports).toContain(depFile);
  });

  it('extracts ES module default imports', () => {
    const depFile = tmpFile('src/config.js', 'export default {}');
    const mainFile = tmpFile('src/app.js', "import config from './config';\n");

    const imports = parseImports(mainFile);
    expect(imports).toContain(depFile);
  });

  it('extracts ES module namespace imports', () => {
    const depFile = tmpFile('lib/helpers.ts', 'export const x = 1;');
    const mainFile = tmpFile('lib/index.ts', "import * as helpers from './helpers';\n");

    const imports = parseImports(mainFile);
    expect(imports).toContain(depFile);
  });

  it('extracts CommonJS require calls', () => {
    const depFile = tmpFile('src/alpha.js', 'module.exports = 1;');
    const mainFile = tmpFile('src/beta.js', "const a = require('./alpha');\n");

    const imports = parseImports(mainFile);
    expect(imports).toContain(depFile);
  });

  it('extracts destructured require calls', () => {
    const depFile = tmpFile('src/math.js', 'module.exports = { add: (a,b) => a+b };');
    const mainFile = tmpFile('src/calc.js', "const { add } = require('./math');\n");

    const imports = parseImports(mainFile);
    expect(imports).toContain(depFile);
  });

  it('extracts dynamic import() calls', () => {
    const depFile = tmpFile('src/dynamic.js', 'export const x = 1;');
    const mainFile = tmpFile('src/loader.js', "const mod = await import('./dynamic.js');\n");

    const imports = parseImports(mainFile);
    expect(imports).toContain(depFile);
  });

  it('skips bare specifiers (node_modules / builtins)', () => {
    tmpFile('src/app.js', '');
    const mainFile = tmpFile('src/index.js', [
      "import express from 'express';",
      "const fs = require('fs');",
      "const path = require('path');",
      "import React from 'react';",
      "import('./src/app.js');",
    ].join('\n'));

    const imports = parseImports(mainFile);
    // Should not include bare specifiers
    for (const imp of imports) {
      expect(imp).not.toMatch(/node_modules/);
      expect(path.isAbsolute(imp)).toBe(true);
    }
    // None of the bare specifiers should resolve
    expect(imports.length).toBeLessThanOrEqual(1); // only ./src/app.js might resolve
  });

  it('resolves extensionless imports by trying .js, .ts, .jsx, .tsx', () => {
    const depFile = tmpFile('src/widget.tsx', 'export default function Widget() {}');
    const mainFile = tmpFile('src/app.tsx', "import Widget from './widget';\n");

    const imports = parseImports(mainFile);
    expect(imports).toContain(depFile);
  });

  it('resolves .ts extension for extensionless imports', () => {
    const depFile = tmpFile('src/types.ts', 'export type Foo = string;');
    const mainFile = tmpFile('src/consumer.ts', "import { Foo } from './types';\n");

    const imports = parseImports(mainFile);
    expect(imports).toContain(depFile);
  });

  it('resolves .jsx extension for extensionless imports', () => {
    const depFile = tmpFile('components/Button.jsx', 'export default function Button() {}');
    const mainFile = tmpFile('components/Form.jsx', "import Button from './Button';\n");

    const imports = parseImports(mainFile);
    expect(imports).toContain(depFile);
  });

  it('resolves index files in directories', () => {
    const indexFile = tmpFile('src/utils/index.js', 'module.exports = {};');
    const mainFile = tmpFile('src/main.js', "const utils = require('./utils');\n");

    const imports = parseImports(mainFile);
    expect(imports).toContain(indexFile);
  });

  it('resolves index.ts in directories', () => {
    const indexFile = tmpFile('src/lib/index.ts', 'export const x = 1;');
    const mainFile = tmpFile('src/entry.ts', "import { x } from './lib';\n");

    const imports = parseImports(mainFile);
    expect(imports).toContain(indexFile);
  });

  it('skips imports that resolve to nonexistent files', () => {
    const mainFile = tmpFile('src/orphan.js', [
      "import { ghost } from './nonexistent';",
      "const missing = require('./also-missing');",
    ].join('\n'));

    const imports = parseImports(mainFile);
    expect(imports).toEqual([]);
  });

  it('deduplicates imports to the same file', () => {
    const depFile = tmpFile('src/shared.js', 'module.exports = {};');
    const mainFile = tmpFile('src/consumer.js', [
      "import shared from './shared';",
      "const alsoShared = require('./shared');",
      "const again = require('./shared.js');",
    ].join('\n'));

    const imports = parseImports(mainFile);
    // Each resolved path should appear only once
    const unique = new Set(imports);
    expect(unique.size).toBe(imports.length);
    expect(imports).toContain(depFile);
  });

  it('handles relative parent imports (../)', () => {
    const depFile = tmpFile('shared/constants.js', 'module.exports = {};');
    const mainFile = tmpFile('src/deep/nested.js', "const c = require('../../shared/constants');\n");

    const imports = parseImports(mainFile);
    expect(imports).toContain(depFile);
  });

  it('handles imports with explicit extensions', () => {
    const depFile = tmpFile('src/data.json', '{}');
    // .json isn't in RESOLVE_EXTENSIONS, but exact path should work
    // Actually this tests that explicit extension works
    const jsFile = tmpFile('src/helper.js', 'module.exports = 1;');
    const mainFile = tmpFile('src/main.js', "const h = require('./helper.js');\n");

    const imports = parseImports(mainFile);
    expect(imports).toContain(jsFile);
  });

  it('handles multiple imports in a single file', () => {
    const fileA = tmpFile('src/a.js', 'module.exports = 1;');
    const fileB = tmpFile('src/b.ts', 'export const b = 2;');
    const fileC = tmpFile('src/c.jsx', 'export default function C() {}');
    const mainFile = tmpFile('src/main.js', [
      "const a = require('./a');",
      "import { b } from './b';",
      "import C from './c';",
    ].join('\n'));

    const imports = parseImports(mainFile);
    expect(imports).toContain(fileA);
    expect(imports).toContain(fileB);
    expect(imports).toContain(fileC);
    expect(imports).toHaveLength(3);
  });

  it('returns empty array for a file with no imports', () => {
    const mainFile = tmpFile('src/standalone.js', 'console.log("hello world");\n');

    const imports = parseImports(mainFile);
    expect(imports).toEqual([]);
  });

  it('returns empty array for nonexistent source file', () => {
    const fakePath = path.join(testDir, 'does-not-exist.js');

    const imports = parseImports(fakePath);
    expect(imports).toEqual([]);
  });

  it('handles re-exports', () => {
    const depFile = tmpFile('src/internal.js', 'export const x = 1;');
    const mainFile = tmpFile('src/barrel.js', "export { x } from './internal';\n");

    const imports = parseImports(mainFile);
    expect(imports).toContain(depFile);
  });

  it('handles side-effect imports', () => {
    const depFile = tmpFile('src/polyfill.js', '// side effects');
    const mainFile = tmpFile('src/entry.js', "import './polyfill';\n");

    const imports = parseImports(mainFile);
    expect(imports).toContain(depFile);
  });
});

describe('isRelativeImport', () => {
  let isRelativeImport;

  beforeEach(() => {
    ({ isRelativeImport } = require('../utils/smart-scan'));
  });

  it('returns true for ./ prefixed paths', () => {
    expect(isRelativeImport('./utils')).toBe(true);
    expect(isRelativeImport('./deep/nested/file')).toBe(true);
  });

  it('returns true for ../ prefixed paths', () => {
    expect(isRelativeImport('../shared')).toBe(true);
    expect(isRelativeImport('../../root')).toBe(true);
  });

  it('returns false for bare specifiers', () => {
    expect(isRelativeImport('express')).toBe(false);
    expect(isRelativeImport('fs')).toBe(false);
    expect(isRelativeImport('@scope/package')).toBe(false);
    expect(isRelativeImport('react')).toBe(false);
  });
});

describe('resolveImportPath', () => {
  let resolveImportPath;

  beforeEach(() => {
    ({ resolveImportPath } = require('../utils/smart-scan'));
  });

  it('resolves exact file path', () => {
    const target = tmpFile('src/exact.js', '// content');
    const result = resolveImportPath('./exact.js', path.join(testDir, 'src'));
    expect(result).toBe(target);
  });

  it('resolves extensionless to .js', () => {
    const target = tmpFile('src/mod.js', '// content');
    const result = resolveImportPath('./mod', path.join(testDir, 'src'));
    expect(result).toBe(target);
  });

  it('resolves extensionless to .ts', () => {
    const target = tmpFile('src/mod.ts', '// content');
    const result = resolveImportPath('./mod', path.join(testDir, 'src'));
    expect(result).toBe(target);
  });

  it('resolves extensionless to .tsx', () => {
    const target = tmpFile('src/Component.tsx', '// content');
    const result = resolveImportPath('./Component', path.join(testDir, 'src'));
    expect(result).toBe(target);
  });

  it('resolves directory with index.js', () => {
    const target = tmpFile('src/lib/index.js', '// content');
    const result = resolveImportPath('./lib', path.join(testDir, 'src'));
    expect(result).toBe(target);
  });

  it('resolves directory with index.ts', () => {
    const target = tmpFile('src/lib/index.ts', '// content');
    const result = resolveImportPath('./lib', path.join(testDir, 'src'));
    expect(result).toBe(target);
  });

  it('returns null for unresolvable import', () => {
    const result = resolveImportPath('./nonexistent', path.join(testDir, 'src'));
    expect(result).toBeNull();
  });

  it('prefers .js over .ts when both exist', () => {
    const jsFile = tmpFile('src/both.js', '// js');
    tmpFile('src/both.ts', '// ts');
    const result = resolveImportPath('./both', path.join(testDir, 'src'));
    expect(result).toBe(jsFile);
  });
});

describe('IMPORT_PATTERNS', () => {
  let IMPORT_PATTERNS;

  beforeEach(() => {
    ({ IMPORT_PATTERNS } = require('../utils/smart-scan'));
  });

  it('exports an array of regex patterns', () => {
    expect(Array.isArray(IMPORT_PATTERNS)).toBe(true);
    expect(IMPORT_PATTERNS.length).toBe(3);
    for (const p of IMPORT_PATTERNS) {
      expect(p).toBeInstanceOf(RegExp);
    }
  });
});

describe('RESOLVE_EXTENSIONS', () => {
  let RESOLVE_EXTENSIONS;

  beforeEach(() => {
    ({ RESOLVE_EXTENSIONS } = require('../utils/smart-scan'));
  });

  it('includes standard JS/TS extensions', () => {
    expect(RESOLVE_EXTENSIONS).toContain('.js');
    expect(RESOLVE_EXTENSIONS).toContain('.ts');
    expect(RESOLVE_EXTENSIONS).toContain('.jsx');
    expect(RESOLVE_EXTENSIONS).toContain('.tsx');
    expect(RESOLVE_EXTENSIONS).toContain('.mjs');
    expect(RESOLVE_EXTENSIONS).toContain('.cjs');
  });
});

// ──────────────────────────────────────────────────────────────
// Task 2 — Convention Matching
// ──────────────────────────────────────────────────────────────

describe('findConventionMatches', () => {
  let findConventionMatches, DEFAULT_CONVENTION_PATTERNS;

  beforeEach(() => {
    ({ findConventionMatches, DEFAULT_CONVENTION_PATTERNS } = require('../utils/smart-scan'));
  });

  it('source file finds its .test.js file', () => {
    const src = tmpFile('src/foo.js', '// source');
    const test = tmpFile('src/foo.test.js', '// test');

    const matches = findConventionMatches(src);
    expect(matches).toContain(test);
  });

  it('source file finds its .test.ts file', () => {
    const src = tmpFile('src/bar.ts', '// source');
    const test = tmpFile('src/bar.test.ts', '// test');

    const matches = findConventionMatches(src);
    expect(matches).toContain(test);
  });

  it('test file finds its source file (reverse)', () => {
    const src = tmpFile('src/foo.js', '// source');
    const test = tmpFile('src/foo.test.js', '// test');

    const matches = findConventionMatches(test);
    expect(matches).toContain(src);
  });

  it('source file finds its .spec.js file', () => {
    const src = tmpFile('src/baz.js', '// source');
    const spec = tmpFile('src/baz.spec.js', '// spec');

    const matches = findConventionMatches(src);
    expect(matches).toContain(spec);
  });

  it('spec file finds its source file', () => {
    const src = tmpFile('src/baz.js', '// source');
    const spec = tmpFile('src/baz.spec.js', '// spec');

    const matches = findConventionMatches(spec);
    expect(matches).toContain(src);
  });

  it('System file finds types.ts and constants.ts in same directory', () => {
    const sys = tmpFile('src/systems/FooSystem.ts', '// system');
    const types = tmpFile('src/systems/types.ts', '// types');
    const constants = tmpFile('src/systems/constants.ts', '// constants');

    const matches = findConventionMatches(sys);
    expect(matches).toContain(types);
    expect(matches).toContain(constants);
  });

  it('returns empty for files with no convention matches on disk', () => {
    const src = tmpFile('src/lonely.js', '// no test or spec exists');

    const matches = findConventionMatches(src);
    expect(matches).toEqual([]);
  });

  it('test file does NOT also match as source (guard prevents .test.test.js)', () => {
    const test = tmpFile('src/widget.test.js', '// test');
    // No widget.test.test.js exists — guard should prevent the source→test rule from firing

    const matches = findConventionMatches(test);
    // Should only look for widget.js (the reverse rule), which doesn't exist
    expect(matches).toEqual([]);
  });

  it('source file finds both .test.js and .spec.js when both exist', () => {
    const src = tmpFile('src/dual.js', '// source');
    const test = tmpFile('src/dual.test.js', '// test');
    const spec = tmpFile('src/dual.spec.js', '// spec');

    const matches = findConventionMatches(src);
    expect(matches).toContain(test);
    expect(matches).toContain(spec);
    expect(matches).toHaveLength(2);
  });

  it('accepts custom convention patterns', () => {
    const src = tmpFile('src/thing.js', '// source');
    const doc = tmpFile('src/thing.md', '# docs');

    const customPatterns = [
      {
        match: /^(.+)\.(js|ts)$/,
        generate: (basename, dir) => {
          const m = basename.match(/^(.+)\.(js|ts)$/);
          return [path.join(dir, `${m[1]}.md`)];
        },
      },
    ];

    const matches = findConventionMatches(src, customPatterns);
    expect(matches).toContain(doc);
  });

  it('exports DEFAULT_CONVENTION_PATTERNS as an array', () => {
    expect(Array.isArray(DEFAULT_CONVENTION_PATTERNS)).toBe(true);
    expect(DEFAULT_CONVENTION_PATTERNS.length).toBeGreaterThan(0);
    for (const p of DEFAULT_CONVENTION_PATTERNS) {
      expect(p.match).toBeInstanceOf(RegExp);
      expect(typeof p.generate).toBe('function');
    }
  });
});

// ──────────────────────────────────────────────────────────────
// Task 3 — smartScan orchestrator
// ──────────────────────────────────────────────────────────────

describe('smartScan', () => {
  let smartScan, MAX_FILE_SIZE_BYTES;

  beforeEach(() => {
    ({ smartScan, MAX_FILE_SIZE_BYTES } = require('../utils/smart-scan'));
  });

  it('returns explicit files with reason "explicit"', () => {
    const fileA = tmpFile('src/a.js', '// content');

    const result = smartScan({ files: [fileA] });
    expect(result.contextFiles).toContain(fileA);
    expect(result.reasons.get(fileA)).toBe('explicit');
  });

  it('discovers imports at depth 1 with reason "import:filename"', () => {
    const dep = tmpFile('src/utils.js', 'module.exports = {};');
    const main = tmpFile('src/main.js', "const u = require('./utils');\n");

    const result = smartScan({ files: [main] });
    expect(result.contextFiles).toContain(dep);
    expect(result.reasons.get(dep)).toBe('import:utils.js');
  });

  it('discovers imports at depth 2 with reason "import-level-2:filename"', () => {
    const deep = tmpFile('src/deep.js', 'module.exports = 42;');
    const mid = tmpFile('src/mid.js', "const d = require('./deep');\nmodule.exports = d;");
    const top = tmpFile('src/top.js', "const m = require('./mid');\n");

    const result = smartScan({ files: [top], contextDepth: 2 });
    expect(result.contextFiles).toContain(mid);
    expect(result.contextFiles).toContain(deep);
    expect(result.reasons.get(mid)).toBe('import:mid.js');
    expect(result.reasons.get(deep)).toBe('import-level-2:deep.js');
  });

  it('does NOT discover depth-2 imports when depth is 1', () => {
    const deep = tmpFile('src/deep.js', 'module.exports = 42;');
    const mid = tmpFile('src/mid.js', "const d = require('./deep');\nmodule.exports = d;");
    const top = tmpFile('src/top.js', "const m = require('./mid');\n");

    const result = smartScan({ files: [top], contextDepth: 1 });
    expect(result.contextFiles).toContain(mid);
    expect(result.contextFiles).not.toContain(deep);
  });

  it('includes convention matches with reason "convention:filename"', () => {
    const src = tmpFile('src/widget.js', '// source');
    const test = tmpFile('src/widget.test.js', '// test');

    const result = smartScan({ files: [src] });
    expect(result.contextFiles).toContain(test);
    expect(result.reasons.get(test)).toBe('convention:widget.test.js');
  });

  it('deduplicates files (same file passed twice)', () => {
    const fileA = tmpFile('src/dup.js', '// content');

    const result = smartScan({ files: [fileA, fileA] });
    const count = result.contextFiles.filter(f => f === fileA).length;
    expect(count).toBe(1);
    expect(result.reasons.get(fileA)).toBe('explicit');
  });

  it('skips files larger than 200KB (adds to skipped array)', () => {
    const bigContent = 'x'.repeat(MAX_FILE_SIZE_BYTES + 1);
    const bigFile = tmpFile('src/huge.js', bigContent);

    const result = smartScan({ files: [bigFile] });
    expect(result.contextFiles).not.toContain(bigFile);
    expect(result.skipped).toContain(bigFile);
  });

  it('returns empty for no files', () => {
    const result = smartScan({ files: [] });
    expect(result.contextFiles).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.reasons.size).toBe(0);
  });

  it('preserves priority ordering: explicit > imports > conventions', () => {
    const dep = tmpFile('src/helper.js', 'module.exports = {};');
    const depTest = tmpFile('src/helper.test.js', '// test for helper');
    const main = tmpFile('src/main.js', "const h = require('./helper');\n");
    const mainTest = tmpFile('src/main.test.js', '// test for main');

    const result = smartScan({ files: [main] });

    const mainIdx = result.contextFiles.indexOf(main);
    const depIdx = result.contextFiles.indexOf(dep);
    const mainTestIdx = result.contextFiles.indexOf(mainTest);
    const depTestIdx = result.contextFiles.indexOf(depTest);

    // Explicit first
    expect(mainIdx).toBe(0);
    // Imports before conventions
    expect(depIdx).toBeLessThan(mainTestIdx);
    expect(depIdx).toBeLessThan(depTestIdx);
  });

  it('resolves relative paths with workingDirectory', () => {
    const fileA = tmpFile('project/src/index.js', '// content');

    const result = smartScan({
      files: ['src/index.js'],
      workingDirectory: path.join(testDir, 'project'),
    });
    expect(result.contextFiles).toContain(fileA);
    expect(result.reasons.get(fileA)).toBe('explicit');
  });

  it('exports MAX_FILE_SIZE_BYTES as a number', () => {
    expect(typeof MAX_FILE_SIZE_BYTES).toBe('number');
    expect(MAX_FILE_SIZE_BYTES).toBe(200 * 1024);
  });

  it('convention matches apply to imported files too', () => {
    const dep = tmpFile('src/service.js', 'module.exports = {};');
    const depTest = tmpFile('src/service.test.js', '// test for service');
    const main = tmpFile('src/app.js', "const s = require('./service');\n");

    const result = smartScan({ files: [main] });
    // Convention match on the imported service.js should find service.test.js
    expect(result.contextFiles).toContain(depTest);
    expect(result.reasons.get(depTest)).toBe('convention:service.test.js');
  });

  it('skips nonexistent explicit files silently', () => {
    const fakePath = path.join(testDir, 'does-not-exist.js');
    const realFile = tmpFile('src/real.js', '// real');

    const result = smartScan({ files: [fakePath, realFile] });
    expect(result.contextFiles).not.toContain(fakePath);
    expect(result.contextFiles).toContain(realFile);
  });
});
