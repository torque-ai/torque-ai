'use strict';

const fs = require('node:fs');
const path = require('node:path');

const HANDLER_PATH = path.resolve(__dirname, '../plugins/remote-agents/handlers.js');

const INTENTIONAL_PUBLIC_API = new Set([]);

function listJsFiles(dir, files = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      continue;
    }

    const resolved = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'coverage') {
        continue;
      }
      listJsFiles(resolved, files);
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(resolved);
    }
  }

  return files;
}

function getNamedImportedExports() {
  const imported = new Set();
  const importFromStatements = [
    /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\((['"])([^'"]*remote-agents\/handlers[^'"]*)\2\)/gms,
    /import\s*\{([^}]+)\}\s+from\s+(['"])([^'"]*remote-agents\/handlers[^'"]*)\2/gms,
  ];
  const files = listJsFiles(path.resolve(__dirname, '..'))
    .filter(file => path.resolve(file) !== HANDLER_PATH);

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes('remote-agents/handlers')) {
      continue;
    }

    for (const regex of importFromStatements) {
      let match;
      while ((match = regex.exec(text)) !== null) {
        const spec = match[1];
        const names = spec.split(',').map(part => part.trim()).filter(Boolean);
        for (const name of names) {
          imported.add(name.split(/\s+as\s+/i)[0]);
        }
      }
    }
  }

  return imported;
}

describe('remote-agent-handlers export health', () => {
  it('exports are either imported elsewhere or intentionally documented public API', () => {
    const exported = Object.keys(require(HANDLER_PATH)).sort();
    const imported = getNamedImportedExports();
    const undocumented = exported.filter(name => !imported.has(name) && !INTENTIONAL_PUBLIC_API.has(name));

    expect(undocumented).toEqual([]);
  });
});
