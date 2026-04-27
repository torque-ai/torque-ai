'use strict';

const { getParser } = require('../parser');

// Top-level Python definitions we capture as symbols.
//   function_definition  — `def foo(): ...`  (sync or async; async is a token)
//   class_definition     — `class Foo(Bar): ...`
//   decorated_definition — wraps either of the above when @decorators apply;
//                          we drill into the inner definition to surface it.
const SYMBOL_NODE_TYPES = new Set([
  'function_definition',
  'class_definition',
]);

function nodeName(node) {
  const nameNode = node.childForFieldName('name');
  return nameNode ? nameNode.text : '';
}

// Tree-sitter-python represents `async def` as an unnamed `async` token
// preceding `def` inside the function_definition's child list. Detect by
// scanning unnamed children up to the first named child (the name).
function detectModifiers(node) {
  let isAsync = false;
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c.isNamed) break;
    if (c.type === 'async') isAsync = true;
  }
  return { isAsync };
}

// Decorator application sets static/getter/setter style flags. Decorators
// appear in `decorated_definition` as `decorator` named children whose
// first named child is the decorator expression — usually a bare identifier
// like `staticmethod` or a call like `app.route(...)`. We surface the
// well-known three; others are ignored (don't change symbol kind).
function decoratorFlags(decoratedNode) {
  const flags = { isStatic: false, isGetter: false, isSetter: false, isClassMethod: false };
  for (let i = 0; i < decoratedNode.namedChildCount; i++) {
    const child = decoratedNode.namedChild(i);
    if (child.type !== 'decorator') continue;
    // The decorator's named child is the expression (identifier, attribute,
    // or call). Take its head identifier text.
    const expr = child.namedChild(0);
    let name = '';
    if (!expr) continue;
    if (expr.type === 'identifier') name = expr.text;
    else if (expr.type === 'call') {
      const fn = expr.childForFieldName('function');
      if (fn && fn.type === 'identifier') name = fn.text;
    }
    // Bare-name match for the python-stdlib decorators that imply a kind.
    if (name === 'staticmethod')  flags.isStatic = true;
    else if (name === 'classmethod') flags.isClassMethod = true;
    else if (name === 'property') flags.isGetter = true;
    // setter usage is `@<name>.setter` → expr is an `attribute` node;
    // simplest signal is the expression's text ending in `.setter`.
    else if (expr.text.endsWith('.setter')) flags.isSetter = true;
  }
  return flags;
}

function kindFor(node, isInsideClass) {
  if (node.type === 'class_definition') return 'class';
  if (node.type === 'function_definition') {
    if (isInsideClass) {
      const name = nodeName(node);
      if (name === '__init__') return 'constructor';
      return 'method';
    }
    return 'function';
  }
  return 'unknown';
}

// `call` node's function field can be:
//   identifier        — foo()
//   attribute         — obj.foo()  (we surface 'foo')
// Anything else (subscript, lambda call, etc.) returns ''.
function callTargetName(callNode) {
  const fn = callNode.childForFieldName('function');
  if (!fn) return '';
  if (fn.type === 'identifier') return fn.text;
  if (fn.type === 'attribute') {
    // Last named child is the rightmost attribute (e.g., `obj.x.foo` → 'foo').
    const last = fn.namedChild(fn.namedChildCount - 1);
    return last ? last.text : '';
  }
  return '';
}

// Class bases live in `argument_list` of class_definition. They mix:
//   identifier              — class Dog(Animal):
//   attribute               — class Dog(pkg.Animal):
//   keyword_argument        — class Mixin(metaclass=ABCMeta):  (skip — not a base)
//   call                    — class C(SomeMixin()):  (rare; skip — not an own-source name)
function extractClassEdges(classNode) {
  const subName = nodeName(classNode);
  if (!subName) return [];
  const out = [];
  // The bases sit in a `superclasses` field on class_definition in
  // tree-sitter-python; older versions surface them as `argument_list`.
  // Try both.
  const sup = classNode.childForFieldName('superclasses')
            || classNode.namedChildren.find((c) => c.type === 'argument_list');
  if (!sup) return [];
  for (let i = 0; i < sup.namedChildCount; i++) {
    const child = sup.namedChild(i);
    if (child.type === 'keyword_argument') continue; // metaclass=, etc.
    let name = '';
    if (child.type === 'identifier') name = child.text;
    else if (child.type === 'attribute') {
      const last = child.namedChild(child.namedChildCount - 1);
      name = last ? last.text : '';
    }
    if (!name) continue;
    out.push({
      subtypeName: subName,
      supertypeName: name,
      edgeKind: 'extends',
      line: child.startPosition.row + 1,
      col:  child.startPosition.column,
    });
  }
  return out;
}

async function extractFromSource(source) {
  const parser = await getParser('python');
  const tree = parser.parse(source, null, {
    bufferSize: Math.max(32 * 1024, source.length + 32 * 1024),
  });

  const symbols = [];
  const references = [];
  const dispatchEdges = []; // not used in Python; left empty for shape parity
  const classEdges = [];
  const exportedNames = new Set();
  const enclosingStack = [];           // indexes into `symbols`
  const insideClassStack = [];         // booleans tracking whether inside class

  // Resolve a function_definition / class_definition that may be wrapped in
  // decorated_definition. Returns {def, decorated} where decorated is the
  // wrapper or null.
  function unwrap(node) {
    if (node.type === 'decorated_definition') {
      const inner = node.namedChildren.find((c) => SYMBOL_NODE_TYPES.has(c.type));
      return { def: inner || null, decorated: node };
    }
    if (SYMBOL_NODE_TYPES.has(node.type)) return { def: node, decorated: null };
    return { def: null, decorated: null };
  }

  function walk(node, depth = 0) {
    // If this node IS (or wraps) a definition, process it and recurse into
    // its body explicitly. Then return — the generic recursion below would
    // otherwise re-process the inner function_definition of a
    // decorated_definition wrapper, double-counting decorated symbols.
    if (node.type === 'decorated_definition' || SYMBOL_NODE_TYPES.has(node.type)) {
      const { def, decorated } = unwrap(node);
      if (def) {
        const name = nodeName(def);
        if (name) {
          const isInsideClass = insideClassStack[insideClassStack.length - 1] === true;
          const mods = detectModifiers(def);
          const decFlags = decorated
            ? decoratorFlags(decorated)
            : { isStatic: false, isGetter: false, isSetter: false, isClassMethod: false };
          let kind = kindFor(def, isInsideClass);
          if (kind === 'method' && decFlags.isGetter) kind = 'getter';
          if (kind === 'method' && decFlags.isSetter) kind = 'setter';
          symbols.push({
            name,
            kind,
            startLine: def.startPosition.row + 1,
            startCol:  def.startPosition.column,
            endLine:   def.endPosition.row + 1,
            endCol:    def.endPosition.column,
            isAsync: mods.isAsync,
            isGenerator: false,         // requires walking body for `yield`; v1 omits
            isStatic: !!decFlags.isStatic,
          });
          const sIdx = symbols.length - 1;
          // Python convention: top-level (depth 0) public names are
          // "exported." Underscore-prefixed names are conventionally private.
          if (depth === 0 && !name.startsWith('_')) {
            exportedNames.add(name);
          }

          if (def.type === 'class_definition') {
            for (const e of extractClassEdges(def)) classEdges.push(e);
            insideClassStack.push(true);
          } else {
            insideClassStack.push(false);
          }
          enclosingStack.push(sIdx);

          // Recurse into the body block (not the wrapper). For
          // class_definition the body holds method definitions; for
          // function_definition it holds the function statements (where
          // call expressions live). Nodes outside the body — decorators,
          // parameters, base classes — are inspected by their dedicated
          // helpers and don't need generic walk.
          const body = def.childForFieldName('body');
          if (body) walk(body, depth + 1);

          enclosingStack.pop();
          insideClassStack.pop();
        }
      }
      return;
    }

    // Capture call references at any depth. Caller is the innermost
    // enclosing definition on the stack (or null at module level).
    if (node.type === 'call') {
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

    // Generic recursion for non-definition nodes (statements, expressions).
    for (let i = 0; i < node.namedChildCount; i++) {
      walk(node.namedChild(i), depth);
    }
  }

  walk(tree.rootNode, 0);

  // Apply the export flag we tagged on the way in.
  for (const s of symbols) {
    s.isExported = exportedNames.has(s.name);
  }

  return { symbols, references, dispatchEdges, classEdges, exportedNames: [...exportedNames] };
}

module.exports = { extractFromSource };
