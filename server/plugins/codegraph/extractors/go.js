'use strict';

const { getParser } = require('../parser');


// Go convention: a capitalized first letter means exported (visible outside
// the package). Lowercase = package-private.
function isExportedName(name) {
  if (!name) return false;
  const c = name.charCodeAt(0);
  return c >= 65 && c <= 90; // 'A'..'Z'
}

// Resolve the receiver type for a method_declaration:
//   func (d *Dog) Bark()      → 'Dog'
//   func (d Dog) Bark()       → 'Dog'
//   func (d *pkg.Dog) Bark()  → 'Dog' (drop the package qualifier)
function methodReceiverType(methodNode) {
  // First parameter_list under method_declaration is the receiver.
  const lists = methodNode.namedChildren.filter((c) => c.type === 'parameter_list');
  if (lists.length === 0) return '';
  const recv = lists[0].namedChildren.find((c) => c.type === 'parameter_declaration');
  if (!recv) return '';
  const t = recv.childForFieldName('type') || recv.namedChildren.find((c) => c.type !== 'identifier');
  return typeName(t);
}

// Pull a usable type name out of an arbitrary type node:
//   type_identifier        → its text ("Dog")
//   pointer_type           → recurse on inner element
//   qualified_type         → use the rightmost identifier (the type, not the pkg)
//   generic_type           → recurse on the underlying name
function typeName(node) {
  if (!node) return '';
  if (node.type === 'type_identifier') return node.text;
  if (node.type === 'identifier') return node.text;
  if (node.type === 'pointer_type') {
    const inner = node.namedChild(0);
    return typeName(inner);
  }
  if (node.type === 'qualified_type') {
    // pkg.Dog: namedChildren are [package_identifier, type_identifier]
    const last = node.namedChild(node.namedChildCount - 1);
    return last ? last.text : '';
  }
  if (node.type === 'generic_type') {
    const head = node.namedChild(0);
    return typeName(head);
  }
  return '';
}

function methodName(methodNode) {
  const fid = methodNode.namedChildren.find((c) => c.type === 'field_identifier');
  return fid ? fid.text : '';
}

function functionName(node) {
  const id = node.childForFieldName('name')
          || node.namedChildren.find((c) => c.type === 'identifier');
  return id ? id.text : '';
}

function callTargetName(callNode) {
  const fn = callNode.childForFieldName('function');
  if (!fn) return '';
  if (fn.type === 'identifier') return fn.text;
  if (fn.type === 'selector_expression') {
    // x.y.Foo() → 'Foo' (rightmost field_identifier)
    const last = fn.namedChild(fn.namedChildCount - 1);
    return last && last.type === 'field_identifier' ? last.text : '';
  }
  return '';
}

// Receiver of a member call: in `obj.Foo()`, the receiver is `obj`. Returns
// '' when the receiver isn't a single identifier (chained selectors,
// function-call receivers, package-qualified calls like `pkg.Foo()` —
// the last is treated as a package call rather than a method call here).
function callReceiverName(callNode) {
  const fn = callNode.childForFieldName('function');
  if (!fn || fn.type !== 'selector_expression') return '';
  const obj = fn.namedChild(0);
  if (!obj || obj.type !== 'identifier') return '';
  return obj.text;
}

// Capture local variable type bindings from Go declarations:
//   var a *Dog                  → a : Dog
//   var a Dog                   → a : Dog
//   b := &Dog{}                 → b : Dog (constructor inference)
//   c := Dog{}                  → c : Dog (composite literal)
//   d := f()                    → no binding (return type unknown without
//                                  cross-call type tracking)
function extractGoLocalsFromVarSpec(specNode, scopeSymbolIndex) {
  const out = [];
  // var_spec can declare multiple names: `var a, b *Dog`. Walk the type
  // child once and bind every preceding identifier to it.
  const ids = specNode.namedChildren.filter((c) => c.type === 'identifier');
  const typeNode = specNode.namedChildren.find((c) =>
    c.type === 'type_identifier' || c.type === 'pointer_type'
       || c.type === 'qualified_type' || c.type === 'generic_type'
  );
  if (!typeNode) return out;
  const t = typeName(typeNode);
  if (!t) return out;
  for (const id of ids) {
    out.push({
      localName: id.text,
      typeName: t,
      scopeSymbolIndex,
      line: id.startPosition.row + 1,
      col:  id.startPosition.column,
    });
  }
  return out;
}

function extractGoLocalsFromShortDecl(declNode, scopeSymbolIndex) {
  const out = [];
  // short_var_declaration shape:
  //   expression_list (LHS identifiers) + expression_list (RHS values)
  // Per-binding RHS inference for composite literals only.
  const lists = declNode.namedChildren.filter((c) => c.type === 'expression_list');
  if (lists.length !== 2) return out;
  const lhs = lists[0].namedChildren;
  const rhs = lists[1].namedChildren;
  for (let i = 0; i < lhs.length && i < rhs.length; i++) {
    if (lhs[i].type !== 'identifier') continue;
    const localName = lhs[i].text;
    let value = rhs[i];
    // &Dog{} → unary_expression wrapping composite_literal
    if (value && value.type === 'unary_expression') value = value.namedChild(0);
    if (!value || value.type !== 'composite_literal') continue;
    const tNode = value.childForFieldName('type')
               || value.namedChildren.find((c) =>
                    c.type === 'type_identifier' || c.type === 'qualified_type'
                       || c.type === 'pointer_type' || c.type === 'generic_type');
    const t = typeName(tNode);
    if (!t) continue;
    out.push({
      localName, typeName: t, scopeSymbolIndex,
      line: lhs[i].startPosition.row + 1,
      col:  lhs[i].startPosition.column,
    });
  }
  return out;
}

// Function/method parameter list → typed locals scoped to the function's
// symbol id. Receiver parameters are handled separately by method_declaration
// since they bind to the containing struct/interface.
function collectGoParameterTypes(paramListNode, locals, scopeSymbolIndex) {
  for (let i = 0; i < paramListNode.namedChildCount; i++) {
    const param = paramListNode.namedChild(i);
    if (param.type !== 'parameter_declaration') continue;
    const ids = param.namedChildren.filter((c) => c.type === 'identifier');
    const tNode = param.namedChildren.find((c) =>
      c.type === 'type_identifier' || c.type === 'pointer_type'
         || c.type === 'qualified_type' || c.type === 'generic_type'
    );
    const t = typeName(tNode);
    if (!t) continue;
    for (const id of ids) {
      locals.push({
        localName: id.text, typeName: t, scopeSymbolIndex,
        line: id.startPosition.row + 1,
        col:  id.startPosition.column,
      });
    }
  }
}

// Extract symbols + class edges from a type_declaration. type_declaration
// has one or more type_spec children — each defines a named type. We surface
// each as a symbol (kind='struct'|'interface'|'type') and walk struct/iface
// bodies for embedded types (Go's structural form of inheritance).
function extractTypeDeclaration(typeDeclNode, symbols, classEdges, exportedNames) {
  for (let i = 0; i < typeDeclNode.namedChildCount; i++) {
    const spec = typeDeclNode.namedChild(i);
    if (spec.type !== 'type_spec') continue;
    const nameNode = spec.namedChildren.find((c) => c.type === 'type_identifier');
    if (!nameNode) continue;
    const name = nameNode.text;

    const body = spec.namedChildren.find((c) =>
      c.type === 'struct_type' || c.type === 'interface_type'
    );

    let kind = 'type';
    if (body && body.type === 'struct_type') kind = 'struct';
    else if (body && body.type === 'interface_type') kind = 'interface';

    symbols.push({
      name,
      kind,
      startLine: spec.startPosition.row + 1,
      startCol:  spec.startPosition.column,
      endLine:   spec.endPosition.row + 1,
      endCol:    spec.endPosition.column,
      isAsync: false,
      isGenerator: false,
      isStatic: false,
    });
    if (isExportedName(name)) exportedNames.add(name);

    if (!body) continue;
    if (body.type === 'interface_type') {
      // Embedded interfaces appear as `type_elem` children in newer grammars
      // and `constraint_elem` in the WASM grammar bundled by tree-sitter-wasms.
      // Each represents an extends edge: this interface includes the methods
      // of the embedded interface.
      for (let j = 0; j < body.namedChildCount; j++) {
        const elem = body.namedChild(j);
        if (elem.type !== 'type_elem' && elem.type !== 'constraint_elem') continue;
        const supName = typeName(elem.namedChild(0));
        if (!supName) continue;
        classEdges.push({
          subtypeName: name,
          supertypeName: supName,
          edgeKind: 'extends',
          line: elem.startPosition.row + 1,
          col:  elem.startPosition.column,
        });
      }
    } else if (body.type === 'struct_type') {
      // Embedded fields = anonymous fields = field_declaration with no
      // field_identifier child, only a type. Surface those as 'extends'
      // edges (Go's de-facto structural inheritance — promoted methods).
      const fields = body.namedChildren.find((c) => c.type === 'field_declaration_list');
      if (!fields) continue;
      for (let j = 0; j < fields.namedChildCount; j++) {
        const fd = fields.namedChild(j);
        if (fd.type !== 'field_declaration') continue;
        const hasName = fd.namedChildren.some((c) => c.type === 'field_identifier');
        if (hasName) continue;
        // Anonymous field — its only child is the type.
        const supName = typeName(fd.namedChildren.find((c) =>
          c.type === 'type_identifier' || c.type === 'pointer_type' || c.type === 'qualified_type'
        ));
        if (!supName) continue;
        classEdges.push({
          subtypeName: name,
          supertypeName: supName,
          edgeKind: 'extends',
          line: fd.startPosition.row + 1,
          col:  fd.startPosition.column,
        });
      }
    }
  }
}

// Read a Go interpreted_string_literal's raw payload (drops the quotes).
function readGoString(node) {
  if (!node || node.type !== 'interpreted_string_literal') return '';
  const t = node.text;
  if (t.length >= 2 && t[0] === '"') return t.slice(1, -1);
  return t;
}

// Go import shapes:
//   import "fmt"            → (local='fmt', module='fmt', name=null)
//   import f "fmt"          → (local='f',   module='fmt', name=null)
//   import . "fmt"          → skipped (dot import — names merged into current scope)
//   import _ "fmt"          → skipped (blank import; runs init only)
//   Default local for bare import is the last path component:
//   `encoding/json` → `json`.
function extractImportsFromImportSpec(specNode, line, col) {
  const out = [];
  const stringNode = specNode.namedChildren.find((c) => c.type === 'interpreted_string_literal');
  const aliasNode  = specNode.namedChildren.find((c) =>
    c.type === 'package_identifier' || c.type === 'blank_identifier' || c.type === 'dot'
  );
  const sourceModule = readGoString(stringNode);
  if (!sourceModule) return out;
  if (aliasNode && (aliasNode.type === 'blank_identifier' || aliasNode.type === 'dot')) return out;

  let localName;
  if (aliasNode && aliasNode.type === 'package_identifier') {
    localName = aliasNode.text;
  } else {
    const parts = sourceModule.split('/');
    localName = parts[parts.length - 1];
  }
  out.push({ localName, sourceModule, sourceName: null, line, col });
  return out;
}

function extractImportsFromImportDeclaration(node) {
  const out = [];
  const line = node.startPosition.row + 1;
  const col  = node.startPosition.column;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child.type === 'import_spec') {
      for (const imp of extractImportsFromImportSpec(child, line, col)) out.push(imp);
    } else if (child.type === 'import_spec_list') {
      for (let j = 0; j < child.namedChildCount; j++) {
        const spec = child.namedChild(j);
        if (spec.type === 'import_spec') {
          for (const imp of extractImportsFromImportSpec(spec, spec.startPosition.row + 1, spec.startPosition.column)) {
            out.push(imp);
          }
        }
      }
    }
  }
  return out;
}

async function extractFromSource(source) {
  const parser = await getParser('go');
  const tree = parser.parse(source, null, {
    bufferSize: Math.max(32 * 1024, source.length + 32 * 1024),
  });

  const symbols = [];
  const references = [];
  const dispatchEdges = []; // not used for Go (no switch-case-as-handler-table convention)
  const classEdges = [];
  const imports = [];
  const locals = [];
  const exportedNames = new Set();
  const enclosingStack = [];

  function walk(node) {
    let pushedSymbol = false;

    if (node.type === 'function_declaration') {
      const name = functionName(node);
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
        });
        if (isExportedName(name)) exportedNames.add(name);
        enclosingStack.push(symbols.length - 1);
        pushedSymbol = true;
        // Capture parameter type bindings for the function body.
        const params = node.namedChildren.find((c) => c.type === 'parameter_list');
        if (params) collectGoParameterTypes(params, locals, symbols.length - 1);
      }
    } else if (node.type === 'method_declaration') {
      const name = methodName(node);
      if (name) {
        const recv = methodReceiverType(node);
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
          // containerName matches the receiver type — the schema's standard
          // way to record "this method belongs to this type". receiverType
          // (extractor-side) and container_name (DB-side) are the same value
          // for Go.
          containerName: recv || null,
          receiverType: recv,
        });
        if (isExportedName(name)) exportedNames.add(name);
        enclosingStack.push(symbols.length - 1);
        pushedSymbol = true;
        const sIdx = symbols.length - 1;
        // Bind the receiver parameter to the containing type so calls like
        // `d.OtherMethod()` inside a method body can resolve via cg_locals.
        const lists = node.namedChildren.filter((c) => c.type === 'parameter_list');
        if (lists.length > 0 && recv) {
          const recvParam = lists[0].namedChildren.find((c) => c.type === 'parameter_declaration');
          if (recvParam) {
            const id = recvParam.namedChildren.find((c) => c.type === 'identifier');
            if (id) {
              locals.push({
                localName: id.text, typeName: recv, scopeSymbolIndex: sIdx,
                line: recvParam.startPosition.row + 1,
                col:  recvParam.startPosition.column,
              });
            }
          }
          // The second parameter_list is the actual method parameters.
          if (lists.length > 1) collectGoParameterTypes(lists[1], locals, sIdx);
        }
      }
    } else if (node.type === 'type_declaration') {
      extractTypeDeclaration(node, symbols, classEdges, exportedNames);
      // type_declaration's children don't contain function bodies — no need
      // to push an enclosing-stack frame for them.
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

    if (node.type === 'import_declaration') {
      for (const imp of extractImportsFromImportDeclaration(node)) imports.push(imp);
    }

    if (node.type === 'var_declaration') {
      // Each var_spec inside is a binding group — `var (a int; b *Dog)` etc.
      for (let i = 0; i < node.namedChildCount; i++) {
        const spec = node.namedChild(i);
        if (spec.type !== 'var_spec') continue;
        for (const l of extractGoLocalsFromVarSpec(spec, enclosingStack[enclosingStack.length - 1] ?? null)) {
          locals.push(l);
        }
      }
    }
    if (node.type === 'short_var_declaration') {
      for (const l of extractGoLocalsFromShortDecl(node, enclosingStack[enclosingStack.length - 1] ?? null)) {
        locals.push(l);
      }
    }

    for (let i = 0; i < node.namedChildCount; i++) {
      walk(node.namedChild(i));
    }

    if (pushedSymbol) enclosingStack.pop();
  }

  walk(tree.rootNode);

  for (const s of symbols) {
    s.isExported = exportedNames.has(s.name);
  }

  return { symbols, references, dispatchEdges, classEdges, imports, locals, exportedNames: [...exportedNames] };
}

module.exports = { extractFromSource };
