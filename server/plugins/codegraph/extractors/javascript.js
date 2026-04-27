'use strict';

const { getParser } = require('../parser');

const FUNCTION_NODE_TYPES = new Set([
  'function_declaration',
  'generator_function_declaration',
  'method_definition',
  'class_declaration',
  'arrow_function',
  'function',
]);

function nodeName(node) {
  const nameNode = node.childForFieldName('name');
  return nameNode ? nameNode.text : '';
}

// Walk the function/method node's tokens (children, not just namedChildren)
// for modifier keywords: `async`, `static`, `*` (generator), `get`, `set`.
// These appear as unnamed token nodes before the name in tree-sitter-javascript.
function detectModifiers(node) {
  let isAsync = false;
  let isGenerator = false;
  let isStatic = false;
  let isGetter = false;
  let isSetter = false;
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c.isNamed) {
      // Named children are sub-trees (parameters, body, name, etc.) — modifier
      // tokens have already passed by this point in the child sequence. Stop
      // scanning to avoid drifting into the body.
      if (c.type !== 'property_identifier' && c.type !== 'identifier') break;
      continue;
    }
    switch (c.type) {
      case 'async':  isAsync = true; break;
      case 'static': isStatic = true; break;
      case '*':      isGenerator = true; break;
      case 'get':    isGetter = true; break;
      case 'set':    isSetter = true; break;
      default: break;
    }
  }
  // generator_function_declaration always implies generator regardless of token scan.
  if (node.type === 'generator_function_declaration') isGenerator = true;
  return { isAsync, isGenerator, isStatic, isGetter, isSetter };
}

function kindFor(node, mods) {
  switch (node.type) {
    case 'function_declaration':
    case 'generator_function_declaration':
      return mods.isGenerator ? 'generator' : 'function';
    case 'method_definition':
      if (mods.isGetter) return 'getter';
      if (mods.isSetter) return 'setter';
      // Constructor recognized by name, not modifier — caller fills it in.
      return 'method';
    case 'class_declaration': return 'class';
    case 'arrow_function':    return 'arrow';
    case 'function':          return 'function';
    default:                  return 'unknown';
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

// Pull the receiver expression's identifier from a member-expression call:
//   foo.bar()     → 'foo'
//   this.x.y()    → 'this' (only direct receiver; deeper resolution needs
//                            field tracking which is out of Slice B scope)
//   pkg.fn()      → 'pkg'
// Returns '' for non-member calls or non-identifier objects (e.g.,
// `(a||b).foo()`, function calls returning objects).
function callReceiverName(callNode) {
  const fn = callNode.childForFieldName('function');
  if (!fn || fn.type !== 'member_expression') return '';
  const obj = fn.childForFieldName('object');
  if (!obj) return '';
  if (obj.type === 'identifier' || obj.type === 'this') return obj.text;
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

// JavaScript built-ins / type coercion that are never tool dispatch handlers.
// Without filtering, `case 'initialize': const x = Boolean(args.foo)` would
// pin `Boolean` as the handler for tool 'initialize' — pure noise.
const COERCION_BUILTINS = new Set([
  'Boolean', 'Number', 'String', 'Array', 'Object', 'Symbol', 'BigInt',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'Promise',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Buffer',
]);

// Common method names called via `obj.foo()` that are never the tool's
// dispatched handler. Without this filter, `case 'analyze': const result =
// analyzeDatabase(args); list.push(result); return result` would pin `push`
// as the handler (it's the only call inside an expression_statement).
const METHOD_BUILTINS = new Set([
  // Array
  'push', 'pop', 'shift', 'unshift', 'slice', 'splice', 'concat', 'join',
  'reverse', 'sort', 'fill', 'find', 'findIndex', 'findLast', 'findLastIndex',
  'includes', 'indexOf', 'lastIndexOf', 'some', 'every', 'forEach', 'map',
  'filter', 'reduce', 'reduceRight', 'flat', 'flatMap', 'at',
  // Map / Set
  'has', 'get', 'set', 'delete', 'clear', 'add', 'keys', 'values', 'entries',
  // String
  'charAt', 'charCodeAt', 'codePointAt', 'endsWith', 'matchAll', 'normalize',
  'padEnd', 'padStart', 'repeat', 'replace', 'replaceAll', 'startsWith',
  'substr', 'substring', 'toLowerCase', 'toUpperCase', 'trim', 'trimEnd',
  'trimStart', 'split',
  // Object / Function
  'hasOwnProperty', 'toString', 'valueOf', 'bind', 'call', 'apply',
  // Promise
  'then', 'catch', 'finally',
  // Console
  'log', 'warn', 'error', 'info', 'debug',
  // Generic data ops
  'toJSON', 'parse', 'stringify',
]);

// Heuristic: receiver names that look like dispatch tables. Used to gate
// `routeMap.set('foo', handleFoo)` capture so we don't pollute dispatch_edges
// with every Map.set() call in the codebase.
const DISPATCH_RECEIVER_PATTERN = /(map|handlers|registry|routes|dispatch|tools|commands|router)$/i;

// Detect dispatcher patterns:
//   switch (x) { case 'foo': return handleFoo(args); ... }
//   switch (x) { case 'foo': { return handleFoo(args); } ... }
// Returns [{caseString, handlerName, line, col}, ...]
//
// Only top-level statements of the case body are inspected (not deep
// descendants), and return-position calls are preferred over expression
// statements. This avoids pinning incidental helper calls inside the
// case body as the dispatched handler.
function extractDispatchEdgesFromSwitch(switchStatementNode) {
  const out = [];
  const body = switchStatementNode.childForFieldName('body');
  if (!body) return out;

  function pickCalls(switchCase) {
    const returnCalls = [];
    const exprCalls  = [];
    function collect(stmt) {
      if (stmt.type === 'return_statement') {
        const e = stmt.namedChild(0);
        if (e && e.type === 'call_expression') returnCalls.push(e);
      } else if (stmt.type === 'expression_statement') {
        const e = stmt.namedChild(0);
        if (e && e.type === 'call_expression') exprCalls.push(e);
      } else if (stmt.type === 'statement_block') {
        for (let j = 0; j < stmt.namedChildCount; j++) collect(stmt.namedChild(j));
      }
    }
    // Skip the case value at index 0; iterate the rest as statements.
    for (let i = 1; i < switchCase.namedChildCount; i++) collect(switchCase.namedChild(i));
    return [...returnCalls, ...exprCalls];
  }

  for (let i = 0; i < body.namedChildCount; i++) {
    const switchCase = body.namedChild(i);
    if (switchCase.type !== 'switch_case') continue;

    const valueNode = switchCase.namedChild(0);
    const caseString = stringLiteralValue(valueNode);
    if (!caseString) continue;

    const calls = pickCalls(switchCase);
    for (const c of calls) {
      const fn = c.childForFieldName('function');
      if (!fn) continue;
      let name = '';
      if (fn.type === 'identifier') {
        name = fn.text;
      } else if (fn.type === 'member_expression') {
        // Capture the property name for `obj.handleFoo()` style dispatch.
        const prop = fn.childForFieldName('property');
        if (prop && prop.type === 'property_identifier') name = prop.text;
      }
      if (!name || COERCION_BUILTINS.has(name) || METHOD_BUILTINS.has(name)) continue;
      out.push({
        caseString,
        handlerName: name,
        line: c.startPosition.row + 1,
        col: c.startPosition.column,
      });
      break;
    }
  }
  return out;
}

// Detect map-registration patterns:
//   routeMap.set('toolname', handlerFn)
//   handlersByName.set('foo', handleFoo)
// Returns [{caseString, handlerName, line, col}, ...]. Restricted to receivers
// whose name matches DISPATCH_RECEIVER_PATTERN to avoid capturing every
// Map.set() / Set.add() call in the codebase.
function extractMapRegistrations(callNode) {
  const fn = callNode.childForFieldName('function');
  if (!fn || fn.type !== 'member_expression') return null;
  const obj = fn.childForFieldName('object');
  const prop = fn.childForFieldName('property');
  if (!obj || obj.type !== 'identifier') return null;
  if (!prop || prop.type !== 'property_identifier') return null;
  if (prop.text !== 'set') return null;
  if (!DISPATCH_RECEIVER_PATTERN.test(obj.text)) return null;

  const args = callNode.childForFieldName('arguments');
  if (!args || args.namedChildCount < 2) return null;
  const keyArg = args.namedChild(0);
  const valArg = args.namedChild(1);
  const caseString = stringLiteralValue(keyArg);
  if (!caseString) return null;

  // Accept either a bare identifier (`handleFoo`) or a member expression
  // (`namespace.handleFoo`) as the registered handler. TORQUE's tools.js
  // uses the member-expression form: routeMap.set('foo', mod.handleFoo).
  let handlerName = '';
  if (valArg.type === 'identifier') {
    handlerName = valArg.text;
  } else if (valArg.type === 'member_expression') {
    const prop = valArg.childForFieldName('property');
    if (prop && prop.type === 'property_identifier') handlerName = prop.text;
  }
  if (!handlerName) return null;
  return {
    caseString,
    handlerName,
    line: callNode.startPosition.row + 1,
    col: callNode.startPosition.column,
  };
}

// Detect object-literal dispatch tables:
//   { name: 'tool_name', handler: handlerFn }
//   { command: 'tool_name', handler: handlerFn }
//   { tool: 'tool_name', handler: handlerFn }
// These show up in plugin tool registrations and arrays of route specs.
// Returns one edge per object that has BOTH a string `name`/`command`/`tool`
// field AND an identifier `handler` field.
function extractObjectLiteralRegistration(objectNode) {
  let nameVal = null;
  let handlerVal = null;
  for (let i = 0; i < objectNode.namedChildCount; i++) {
    const pair = objectNode.namedChild(i);
    if (pair.type !== 'pair') continue;
    const key = pair.childForFieldName('key');
    const val = pair.childForFieldName('value');
    if (!key || !val) continue;
    const keyName =
      key.type === 'property_identifier' || key.type === 'identifier' ? key.text :
      key.type === 'string' ? stringLiteralValue(key) : null;
    if (!keyName) continue;
    if ((keyName === 'name' || keyName === 'command' || keyName === 'tool') && val.type === 'string') {
      nameVal = stringLiteralValue(val);
    } else if (keyName === 'handler') {
      if (val.type === 'identifier') {
        handlerVal = val.text;
      } else if (val.type === 'member_expression') {
        const prop = val.childForFieldName('property');
        if (prop && prop.type === 'property_identifier') handlerVal = prop.text;
      }
    }
  }
  if (nameVal && handlerVal) {
    return {
      caseString: nameVal,
      handlerName: handlerVal,
      line: objectNode.startPosition.row + 1,
      col: objectNode.startPosition.column,
    };
  }
  return null;
}

// Detect handler-factory pattern:
//   function createXxxHandlers({ deps }) {
//     return {
//       cg_reindex(args) { ... },
//       cg_find_references(args) { ... },
//     };
//   }
//
// In TORQUE plugins, the methods of this returned object ARE the handlers
// for tools whose names match the method names. Static analysis can't
// observe the runtime `handlers[toolDef.name]` lookup that pairs them with
// tool descriptors, so we emit a self-referential dispatch edge per method:
// caseString = handlerName = methodName. Querying cg_resolve_tool('cg_reindex')
// then returns the method's location, which is exactly what the LLM needs.
//
// Restricted to functions whose name matches /^create[A-Z]\w*[Hh]andlers?$/
// to avoid false positives from arbitrary factories.
const HANDLER_FACTORY_NAME_PATTERN = /^create[A-Z]\w*[Hh]andlers?$/;

function extractHandlerFactoryPattern(functionNode) {
  const out = [];
  const nameNode = functionNode.childForFieldName('name');
  if (!nameNode) return out;
  const fnName = nameNode.text;
  if (!HANDLER_FACTORY_NAME_PATTERN.test(fnName)) return out;

  const body = functionNode.childForFieldName('body');
  if (!body || body.type !== 'statement_block') return out;

  // Look for `return { ... }` at the top level of the function body.
  // Conservative: only match a direct return statement, not nested returns.
  for (let i = 0; i < body.namedChildCount; i++) {
    const stmt = body.namedChild(i);
    if (stmt.type !== 'return_statement') continue;
    const returned = stmt.namedChild(0);
    if (!returned || returned.type !== 'object') continue;

    // Walk the object's properties. Each method or pair-with-function-value
    // is a handler.
    for (let j = 0; j < returned.namedChildCount; j++) {
      const member = returned.namedChild(j);
      let methodName = null;
      let line = member.startPosition.row + 1;
      let col = member.startPosition.column;

      if (member.type === 'method_definition') {
        const nm = member.childForFieldName('name');
        if (nm && (nm.type === 'property_identifier' || nm.type === 'identifier')) {
          methodName = nm.text;
        } else if (nm && nm.type === 'string') {
          // String-keyed method: `'cg_tool'(args) { ... }`
          methodName = stringLiteralValue(nm);
        }
      } else if (member.type === 'pair') {
        const key = member.childForFieldName('key');
        const val = member.childForFieldName('value');
        if (!key || !val) continue;
        // Only emit when the value is a function — otherwise this is just data.
        if (val.type !== 'arrow_function' && val.type !== 'function' && val.type !== 'function_expression') continue;
        if (key.type === 'property_identifier' || key.type === 'identifier') {
          methodName = key.text;
        } else if (key.type === 'string') {
          methodName = stringLiteralValue(key);
        }
      }

      if (methodName) {
        out.push({
          caseString: methodName,
          handlerName: methodName,
          line,
          col,
        });
      }
    }
  }
  return out;
}

// Pull a usable name out of an extends/implements expression.
// Handles `class X extends Foo`, `class X extends ns.Foo`, and falls back
// to the raw text for unusual cases (mixin calls etc.). Returns '' when
// nothing identifier-like is present, in which case the edge is dropped.
function supertypeName(node) {
  if (!node) return '';
  if (node.type === 'identifier' || node.type === 'type_identifier') return node.text;
  if (node.type === 'member_expression') {
    const prop = node.childForFieldName('property');
    return prop ? prop.text : '';
  }
  // generic_type wraps `Foo<T>`; the underlying name is the first child.
  if (node.type === 'generic_type') {
    const head = node.namedChild(0);
    if (head) return supertypeName(head);
  }
  return '';
}

// Walk a class_declaration / interface_declaration node and emit class-edge
// records for its extends/implements clauses. Tree-sitter shapes the
// heritage tree differently across grammars:
//   JS class:  class_heritage → identifier ("Animal")          [direct child = supertype]
//   TS class:  class_heritage → extends_clause → identifier
//                            → implements_clause → type_identifier+
//   TS iface:  interface_declaration → extends_type_clause → type_identifier+
// We accept both shapes by treating `class_heritage`'s direct identifier
// children as extends edges (JS shape) AND by recursing into nested
// extends_clause / implements_clause / extends_type_clause wrappers (TS).
function extractClassEdges(node) {
  const subName = nodeName(node);
  if (!subName) return [];
  const out = [];

  function pushSupertype(supertypeNode, edgeKind) {
    const sup = supertypeName(supertypeNode);
    if (!sup) return;
    out.push({
      subtypeName: subName,
      supertypeName: sup,
      edgeKind,
      line: supertypeNode.startPosition.row + 1,
      col:  supertypeNode.startPosition.column,
    });
  }

  function visitClause(clause) {
    if (!clause) return;
    if (clause.type === 'class_heritage') {
      // Either wraps clauses (TS) or directly contains the supertype (JS).
      for (let i = 0; i < clause.namedChildCount; i++) {
        const child = clause.namedChild(i);
        if (child.type === 'extends_clause' || child.type === 'implements_clause') {
          visitClause(child);
        } else {
          // JS shape: the bare supertype identifier sits inside class_heritage.
          pushSupertype(child, 'extends');
        }
      }
      return;
    }
    if (clause.type === 'extends_clause' || clause.type === 'extends_type_clause') {
      for (let i = 0; i < clause.namedChildCount; i++) {
        pushSupertype(clause.namedChild(i), 'extends');
      }
      return;
    }
    if (clause.type === 'implements_clause') {
      for (let i = 0; i < clause.namedChildCount; i++) {
        pushSupertype(clause.namedChild(i), 'implements');
      }
      return;
    }
  }

  for (let i = 0; i < node.namedChildCount; i++) visitClause(node.namedChild(i));
  return out;
}

// Read the string payload from a string-literal node (the path side of an
// import/require). Older grammars use a `string_fragment` named child;
// newer ones expose `text` directly.
function readStringLiteral(node) {
  if (!node) return '';
  if (node.type !== 'string') return '';
  const frag = node.namedChildren.find((c) => c.type === 'string_fragment');
  if (frag) return frag.text;
  const t = node.text;
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'" || t[0] === '`')) return t.slice(1, -1);
  return t;
}

// ESM `import_statement`. Shape variants:
//   import { foo, bar as b2 } from './x'
//   import * as ns from './y'
//   import def from './z'
//   import './side-effect'         — no binding; emits nothing
//   import type { Foo } from 'x'   — TS type-only; emits nothing
function extractImportsFromImportStatement(node) {
  const out = [];
  // Detect TS type-only imports. tree-sitter-typescript renders the `type`
  // keyword as an unnamed token; if any child token text === 'type', skip
  // entirely (those bindings don't appear at runtime so they can't resolve
  // a call).
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c.isNamed && c.type === 'type') return out;
  }

  const importClause = node.namedChildren.find((c) => c.type === 'import_clause');
  const stringNode  = node.namedChildren.find((c) => c.type === 'string');
  const sourceModule = readStringLiteral(stringNode);
  if (!sourceModule || !importClause) return out;

  const line = node.startPosition.row + 1;
  const col  = node.startPosition.column;

  for (let i = 0; i < importClause.namedChildCount; i++) {
    const child = importClause.namedChild(i);
    if (child.type === 'identifier') {
      // default import: `import def from './z'`
      out.push({ localName: child.text, sourceModule, sourceName: 'default', line, col });
    } else if (child.type === 'namespace_import') {
      // `import * as ns from './y'`
      const id = child.namedChildren.find((c) => c.type === 'identifier');
      if (id) out.push({ localName: id.text, sourceModule, sourceName: null, line, col });
    } else if (child.type === 'named_imports') {
      // `import { foo, bar as b2 } from './x'`
      for (let j = 0; j < child.namedChildCount; j++) {
        const spec = child.namedChild(j);
        if (spec.type !== 'import_specifier') continue;
        // import_specifier has 1 identifier (just the name) or 2 (name + alias).
        const ids = spec.namedChildren.filter((c) => c.type === 'identifier');
        if (ids.length === 1) {
          out.push({ localName: ids[0].text, sourceModule, sourceName: ids[0].text, line, col });
        } else if (ids.length >= 2) {
          out.push({ localName: ids[1].text, sourceModule, sourceName: ids[0].text, line, col });
        }
      }
    }
  }
  return out;
}

// CommonJS via `const X = require('mod')` or `const { x, y: yy } = require('mod')`.
// declNode is a variable_declarator. Returns [] if it doesn't look like a
// require() destructure / binding.
function extractImportsFromRequireDeclarator(declNode) {
  const out = [];
  const value = declNode.childForFieldName('value');
  if (!value || value.type !== 'call_expression') return out;
  const fn = value.childForFieldName('function');
  if (!fn || fn.type !== 'identifier' || fn.text !== 'require') return out;
  const args = value.childForFieldName('arguments');
  if (!args) return out;
  const argString = args.namedChildren.find((c) => c.type === 'string');
  const sourceModule = readStringLiteral(argString);
  if (!sourceModule) return out;

  const line = value.startPosition.row + 1;
  const col  = value.startPosition.column;

  const lhs = declNode.childForFieldName('name');
  if (!lhs) return out;
  if (lhs.type === 'identifier') {
    // const mod = require('./bb')  → binds module's exports object as `mod`.
    // We record it with sourceName=null so resolution treats `mod` as a
    // namespace handle (consumers pivot to `mod.X` lookups, which slice B
    // will resolve once method-call resolution lands).
    out.push({ localName: lhs.text, sourceModule, sourceName: null, line, col });
  } else if (lhs.type === 'object_pattern') {
    // const { a, b: bb } = require('./aa')
    for (let i = 0; i < lhs.namedChildCount; i++) {
      const part = lhs.namedChild(i);
      if (part.type === 'shorthand_property_identifier_pattern') {
        out.push({ localName: part.text, sourceModule, sourceName: part.text, line, col });
      } else if (part.type === 'pair_pattern') {
        const key = part.childForFieldName('key');
        const val = part.childForFieldName('value');
        if (key && val && val.type === 'identifier') {
          out.push({ localName: val.text, sourceModule, sourceName: key.text, line, col });
        }
      }
    }
  }
  return out;
}

// Pull a usable name out of a TS type annotation node:
//   type_identifier            → its text
//   generic_type               → underlying head (drops <T> args)
//   nested_type_identifier     → rightmost name (a.b.Foo → 'Foo')
//   union_type                 → null (we won't resolve "Foo | null" to one type)
// Returns '' when the type is too complex to commit to a single name.
function unwrapTsTypeName(node) {
  if (!node) return '';
  if (node.type === 'type_identifier' || node.type === 'identifier') return node.text;
  if (node.type === 'generic_type') {
    const head = node.namedChild(0);
    return head ? unwrapTsTypeName(head) : '';
  }
  if (node.type === 'nested_type_identifier') {
    const last = node.namedChild(node.namedChildCount - 1);
    return last ? last.text : '';
  }
  // type_annotation wraps the actual type; drill in.
  if (node.type === 'type_annotation') {
    const inner = node.namedChild(0);
    return inner ? unwrapTsTypeName(inner) : '';
  }
  return '';
}

// Extract local-variable type bindings from a `variable_declarator` node:
//   const x: Foo = ...           → { localName: 'x', typeName: 'Foo' } (TS only)
//   const x = new Foo(...)       → { localName: 'x', typeName: 'Foo' } (JS+TS)
// Returns null when no usable type can be derived.
function extractLocalTypeBinding(declNode, language) {
  const nameNode = declNode.childForFieldName('name');
  if (!nameNode || nameNode.type !== 'identifier') return null;
  const localName = nameNode.text;

  // TS path: explicit type annotation. `const x: Foo = ...` produces a
  // `type_annotation` named child containing the type expression.
  const isTs = language === 'typescript' || language === 'tsx';
  if (isTs) {
    const typeAnno = declNode.namedChildren.find((c) => c.type === 'type_annotation');
    if (typeAnno) {
      const t = unwrapTsTypeName(typeAnno);
      if (t) {
        return {
          localName, typeName: t,
          line: declNode.startPosition.row + 1,
          col:  declNode.startPosition.column,
        };
      }
    }
  }

  // Constructor inference: `const x = new Foo(...)` works in both JS and TS.
  // tree-sitter-javascript surfaces `new Foo()` as a `new_expression` whose
  // `constructor` field is the type identifier. tree-sitter-typescript uses
  // the same shape.
  const value = declNode.childForFieldName('value');
  if (value && value.type === 'new_expression') {
    const ctor = value.childForFieldName('constructor');
    const ctorName = ctor && (ctor.type === 'identifier' || ctor.type === 'type_identifier')
      ? ctor.text
      : (ctor && ctor.type === 'member_expression'
          ? (ctor.childForFieldName('property')?.text || '')
          : '');
    if (ctorName) {
      return {
        localName, typeName: ctorName,
        line: declNode.startPosition.row + 1,
        col:  declNode.startPosition.column,
      };
    }
  }
  return null;
}

// Walk a `parameters` node and emit cg_locals rows for typed parameters.
// TS-only — plain JS function params have no type annotations.
function collectParameterTypes(paramsNode, locals, scopeSymbolIndex, language) {
  if (language !== 'typescript' && language !== 'tsx') return;
  for (let i = 0; i < paramsNode.namedChildCount; i++) {
    const param = paramsNode.namedChild(i);
    // Required/optional params; rest params; defaulted params.
    if (param.type !== 'required_parameter'
     && param.type !== 'optional_parameter'
     && param.type !== 'rest_parameter') continue;
    const pat = param.childForFieldName('pattern')
             || param.namedChildren.find((c) => c.type === 'identifier');
    if (!pat || pat.type !== 'identifier') continue;
    const typeAnno = param.namedChildren.find((c) => c.type === 'type_annotation');
    if (!typeAnno) continue;
    const typeName = unwrapTsTypeName(typeAnno);
    if (!typeName) continue;
    locals.push({
      localName: pat.text,
      typeName,
      scopeSymbolIndex,
      line: param.startPosition.row + 1,
      col:  param.startPosition.column,
    });
  }
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
  const classEdges = [];
  const imports = [];
  const locals = [];
  const exportedNames = new Set();
  const enclosingStack = []; // indexes into `symbols`
  const containerStack = []; // names of enclosing class/interface declarations

  function walk(node) {
    let pushed = false;
    let pushedContainer = false;
    if (FUNCTION_NODE_TYPES.has(node.type)) {
      const name = nodeName(node);
      if (name) {
        const mods = detectModifiers(node);
        let kind = kindFor(node, mods);
        // Constructors are recognized by name in class bodies — promote 'method'
        // to 'constructor' when the property identifier is exactly that.
        if (kind === 'method' && name === 'constructor') kind = 'constructor';
        // Methods defined inside a class/interface get container_name set so
        // pass-2 method-call resolution can join cg_locals.type_name to
        // cg_symbols.container_name.
        const containerName = (kind === 'method' || kind === 'constructor' || kind === 'getter' || kind === 'setter')
          ? containerStack[containerStack.length - 1] || null
          : null;
        symbols.push({
          name,
          kind,
          startLine: node.startPosition.row + 1,
          startCol: node.startPosition.column,
          endLine:   node.endPosition.row + 1,
          endCol:    node.endPosition.column,
          isAsync: mods.isAsync,
          isGenerator: mods.isGenerator,
          isStatic: mods.isStatic,
          containerName,
        });
        enclosingStack.push(symbols.length - 1);
        pushed = true;
        // Capture parameter types for TS arrow functions / function decls /
        // method decls. Anywhere parameters live, the parser surfaces them
        // under a `parameters` field.
        const params = node.childForFieldName('parameters');
        if (params) collectParameterTypes(params, locals, symbols.length - 1, language);
      }
    }
    if (node.type === 'class_declaration' || node.type === 'interface_declaration') {
      const cname = nodeName(node);
      if (cname) {
        containerStack.push(cname);
        pushedContainer = true;
      }
    }
    if (node.type === 'call_expression') {
      const target = callTargetName(node);
      if (target) {
        references.push({
          targetName: target,
          receiverName: callReceiverName(node) || null,
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
    if (node.type === 'call_expression') {
      const reg = extractMapRegistrations(node);
      if (reg) dispatchEdges.push(reg);
    }
    if (node.type === 'object') {
      const reg = extractObjectLiteralRegistration(node);
      if (reg) dispatchEdges.push(reg);
    }
    if (node.type === 'function_declaration') {
      for (const e of extractHandlerFactoryPattern(node)) dispatchEdges.push(e);
    }
    if (node.type === 'class_declaration' || node.type === 'interface_declaration') {
      for (const e of extractClassEdges(node)) classEdges.push(e);
    }
    if (node.type === 'import_statement') {
      for (const imp of extractImportsFromImportStatement(node)) imports.push(imp);
    }
    if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
      // CommonJS require: `const x = require('./y')` or destructure variant.
      for (let i = 0; i < node.namedChildCount; i++) {
        const decl = node.namedChild(i);
        if (decl.type !== 'variable_declarator') continue;
        for (const imp of extractImportsFromRequireDeclarator(decl)) imports.push(imp);
        // Type annotations + constructor inference for method-call resolution.
        // Only TS files have type annotations at the AST level; for plain JS
        // we still pick up `new Foo()` constructor calls.
        const local = extractLocalTypeBinding(decl, language);
        if (local) {
          locals.push({
            ...local,
            scopeSymbolIndex: enclosingStack[enclosingStack.length - 1] ?? null,
          });
        }
      }
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      walk(node.namedChild(i));
    }
    if (pushedContainer) containerStack.pop();
    if (pushed) enclosingStack.pop();
  }

  walk(tree.rootNode);

  // Mark each symbol's is_exported flag from the export-name set we collected.
  for (const s of symbols) {
    s.isExported = exportedNames.has(s.name);
  }

  return { symbols, references, dispatchEdges, classEdges, imports, locals, exportedNames: [...exportedNames] };
}

module.exports = { extractFromSource };
