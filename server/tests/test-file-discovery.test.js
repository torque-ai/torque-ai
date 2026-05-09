const fs = require('fs');
const path = require('path');

const TEST_DECLARATION_RE = /^\s*(?:describe|it)(?:\.\w+)?\s*\(/m;

function walkJsFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      files.push(...walkJsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }

  return files;
}

describe('test file discovery', () => {
  it('does not leave describe/it files outside Vitest include patterns', () => {
    const hiddenTests = walkJsFiles(__dirname)
      .filter(file => !file.endsWith('.test.js'))
      .filter(file => TEST_DECLARATION_RE.test(fs.readFileSync(file, 'utf8')))
      .map(file => path.relative(__dirname, file).replace(/\\/g, '/'))
      .sort();

    expect(hiddenTests).toEqual([]);
  });
});
