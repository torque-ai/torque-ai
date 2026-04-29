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
  'provider-crud-handlers.js:620',
  'provider-crud-handlers.js:654',
  'provider-crud-handlers.js:658',
  'provider-crud-handlers.js:679',
  'provider-crud-handlers.js:708',
  'provider-crud-handlers.js:712',
  'orchestrator-handlers.js:10',
  'orchestrator-handlers.js:18',
  'strategic-config-handlers.js:25',
  'context-handler.js:100',
  'context-handler.js:121',
  'context-handler.js:334',
  // Factory DB fallback during direct handler construction in tests.
  'factory-handlers.js:38',
  // Governance direct-construction fallbacks — intentionally swallow container/module errors
  'automation-handlers.js:86',
  'automation-handlers.js:99',
  'automation-handlers.js:110',
  // Review handler catch — non-critical (study-telemetry fall-through)
  'review-handler.js:309',
]);

function getHandlerFiles() {
  const serverRoot = path.join(__dirname, '..');
  const coreHandlerDir = path.join(serverRoot, 'handlers');
  const coreFiles = fs.readdirSync(coreHandlerDir)
    .filter((file) => file.endsWith('.js'))
    .sort()
    .map((file) => ({ label: file, filePath: path.join(coreHandlerDir, file) }));

  return [
    ...coreFiles,
    {
      label: 'plugins/remote-agents/handlers.js',
      filePath: path.join(serverRoot, 'plugins', 'remote-agents', 'handlers.js'),
    },
  ];
}

describe('p3-silent-catches', () => {
  it('no handler catch blocks should be empty', () => {
    const silentCatches = [];

    for (const { label, filePath } of getHandlerFiles()) {
      const source = fs.readFileSync(filePath, 'utf8');
      const ast = acorn.parse(source, {
        ecmaVersion: 'latest',
        sourceType: 'module',
        locations: true
      });

      walkAst(ast, (node) => {
        if (node.type === 'TryStatement' && node.handler && node.handler.body.body.length === 0) {
          const loc = `${label}:${node.handler.body.loc.start.line}`;
          if (!ALLOWED_SILENT_CATCHES.has(loc)) {
            silentCatches.push(loc);
          }
        }
      });
    }

    expect(silentCatches).toEqual([]);
  });
});
