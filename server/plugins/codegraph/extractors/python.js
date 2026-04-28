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

// Receiver of a member call: in `obj.foo()`, the receiver is `obj`.
// Returns '' for non-member calls or when the receiver is too complex
// (chained attributes, subscripts) to identify a single local name.
function callReceiverName(callNode) {
  const fn = callNode.childForFieldName('function');
  if (!fn || fn.type !== 'attribute') return '';
  // attribute's first named child is the object expression; second is the
  // attribute identifier. Only single-level objects yield a usable receiver.
  const obj = fn.namedChild(0);
  if (!obj) return '';
  if (obj.type === 'identifier') return obj.text;
  return '';
}

// Pull a usable type name out of a Python type annotation. tree-sitter-python
// surfaces annotations as a `type` node containing the actual expression.
//   x: Foo                  → 'Foo'
//   x: pkg.Foo              → 'Foo' (rightmost attribute)
//   x: List[Foo]            → 'List' (head, since Python's generics use [])
//   x: Optional[Foo]        → 'Optional' (head; 'Optional' specifically isn't
//                               useful but matching consumer convention)
// Returns '' on shapes too complex to commit to one type name.
function unwrapPythonTypeName(typeNode) {
  if (!typeNode) return '';
  // Annotations may be wrapped in a `type` node.
  let inner = typeNode;
  if (typeNode.type === 'type') {
    inner = typeNode.namedChild(0);
    if (!inner) return '';
  }
  if (inner.type === 'identifier') return inner.text;
  if (inner.type === 'attribute') {
    const last = inner.namedChild(inner.namedChildCount - 1);
    return last ? last.text : '';
  }
  if (inner.type === 'subscript') {
    // List[Foo], Optional[Foo] — head is what consumers can match against
    // class names. Generic-arg refinement is out of scope for v1.
    const head = inner.childForFieldName('value') || inner.namedChild(0);
    return head ? unwrapPythonTypeName(head) : '';
  }
  if (inner.type === 'generic_type') {
    // tree-sitter-python ≥0.23 surfaces List[Foo] as generic_type whose
    // first named child is the head identifier (List) and the rest are
    // type_parameter nodes. Pre-0.23 used `subscript` (handled above).
    const head = inner.namedChild(0);
    return head ? unwrapPythonTypeName(head) : '';
  }
  if (inner.type === 'string') return ''; // forward refs ('Foo') skipped for v1
  return '';
}

// Capitalized names heuristic for constructor inference. Python lacks the
// `new` keyword — `y = Animal()` is just a call. We treat a call to a
// capitalized identifier as a constructor under the standard PEP 8
// convention (class names are CapWords). Functions are snake_case.
function isLikelyClassName(text) {
  if (!text || text.length === 0) return false;
  const c = text.charCodeAt(0);
  return c >= 65 && c <= 90; // 'A'..'Z'
}

// Given a `parameters` node, emit cg_locals rows for typed parameters and
// for `self` (which inside a class body always has the type of the
// enclosing class).
function collectPythonParameterTypes(paramsNode, locals, scopeSymbolIndex, containerName) {
  for (let i = 0; i < paramsNode.namedChildCount; i++) {
    const param = paramsNode.namedChild(i);
    if (param.type === 'identifier') {
      // `self` (or `cls`) inside a method — bind to the containing class.
      if ((param.text === 'self' || param.text === 'cls') && containerName) {
        locals.push({
          localName: param.text,
          typeName: containerName,
          scopeSymbolIndex,
          line: param.startPosition.row + 1,
          col:  param.startPosition.column,
        });
      }
      continue;
    }
    if (param.type === 'typed_parameter' || param.type === 'typed_default_parameter') {
      const id = param.namedChildren.find((c) => c.type === 'identifier');
      const typeNode = param.namedChildren.find((c) => c.type === 'type');
      if (!id || !typeNode) continue;
      const typeName = unwrapPythonTypeName(typeNode);
      if (!typeName) continue;
      locals.push({
        localName: id.text,
        typeName,
        scopeSymbolIndex,
        line: param.startPosition.row + 1,
        col:  param.startPosition.column,
      });
    }
  }
}

// Annotated assignments + constructor inference. Shapes:
//   x: Foo = make()    → typed: x is Foo (type wins over inferred RHS)
//   y = Animal()       → constructor inference: y is Animal (PEP-8 CapWords)
//   z: Foo             → typed-only; no value
function extractPythonAssignmentLocal(assignNode, scopeSymbolIndex) {
  const left = assignNode.namedChild(0);
  if (!left || left.type !== 'identifier') return null;
  const localName = left.text;
  const line = assignNode.startPosition.row + 1;
  const col  = assignNode.startPosition.column;

  // Annotated form: namedChildren = [identifier, type, [value]]
  const typeNode = assignNode.namedChildren.find((c) => c.type === 'type');
  if (typeNode) {
    const t = unwrapPythonTypeName(typeNode);
    if (t) return { localName, typeName: t, scopeSymbolIndex, line, col };
  }

  // Constructor inference fallback: `y = Animal()` where Animal is a
  // capitalized identifier. tree-sitter-python's `assignment` field
  // accessor is `right`.
  const right = assignNode.childForFieldName('right')
             || assignNode.namedChild(assignNode.namedChildCount - 1);
  if (right && right.type === 'call') {
    const fn = right.childForFieldName('function');
    if (fn && fn.type === 'identifier' && isLikelyClassName(fn.text)) {
      return { localName, typeName: fn.text, scopeSymbolIndex, line, col };
    }
    if (fn && fn.type === 'attribute') {
      const last = fn.namedChild(fn.namedChildCount - 1);
      if (last && isLikelyClassName(last.text)) {
        return { localName, typeName: last.text, scopeSymbolIndex, line, col };
      }
    }
  }
  return null;
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

// Pull a dotted_name's full text (e.g., 'pkg.sub').
function dottedNameText(node) {
  if (!node) return '';
  if (node.type === 'identifier') return node.text;
  if (node.type === 'dotted_name') {
    return node.namedChildren.map((c) => c.text).join('.');
  }
  return node.text;
}

// Python import shapes:
//   import x               → (local=x,  module=x)
//   import x.y             → (local=x,  module=x.y)
//   import x as y          → (local=y,  module=x)
//   from x import foo      → (local=foo, module=x, name=foo)
//   from x import foo as f → (local=f,   module=x, name=foo)
//   from x import *        → not recorded (wildcard)
function extractImportsFromImportStatement(node) {
  const out = [];
  const line = node.startPosition.row + 1;
  const col  = node.startPosition.column;

  if (node.type === 'import_statement') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child.type === 'dotted_name') {
        const full = dottedNameText(child);
        const top = child.namedChild(0)?.text || full;
        out.push({ localName: top, sourceModule: full, sourceName: null, line, col });
      } else if (child.type === 'aliased_import') {
        const dn = child.namedChildren.find((c) => c.type === 'dotted_name');
        const id = child.namedChildren.find((c) => c.type === 'identifier');
        if (dn && id) {
          out.push({ localName: id.text, sourceModule: dottedNameText(dn), sourceName: null, line, col });
        }
      }
    }
    return out;
  }

  if (node.type === 'import_from_statement') {
    const mod = node.namedChildren.find((c) => c.type === 'dotted_name' || c.type === 'relative_import');
    if (!mod) return out;
    const moduleName = mod.type === 'relative_import' ? mod.text : dottedNameText(mod);
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child === mod) continue;
      if (child.type === 'wildcard_import') continue;
      if (child.type === 'dotted_name') {
        const name = dottedNameText(child);
        out.push({ localName: name, sourceModule: moduleName, sourceName: name, line, col });
      } else if (child.type === 'aliased_import') {
        const dn = child.namedChildren.find((c) => c.type === 'dotted_name');
        const id = child.namedChildren.find((c) => c.type === 'identifier');
        if (dn && id) {
          out.push({ localName: id.text, sourceModule: moduleName, sourceName: dottedNameText(dn), line, col });
        }
      }
    }
    return out;
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
  const imports = [];
  const locals = [];
  const exportedNames = new Set();
  const enclosingStack = [];           // indexes into `symbols`
  const insideClassStack = [];         // booleans tracking whether inside class
  const containerStack = [];           // names of enclosing classes (for method container_name)

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
          // Methods (kind=method/constructor/getter/setter) get container_name
          // from the enclosing class so cg_class_hierarchy + method-call
          // resolution can join on it.
          const isInsideClassNow = insideClassStack[insideClassStack.length - 1] === true;
          const containerName = isInsideClassNow && (kind === 'method' || kind === 'constructor' || kind === 'getter' || kind === 'setter')
            ? containerStack[containerStack.length - 1] || null
            : null;
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
            containerName,
          });
          const sIdx = symbols.length - 1;
          // Python convention: top-level (depth 0) public names are
          // "exported." Underscore-prefixed names are conventionally private.
          if (depth === 0 && !name.startsWith('_')) {
            exportedNames.add(name);
          }

          let pushedContainer = false;
          if (def.type === 'class_definition') {
            for (const e of extractClassEdges(def)) classEdges.push(e);
            insideClassStack.push(true);
            containerStack.push(name);
            pushedContainer = true;
          } else {
            insideClassStack.push(false);
          }
          enclosingStack.push(sIdx);

          // Capture parameter type bindings for the function/method body.
          // For methods, also bind self/cls to the containing class.
          if (def.type === 'function_definition') {
            const params = def.childForFieldName('parameters');
            if (params) {
              collectPythonParameterTypes(
                params,
                locals,
                sIdx,
                isInsideClassNow ? containerStack[containerStack.length - 1] : null,
              );
            }
          }

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
          if (pushedContainer) containerStack.pop();
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
          receiverName: callReceiverName(node) || null,
          line: node.startPosition.row + 1,
          col:  node.startPosition.column,
          callerSymbolIndex: enclosingStack[enclosingStack.length - 1] ?? null,
        });
      }
    }

    if (node.type === 'import_statement' || node.type === 'import_from_statement') {
      for (const imp of extractImportsFromImportStatement(node)) imports.push(imp);
    }

    // Annotated / inferred-constructor assignments → cg_locals rows.
    // assignment is the immediate child of expression_statement.
    if (node.type === 'assignment') {
      const local = extractPythonAssignmentLocal(
        node,
        enclosingStack[enclosingStack.length - 1] ?? null,
      );
      if (local) locals.push(local);
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

  return { symbols, references, dispatchEdges, classEdges, imports, locals, exportedNames: [...exportedNames] };
}

module.exports = { extractFromSource };
