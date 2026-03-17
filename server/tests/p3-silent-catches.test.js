const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

function walkAst(node, onNode) {
  if (!node || typeof node !== 'object') return;
  onNode(node);

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object' && item.type) {
          walkAst(item, onNode);
        }
      }
    } else if (value && typeof value === 'object' && value.type) {
      walkAst(value, onNode);
    }
  }
}

// Intentional empty catches in handler files (crypto fallthrough, config defaults)
const ALLOWED_SILENT_CATCHES = new Set([
  'provider-crud-handlers.js:629',
  'provider-crud-handlers.js:663',
  'provider-crud-handlers.js:667',
  'provider-crud-handlers.js:688',
  'provider-crud-handlers.js:717',
  'provider-crud-handlers.js:721',
  'orchestrator-handlers.js:12',
  'orchestrator-handlers.js:31',
  'strategic-config-handlers.js:23',
]);

describe('p3-silent-catches', () => {
  it('no handler catch blocks should be empty', () => {
    const handlerDir = path.join(__dirname, '..', 'handlers');
    const handlerFiles = fs.readdirSync(handlerDir).filter((file) => file.endsWith('.js')).sort();

    const silentCatches = [];

    for (const file of handlerFiles) {
      const filePath = path.join(handlerDir, file);
      const source = fs.readFileSync(filePath, 'utf8');
      const ast = acorn.parse(source, {
        ecmaVersion: 'latest',
        sourceType: 'module',
        locations: true
      });

      walkAst(ast, (node) => {
        if (node.type === 'TryStatement' && node.handler && node.handler.body.body.length === 0) {
          const loc = `${file}:${node.handler.body.loc.start.line}`;
          if (!ALLOWED_SILENT_CATCHES.has(loc)) {
            silentCatches.push(loc);
          }
        }
      });
    }

    expect(silentCatches).toEqual([]);
  });
});
