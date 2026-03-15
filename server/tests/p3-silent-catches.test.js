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
          silentCatches.push(`${file}:${node.handler.body.loc.start.line}`);
        }
      });
    }

    expect(silentCatches).toEqual([]);
  });
});
