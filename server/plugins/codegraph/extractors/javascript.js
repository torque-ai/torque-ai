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

// Walk a node subtree collecting named children matching a predicate.
function findDescendants(node, predicate, out = []) {
  if (predicate(node)) out.push(node);
  for (let i = 0; i < node.namedChildCount; i++) {
    findDescendants(node.namedChild(i), predicate, out);
  }
  return out;
}

// Extract the string value from a tree-sitter string node.
// CommonJS: tree-sitter-javascript surfaces strings as `string` with `string_fragment` children.
// Trim the surrounding quotes from .text as a fallback for older grammars.
function stringLiteralValue(node) {
  if (!node) return null;
  if (node.type !== 'string') return null;
  const frag = node.namedChildren.find((c) => c.type === 'string_fragment');
  if (frag) return frag.text;
  const t = node.text;
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'" || t[0] === '`')) {
    return t.slice(1, -1);
  }
  return t;
}

// Detect ESM exports: `export function X() {}`, `export class X {}`,
// `export const X = ...`, `export default function X() {}`.
function exportedNamesFromExportStatement(node) {
  const out = [];
  // Walk children looking for function/class/lexical declarations.
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child.type === 'function_declaration' || child.type === 'class_declaration') {
      const n = nodeName(child);
      if (n) out.push(n);
    }
    if (child.type === 'lexical_declaration' || child.type === 'variable_declaration') {
      // export const X = ...
      for (let j = 0; j < child.namedChildCount; j++) {
        const decl = child.namedChild(j);
        if (decl.type === 'variable_declarator') {
          const nameNode = decl.childForFieldName('name');
          if (nameNode && nameNode.type === 'identifier') out.push(nameNode.text);
        }
      }
    }
    if (child.type === 'export_clause') {
      // export { X, Y as Z }
      for (let j = 0; j < child.namedChildCount; j++) {
        const spec = child.namedChild(j);
        if (spec.type === 'export_specifier') {
          const nameNode = spec.childForFieldName('name');
          if (nameNode) out.push(nameNode.text);
        }
      }
    }
  }
  return out;
}

// Detect CommonJS exports:
//   module.exports = { foo, bar }
//   module.exports.foo = ...
//   exports.foo = ...
function exportedNamesFromCjsAssignment(node) {
  // node is an assignment_expression
  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  if (!left || !right) return [];

  const leftText = left.text;
  // module.exports = { ... }
  if (leftText === 'module.exports' || leftText === 'exports') {
    if (right.type === 'object') {
      const out = [];
      for (let i = 0; i < right.namedChildCount; i++) {
        const prop = right.namedChild(i);
        // shorthand: `{ foo, bar }` → property_identifier
        // pair: `{ foo: bar }` → pair with key
        if (prop.type === 'shorthand_property_identifier') {
          out.push(prop.text);
        } else if (prop.type === 'pair') {
          const k = prop.childForFieldName('key');
          if (k && (k.type === 'property_identifier' || k.type === 'identifier')) {
            out.push(k.text);
          } else if (k && k.type === 'string') {
            const s = stringLiteralValue(k);
            if (s) out.push(s);
          }
        }
      }
      return out;
    }
  }
  // module.exports.X = ... | exports.X = ...
  if (left.type === 'member_expression') {
    const obj = left.childForFieldName('object');
    const prop = left.childForFieldName('property');
    if (!obj || !prop) return [];
    const objText = obj.text;
    if ((objText === 'module.exports' || objText === 'exports') && prop.type === 'property_identifier') {
      return [prop.text];
    }
  }
  return [];
}

// Detect dispatcher patterns:
//   switch (x) { case 'foo': return handleFoo(args); ... }
//   switch (x) { case 'foo': handleFoo(args); break; ... }
// Returns [{caseString, handlerName, line, col}, ...]
function extractDispatchEdgesFromSwitch(switchStatementNode) {
  const out = [];
  const body = switchStatementNode.childForFieldName('body');
  if (!body) return out;

  for (let i = 0; i < body.namedChildCount; i++) {
    const switchCase = body.namedChild(i);
    if (switchCase.type !== 'switch_case') continue;

    // First named child of switch_case is the case value (possibly a string literal).
    const valueNode = switchCase.namedChild(0);
    const caseString = stringLiteralValue(valueNode);
    if (!caseString) continue;

    // Find the first call_expression in the case body that's a direct identifier call.
    // Skip past the value node's siblings looking for statements.
    const calls = findDescendants(switchCase, (n) => n.type === 'call_expression');
    for (const c of calls) {
      const fn = c.childForFieldName('function');
      if (fn && fn.type === 'identifier') {
        out.push({
          caseString,
          handlerName: fn.text,
          line: c.startPosition.row + 1,
          col: c.startPosition.column,
        });
        break; // just the first handler call
      }
    }
  }
  return out;
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
  const dispatchEdges = [];
  const exportedNames = new Set();
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
    if (node.type === 'export_statement') {
      for (const n of exportedNamesFromExportStatement(node)) exportedNames.add(n);
    }
    if (node.type === 'expression_statement') {
      // Handle CJS module.exports = ... by drilling into assignment_expression.
      const expr = node.namedChild(0);
      if (expr && expr.type === 'assignment_expression') {
        for (const n of exportedNamesFromCjsAssignment(expr)) exportedNames.add(n);
      }
    }
    if (node.type === 'switch_statement') {
      for (const e of extractDispatchEdgesFromSwitch(node)) dispatchEdges.push(e);
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      walk(node.namedChild(i));
    }
    if (pushed) enclosingStack.pop();
  }

  walk(tree.rootNode);

  // Mark each symbol's is_exported flag from the export-name set we collected.
  for (const s of symbols) {
    s.isExported = exportedNames.has(s.name);
  }

  return { symbols, references, dispatchEdges, exportedNames: [...exportedNames] };
}

module.exports = { extractFromSource };
