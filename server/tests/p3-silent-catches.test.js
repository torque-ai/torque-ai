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
  'provider-crud-handlers.js:619',
  'provider-crud-handlers.js:653',
  'provider-crud-handlers.js:657',
  'provider-crud-handlers.js:678',
  'provider-crud-handlers.js:707',
  'provider-crud-handlers.js:711',
  'orchestrator-handlers.js:12',
  'orchestrator-handlers.js:31',
  'strategic-config-handlers.js:25',
  'context-handler.js:99',
  'context-handler.js:120',
  'context-handler.js:333',
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
