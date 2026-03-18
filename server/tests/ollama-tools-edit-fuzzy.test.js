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
