'use strict';

const { getParser } = require('../parser');

// Top-level Go declarations we capture as symbols. method_declaration is
// special — its name lives in `field_identifier`, not `identifier`, and we
// also need the receiver type so cg_class_hierarchy / cg_find_references
// can attribute the method to its struct.
const SYMBOL_NODE_TYPES = new Set([
  'function_declaration',
  'method_declaration',
  // type_declaration wraps type_spec(s); we look one level in.
]);

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
      // Embedded interfaces appear as `type_elem` children. Each represents
      // an extends edge: this interface includes the methods of the embedded.
      for (let j = 0; j < body.namedChildCount; j++) {
        const elem = body.namedChild(j);
        if (elem.type !== 'type_elem') continue;
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

async function extractFromSource(source) {
  const parser = await getParser('go');
  const tree = parser.parse(source, null, {
    bufferSize: Math.max(32 * 1024, source.length + 32 * 1024),
  });

  const symbols = [];
  const references = [];
  const dispatchEdges = []; // not used for Go (no switch-case-as-handler-table convention)
  const classEdges = [];
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
      }
    } else if (node.type === 'method_declaration') {
      const name = methodName(node);
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
          // Receiver type lives in `receiverType` so consumers can scope
          // symbol lookups to the owning struct. Doesn't affect the schema
          // (no column for it yet) but available on the extractor's output.
          receiverType: methodReceiverType(node),
        });
        if (isExportedName(name)) exportedNames.add(name);
        enclosingStack.push(symbols.length - 1);
        pushedSymbol = true;
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
          line: node.startPosition.row + 1,
          col:  node.startPosition.column,
          callerSymbolIndex: enclosingStack[enclosingStack.length - 1] ?? null,
        });
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

  return { symbols, references, dispatchEdges, classEdges, exportedNames: [...exportedNames] };
}

module.exports = { extractFromSource };
