'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { reindentNewText } = require('../providers/ollama-tools');

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
