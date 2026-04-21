'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { reindentNewText } = require('../providers/ollama-tools');
const { createToolExecutor } = require('../providers/ollama-tools');

function writeFile(dir, name, content) {
  const full = path.join(dir, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
  return full;
}

let tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-fuzzy-edit-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  tempDirs = [];
});

describe('reindentNewText', () => {
  it('shifts new_text from 0 indent to 4-space indent', () => {
    const result = reindentNewText('if (x) {\n  y();\n}', '    ');
    expect(result).toBe('    if (x) {\n      y();\n    }');
  });

  it('shifts new_text from 2-space to 4-space indent', () => {
    const result = reindentNewText('  if (x) {\n    y();\n  }', '    ');
    expect(result).toBe('    if (x) {\n      y();\n    }');
  });

  it('strips indent when file has less than new_text', () => {
    const result = reindentNewText('    if (x) {\n      y();\n    }', '  ');
    expect(result).toBe('  if (x) {\n    y();\n  }');
  });

  it('handles tabs in file indent, spaces in new_text', () => {
    const result = reindentNewText('  if (x) {\n    y();\n  }', '\t');
    expect(result).toBe('\tif (x) {\n\t  y();\n\t}');
  });

  it('preserves blank lines unchanged', () => {
    const result = reindentNewText('if (x) {\n\n  y();\n}', '    ');
    expect(result).toBe('    if (x) {\n\n      y();\n    }');
  });

  it('returns single-line text with file indent', () => {
    const result = reindentNewText('doThing();', '    ');
    expect(result).toBe('    doThing();');
  });

  it('no-ops when indents already match', () => {
    const result = reindentNewText('    if (x) {\n      y();\n    }', '    ');
    expect(result).toBe('    if (x) {\n      y();\n    }');
  });
});

describe('edit_file whitespace-normalized fallback', () => {
  it('matches when old_text has wrong indentation', () => {
    const dir = makeTempDir();
    writeFile(dir, 'app.js', '    if (x) {\n      doThing();\n    }');
    const { execute: exec } = createToolExecutor(dir);
    const result = exec('edit_file', {
      path: 'app.js',
      old_text: '  if (x) {\n    doThing();\n  }',
      new_text: '  if (y) {\n    doOther();\n  }',
    });
    expect(result.error).toBeFalsy();
    expect(result.result).toContain('matched with normalized whitespace');
    const written = fs.readFileSync(path.join(dir, 'app.js'), 'utf-8');
    expect(written).toBe('    if (y) {\n      doOther();\n    }');
  });

  it('rejects when normalized form matches multiple locations', () => {
    const dir = makeTempDir();
    writeFile(dir, 'dup.js', '  doThing();\n\n    doThing();');
    const { execute: exec } = createToolExecutor(dir);
    const result = exec('edit_file', {
      path: 'dup.js',
      old_text: 'doThing();',
      new_text: 'doOther();',
    });
    expect(result.error).toBe(true);
    expect(result.result).toContain('multiple');
  });

  it('exact match still preferred over whitespace fallback', () => {
    const dir = makeTempDir();
    writeFile(dir, 'exact.js', '  foo();\n    foo();');
    const { execute: exec } = createToolExecutor(dir);
    const result = exec('edit_file', {
      path: 'exact.js',
      old_text: '  foo();',
      new_text: '  bar();',
    });
    expect(result.error).toBeFalsy();
    expect(result.result).not.toContain('normalized');
    const written = fs.readFileSync(path.join(dir, 'exact.js'), 'utf-8');
    expect(written).toBe('  bar();\n    foo();');
  });

  it('handles tabs in file, spaces in old_text', () => {
    const dir = makeTempDir();
    writeFile(dir, 'tabs.js', '\tif (x) {\n\t\ty();\n\t}');
    const { execute: exec } = createToolExecutor(dir);
    const result = exec('edit_file', {
      path: 'tabs.js',
      old_text: '  if (x) {\n    y();\n  }',
      new_text: '  if (z) {\n    w();\n  }',
    });
    expect(result.error).toBeFalsy();
    expect(result.result).toContain('normalized whitespace');
    const written = fs.readFileSync(path.join(dir, 'tabs.js'), 'utf-8');
    expect(written).toBe('\tif (z) {\n\t\tw();\n\t}');
  });
});

describe('edit_file fuzzy fallback (Tier 2)', () => {
  it('matches near-miss content (variable name typo)', () => {
    const dir = makeTempDir();
    writeFile(dir, 'src.js', '    const userName = getData();\n    process(userName);');
    const { execute: exec } = createToolExecutor(dir);
    const result = exec('edit_file', {
      path: 'src.js',
      old_text: '    const username = getData();\n    process(username);',
      new_text: '    const email = getEmail();\n    process(email);',
    });
    expect(result.error).toBeFalsy();
    expect(result.result).toContain('fuzzy match');
    const written = fs.readFileSync(path.join(dir, 'src.js'), 'utf-8');
    expect(written).toBe('    const email = getEmail();\n    process(email);');
  });

  it('rejects low-similarity content (<80%)', () => {
    const dir = makeTempDir();
    writeFile(dir, 'low.js', '    completelyDifferentCode();\n    nothingAlike();');
    const { execute: exec } = createToolExecutor(dir);
    const result = exec('edit_file', {
      path: 'low.js',
      old_text: '    someRandomFunction();\n    anotherThing();',
      new_text: '    replacement();',
    });
    expect(result.error).toBe(true);
    expect(result.result).toContain('not found');
  });

  it('rejects medium-similarity content below the fuzzy threshold', () => {
    const dir = makeTempDir();
    writeFile(dir, 'medium.js', 'abcdefghijkl');
    const { execute: exec } = createToolExecutor(dir);
    const result = exec('edit_file', {
      path: 'medium.js',
      old_text: 'abcdefghiXYZ',
      new_text: 'replaced',
    });
    expect(result.error).toBe(true);
    expect(result.result).toContain('not found');
  });

  it('rejects ambiguous fuzzy matches (two similar regions)', () => {
    const dir = makeTempDir();
    writeFile(dir, 'amb.js', [
      '    const dataA = fetchData();',
      '    processA(dataA);',
      '',
      '    const dataB = fetchData();',
      '    processB(dataB);',
    ].join('\n'));
    const { execute: exec } = createToolExecutor(dir);
    const result = exec('edit_file', {
      path: 'amb.js',
      old_text: '    const dataX = fetchData();\n    processX(dataX);',
      new_text: '    replaced();',
    });
    expect(result.error).toBe(true);
  });

  it('skips fuzzy for files over 2000 lines', () => {
    const dir = makeTempDir();
    const bigFile = Array.from({ length: 2001 }, (_, i) => `line${i}();`).join('\n');
    writeFile(dir, 'big.js', bigFile);
    const { execute: exec } = createToolExecutor(dir);
    const result = exec('edit_file', {
      path: 'big.js',
      old_text: 'lineXYZ();',
      new_text: 'replaced();',
    });
    expect(result.error).toBe(true);
    expect(result.result).toContain('not found');
  });

  it('skips fuzzy for old_text over 50 lines', () => {
    const dir = makeTempDir();
    writeFile(dir, 'normal.js', 'someLine();');
    const { execute: exec } = createToolExecutor(dir);
    const bigOldText = Array.from({ length: 51 }, (_, i) => `old${i}();`).join('\n');
    const result = exec('edit_file', {
      path: 'normal.js',
      old_text: bigOldText,
      new_text: 'replaced();',
    });
    expect(result.error).toBe(true);
    expect(result.result).toContain('not found');
  });

  it('fuzzy re-indents new_text to match file region', () => {
    const dir = makeTempDir();
    writeFile(dir, 'indent.js', '      const result = compute();\n      return result;');
    const { execute: exec } = createToolExecutor(dir);
    const result = exec('edit_file', {
      path: 'indent.js',
      old_text: '  const result = compote();\n  return result;',
      new_text: '  const value = transform();\n  return value;',
    });
    expect(result.error).toBeFalsy();
    const written = fs.readFileSync(path.join(dir, 'indent.js'), 'utf-8');
    expect(written).toBe('      const value = transform();\n      return value;');
  });
});

describe('edit_file cascade (exact > whitespace > fuzzy)', () => {
  it('prefers exact over whitespace when exact matches', () => {
    const dir = makeTempDir();
    writeFile(dir, 'cascade.js', '  foo();\n    foo();');
    const { execute: exec } = createToolExecutor(dir);
    const result = exec('edit_file', {
      path: 'cascade.js',
      old_text: '  foo();',
      new_text: '  bar();',
    });
    expect(result.result).toBe('Edit applied to cascade.js');
    expect(result.result).not.toContain('normalized');
    expect(result.result).not.toContain('fuzzy');
  });

  it('prefers whitespace over fuzzy when whitespace matches', () => {
    const dir = makeTempDir();
    writeFile(dir, 'cascade2.js', '    doWork();');
    const { execute: exec } = createToolExecutor(dir);
    const result = exec('edit_file', {
      path: 'cascade2.js',
      old_text: '  doWork();',
      new_text: '  doBetter();',
    });
    expect(result.result).toContain('normalized whitespace');
    expect(result.result).not.toContain('fuzzy');
  });

  it('replace_all with whitespace fallback but no fuzzy', () => {
    const dir = makeTempDir();
    writeFile(dir, 'ra.js', '\tlog(x);');
    const { execute: exec } = createToolExecutor(dir);
    const result = exec('edit_file', {
      path: 'ra.js',
      old_text: '  log(x);',
      new_text: '  log(y);',
      replace_all: true,
    });
    expect(result.error).toBeFalsy();
    expect(result.result).toContain('1 replacement');
    expect(result.result).toContain('normalized whitespace');
  });

  it('error message suggests more context when all tiers fail', () => {
    const dir = makeTempDir();
    writeFile(dir, 'nope.js', 'completely different content');
    const { execute: exec } = createToolExecutor(dir);
    const result = exec('edit_file', {
      path: 'nope.js',
      old_text: 'this does not exist anywhere',
      new_text: 'replacement',
    });
    expect(result.error).toBe(true);
    expect(result.result).toContain('not found');
    expect(result.result).toContain('context');
  });
});
