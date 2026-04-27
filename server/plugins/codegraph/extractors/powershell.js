'use strict';

const { getParser } = require('../parser');

// Top-level definitions we surface as symbols.
const SYMBOL_NODE_TYPES = new Set([
  'function_statement',     // function Verb-Noun { ... } / filter Verb-Noun { ... }
  'class_statement',        // class Foo { ... }
  'class_method_definition',
  'class_property_definition',
]);

function findChild(node, type) {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c.type === type) return c;
  }
  return null;
}

function findChildren(node, type) {
  const out = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c.type === type) out.push(c);
  }
  return out;
}

// Pull the bare identifier text from a `variable` node — `$foo` → 'foo'.
function variableName(node) {
  if (!node || node.type !== 'variable') return '';
  const t = node.text;
  // PowerShell variables are `$name` or `${name}` or `$script:name` etc.
  // For local-binding lookup, the bare name (last :: segment, no $) is what
  // matches against cg_locals.local_name and method-call receiver capture.
  let s = t;
  if (s.startsWith('$')) s = s.slice(1);
  if (s.startsWith('{') && s.endsWith('}')) s = s.slice(1, -1);
  // Drop scope prefix like `script:` or `global:`
  const colonIdx = s.lastIndexOf(':');
  if (colonIdx >= 0) s = s.slice(colonIdx + 1);
  return s;
}

// Pull the type name from a `type_literal` annotation.
//   [string]              → 'string'
//   [Animal]              → 'Animal'
//   [System.IO.Stream]    → 'Stream' (rightmost segment)
//   [List[Foo]]           → 'List' (head)
function typeFromLiteral(typeLiteral) {
  if (!typeLiteral) return '';
  const spec = findChild(typeLiteral, 'type_spec');
  if (!spec) return '';
  const name = findChild(spec, 'type_name');
  if (!name) return '';
  // type_name's children are 'type_identifier' (possibly multiple for
  // dotted namespaces); take the last.
  const ids = findChildren(name, 'type_identifier');
  if (ids.length > 0) return ids[ids.length - 1].text;
  // Fallback: take any text after the last dot.
  const t = name.text;
  const dotIdx = t.lastIndexOf('.');
  return dotIdx >= 0 ? t.slice(dotIdx + 1) : t;
}

function functionStatementName(node) {
  const fn = findChild(node, 'function_name');
  return fn ? fn.text : '';
}

function classStatementName(node) {
  const ids = findChildren(node, 'simple_name');
  return ids.length > 0 ? ids[0].text : '';
}

function classStatementBase(node) {
  const ids = findChildren(node, 'simple_name');
  return ids.length > 1 ? ids[1].text : '';
}

function classMethodName(node) {
  return (findChild(node, 'simple_name') || {}).text || '';
}

function classPropertyName(node) {
  const v = findChild(node, 'variable');
  return v ? variableName(v) : '';
}

function classPropertyType(node) {
  return typeFromLiteral(findChild(node, 'type_literal'));
}

// Walk a class_method_definition's parameter list and emit cg_locals rows
// for typed parameters. PowerShell uses two distinct parameter shapes:
//   - class methods: `class_method_parameter_list` → `class_method_parameter`
//     (children: type_literal, variable)
//   - functions/cmdlets: `param_block` → `parameter_list` → `script_parameter`
//     (children: attribute_list with [type] attribute, variable)
function collectMethodParameterTypes(methodNode, locals, scopeSymbolIndex, containerName) {
  // Class-method parameter list (the common case for class_method_definition).
  const cmpList = findChild(methodNode, 'class_method_parameter_list');
  if (cmpList) {
    for (const p of findChildren(cmpList, 'class_method_parameter')) {
      const t = typeFromLiteral(findChild(p, 'type_literal'));
      const v = findChild(p, 'variable');
      if (!t || !v) continue;
      locals.push({
        localName: variableName(v),
        typeName: t,
        scopeSymbolIndex,
        line: p.startPosition.row + 1,
        col:  p.startPosition.column,
      });
    }
  }

  // Function-style parameter sources. PowerShell exposes them three ways
  // for plain functions:
  //   1. `function_parameter_declaration > parameter_list` for the inline
  //      shape `function Foo([T] $x) { ... }` (most common in scripts).
  //   2. `param_block` directly under the function node for explicit
  //      `function Foo { param([T] $x) ... }`.
  //   3. `param_block` inside the script_block (some grammar versions
  //      shape it that way).
  const scriptBlock = findChild(methodNode, 'script_block');
  const paramSources = [
    findChild(methodNode, 'function_parameter_declaration'),
    findChild(methodNode, 'param_block'),
    scriptBlock ? findChild(scriptBlock, 'param_block') : null,
  ].filter(Boolean);

  for (const src of paramSources) {
    const paramList = findChild(src, 'parameter_list') || src;
    for (const p of findChildren(paramList, 'script_parameter')) {
      const v = findChild(p, 'variable');
      const attrList = findChild(p, 'attribute_list');
      if (!v || !attrList) continue;
      const attr = findChild(attrList, 'attribute');
      if (!attr) continue;
      const t = typeFromLiteral(findChild(attr, 'type_literal'));
      if (!t) continue;
      locals.push({
        localName: variableName(v),
        typeName: t,
        scopeSymbolIndex,
        line: p.startPosition.row + 1,
        col:  p.startPosition.column,
      });
    }
  }

  // $this in any class_method_definition binds to the containing class.
  if (containerName) {
    locals.push({
      localName: 'this',
      typeName: containerName,
      scopeSymbolIndex,
      line: methodNode.startPosition.row + 1,
      col:  methodNode.startPosition.column,
    });
  }
}

// Receiver of `$obj.Speak()`: 'obj' (variable name without leading $).
function invokationReceiver(invNode) {
  const v = findChild(invNode, 'variable');
  return v ? variableName(v) : '';
}

function invokationTarget(invNode) {
  const member = findChild(invNode, 'member_name');
  if (!member) return '';
  const id = findChild(member, 'simple_name');
  return id ? id.text : '';
}

function commandName(cmdNode) {
  const n = findChild(cmdNode, 'command_name');
  return n ? n.text : '';
}

async function extractFromSource(source) {
  const parser = await getParser('powershell');
  const tree = parser.parse(source, null, {
    bufferSize: Math.max(32 * 1024, source.length + 32 * 1024),
  });

  const symbols = [];
  const references = [];
  const dispatchEdges = []; // not currently captured for PowerShell
  const classEdges = [];
  const imports = [];        // PowerShell uses `Import-Module` / dot-sourcing; not captured in v1
  const locals = [];
  const exportedNames = new Set();
  const enclosingStack = [];
  const containerStack = [];

  function walk(node, depth = 0) {
    let pushedSymbol = false;
    let pushedContainer = false;

    if (node.type === 'function_statement') {
      const name = functionStatementName(node);
      if (name) {
        symbols.push({
          name,
          kind: 'function',
          startLine: node.startPosition.row + 1,
          startCol:  node.startPosition.column,
          endLine:   node.endPosition.row + 1,
          endCol:    node.endPosition.column,
          isAsync: false,
          isGenerator: false,
          isStatic: false,
          containerName: null,
        });
        // PowerShell exports default to all top-level non-private names.
        if (depth === 0) exportedNames.add(name);
        enclosingStack.push(symbols.length - 1);
        pushedSymbol = true;
        // Same parameter capture as class methods — covers param_block,
        // function_parameter_declaration, and inline shapes.
        collectMethodParameterTypes(node, locals, symbols.length - 1, null);
      }
    } else if (node.type === 'class_statement') {
      const name = classStatementName(node);
      const base = classStatementBase(node);
      if (name) {
        symbols.push({
          name,
          kind: 'class',
          startLine: node.startPosition.row + 1,
          startCol:  node.startPosition.column,
          endLine:   node.endPosition.row + 1,
          endCol:    node.endPosition.column,
          isAsync: false,
          isGenerator: false,
          isStatic: false,
          containerName: null,
        });
        if (depth === 0) exportedNames.add(name);
        if (base) {
          classEdges.push({
            subtypeName: name,
            supertypeName: base,
            edgeKind: 'extends',
            line: node.startPosition.row + 1,
            col:  node.startPosition.column,
          });
        }
        enclosingStack.push(symbols.length - 1);
        containerStack.push(name);
        pushedSymbol = true;
        pushedContainer = true;
      }
    } else if (node.type === 'class_method_definition') {
      const name = classMethodName(node);
      const containerName = containerStack[containerStack.length - 1] || null;
      if (name) {
        symbols.push({
          name,
          kind: 'method',
          startLine: node.startPosition.row + 1,
          startCol:  node.startPosition.column,
          endLine:   node.endPosition.row + 1,
          endCol:    node.endPosition.column,
          isAsync: false,
          isGenerator: false,
          isStatic: false,
          containerName,
        });
        enclosingStack.push(symbols.length - 1);
        pushedSymbol = true;
        // Capture parameter types + bind $this to the containing class.
        collectMethodParameterTypes(node, locals, symbols.length - 1, containerName);
      }
    } else if (node.type === 'class_property_definition') {
      const name = classPropertyName(node);
      const containerName = containerStack[containerStack.length - 1] || null;
      if (name) {
        symbols.push({
          name,
          kind: 'property',
          startLine: node.startPosition.row + 1,
          startCol:  node.startPosition.column,
          endLine:   node.endPosition.row + 1,
          endCol:    node.endPosition.column,
          isAsync: false,
          isGenerator: false,
          isStatic: false,
          containerName,
        });
      }
    }

    // Method-call references: `$obj.Speak()` shapes as invokation_expression.
    if (node.type === 'invokation_expression') {
      const target = invokationTarget(node);
      if (target) {
        references.push({
          targetName: target,
          receiverName: invokationReceiver(node) || null,
          line: node.startPosition.row + 1,
          col:  node.startPosition.column,
          callerSymbolIndex: enclosingStack[enclosingStack.length - 1] ?? null,
        });
      }
    }

    // Cmdlet/function calls: bare command nodes.
    if (node.type === 'command') {
      const target = commandName(node);
      if (target) {
        references.push({
          targetName: target,
          receiverName: null,
          line: node.startPosition.row + 1,
          col:  node.startPosition.column,
          callerSymbolIndex: enclosingStack[enclosingStack.length - 1] ?? null,
        });
      }
    }

    for (let i = 0; i < node.namedChildCount; i++) {
      walk(node.namedChild(i), depth + (pushedSymbol ? 1 : 0));
    }

    if (pushedSymbol) enclosingStack.pop();
    if (pushedContainer) containerStack.pop();
  }

  walk(tree.rootNode, 0);

  for (const s of symbols) {
    s.isExported = exportedNames.has(s.name);
  }

  return { symbols, references, dispatchEdges, classEdges, imports, locals, exportedNames: [...exportedNames] };
}

module.exports = { extractFromSource };
