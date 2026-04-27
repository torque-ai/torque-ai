'use strict';

const { getParser } = require('../parser');

const FUNCTION_NODE_TYPES = new Set([
  'function_declaration',
  'method_definition',
  'class_declaration',
  'arrow_function',
  'function',
]);

function nodeName(node) {
  const nameNode = node.childForFieldName('name');
  return nameNode ? nameNode.text : '';
}

function kindFor(node) {
  switch (node.type) {
    case 'function_declaration': return 'function';
    case 'method_definition':    return 'method';
    case 'class_declaration':    return 'class';
    case 'arrow_function':       return 'function';
    case 'function':             return 'function';
    default:                     return 'unknown';
  }
}

function callTargetName(callNode) {
  const fn = callNode.childForFieldName('function');
  if (!fn) return '';
  if (fn.type === 'identifier') return fn.text;
  if (fn.type === 'member_expression') {
    const prop = fn.childForFieldName('property');
    return prop ? prop.text : '';
  }
  return '';
}

async function extractFromSource(source, language) {
  const parser = await getParser(language);
  // Native tree-sitter defaults bufferSize to 32KB and throws "Invalid argument"
  // on larger sources. Pass headroom (source length + 32KB, min 32KB) so the
  // parser fits any reasonable file. The buffer is allocated lazily — passing
  // a high cap doesn't preallocate.
  const tree = parser.parse(source, null, { bufferSize: Math.max(32 * 1024, source.length + 32 * 1024) });

  const symbols = [];
  const references = [];
  const enclosingStack = []; // indexes into `symbols`

  function walk(node) {
    let pushed = false;
    if (FUNCTION_NODE_TYPES.has(node.type)) {
      const name = nodeName(node);
      if (name) {
        symbols.push({
          name,
          kind: kindFor(node),
          startLine: node.startPosition.row + 1,
          startCol: node.startPosition.column,
          endLine:   node.endPosition.row + 1,
          endCol:    node.endPosition.column,
        });
        enclosingStack.push(symbols.length - 1);
        pushed = true;
      }
    }
    if (node.type === 'call_expression') {
      const target = callTargetName(node);
      if (target) {
        references.push({
          targetName: target,
          line: node.startPosition.row + 1,
          col:  node.startPosition.column,
          callerSymbolIndex: enclosingStack[enclosingStack.length - 1] ?? null,
        });
      }
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      walk(node.namedChild(i));
    }
    if (pushed) enclosingStack.pop();
  }

  walk(tree.rootNode);
  return { symbols, references };
}

module.exports = { extractFromSource };
