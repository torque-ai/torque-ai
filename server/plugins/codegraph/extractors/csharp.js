'use strict';

const { getParser } = require('../parser');

// C# type-defining declarations we surface as symbols. Each maps to a kind
// in the cg_symbols schema. struct/enum/record exist alongside class/interface.
const TYPE_DECLS = {
  'class_declaration':     'class',
  'interface_declaration': 'interface',
  'struct_declaration':    'struct',
  'record_declaration':    'record',
  'record_struct_declaration': 'record',
  'enum_declaration':      'enum',
};

// Member declarations inside a type's body that we also surface.
const MEMBER_DECLS = new Set([
  'method_declaration',
  'constructor_declaration',
  'destructor_declaration',
  'property_declaration',
  'operator_declaration',
  'conversion_operator_declaration',
  'indexer_declaration',
  'event_declaration',
]);

// Read modifier tokens (public/private/static/abstract/override/etc.) from a
// declaration. tree-sitter-c-sharp emits these as named children of type
// `modifier` with text equal to the keyword.
function modifiersOf(node) {
  const out = new Set();
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c.type === 'modifier') out.add(c.text);
  }
  return out;
}

// C# access conventions for "exported":
//   public  → exported
//   internal → exported within the assembly (we count it as exported for
//             cross-file impact analysis purposes)
//   protected → exposed to subclasses; treat as exported
//   private  → not exported
// Default access varies (class default is internal; class member default
// is private). Without full semantic analysis we approximate: anything
// without `private`/`file` modifiers is treated as exported.
function isExportedFromModifiers(mods) {
  if (mods.has('private') || mods.has('file')) return false;
  return true;
}

function declName(node) {
  const id = node.childForFieldName('name')
          || node.namedChildren.find((c) => c.type === 'identifier');
  return id ? id.text : '';
}

// Resolve a name from a base_list entry. The supertype can appear as:
//   identifier             — `: Animal`
//   qualified_name         — `: Some.Animal` (rightmost piece)
//   generic_name           — `: List<T>` (the head identifier)
//   primary_constructor_base_type — record D(...) : Base(...) — find the type name
function baseTypeName(node) {
  if (!node) return '';
  if (node.type === 'identifier') return node.text;
  if (node.type === 'qualified_name') {
    const last = node.namedChild(node.namedChildCount - 1);
    return last ? baseTypeName(last) : '';
  }
  if (node.type === 'generic_name') {
    const head = node.childForFieldName('name')
              || node.namedChildren.find((c) => c.type === 'identifier');
    return head ? head.text : '';
  }
  if (node.type === 'primary_constructor_base_type') {
    const t = node.childForFieldName('type') || node.namedChild(0);
    return baseTypeName(t);
  }
  return '';
}

function callTargetName(invNode) {
  const fn = invNode.childForFieldName('function')
          || invNode.namedChild(0);
  if (!fn) return '';
  if (fn.type === 'identifier') return fn.text;
  if (fn.type === 'member_access_expression') {
    // The accessed name is in the `name` field for newer grammar; fall back
    // to last named child (rightmost identifier).
    const name = fn.childForFieldName('name')
              || fn.namedChild(fn.namedChildCount - 1);
    return name && (name.type === 'identifier' || name.type === 'generic_name')
      ? (name.type === 'generic_name'
          ? (name.childForFieldName('name')?.text || name.namedChild(0)?.text || '')
          : name.text)
      : '';
  }
  if (fn.type === 'generic_name') {
    const id = fn.childForFieldName('name') || fn.namedChild(0);
    return id ? id.text : '';
  }
  return '';
}

// Walk a type declaration and emit class-edge records from its base_list.
// In C#, a class's base_list mixes its base class (always first) with any
// implemented interfaces; without cross-file knowledge of which names are
// interfaces we can't reliably distinguish them. We emit every base as an
// 'extends' edge — the BFS in cg_class_hierarchy still produces the right
// topology, just with the kind less specific than for TS class:interface.
function extractTypeEdges(typeNode, classEdges, interfaceNamesInFile) {
  const subName = declName(typeNode);
  if (!subName) return;
  const baseList = typeNode.namedChildren.find((c) => c.type === 'base_list');
  if (!baseList) return;
  for (let i = 0; i < baseList.namedChildCount; i++) {
    const supNode = baseList.namedChild(i);
    const supName = baseTypeName(supNode);
    if (!supName) continue;
    // Within-file disambiguation: if the supertype name is declared in this
    // file as an interface, surface as 'implements'. Cross-file consumers
    // can fall back to 'extends' resolution via cg_class_hierarchy.
    const edgeKind = interfaceNamesInFile.has(supName) ? 'implements' : 'extends';
    classEdges.push({
      subtypeName: subName,
      supertypeName: supName,
      edgeKind,
      line: supNode.startPosition.row + 1,
      col:  supNode.startPosition.column,
    });
  }
}

async function extractFromSource(source) {
  const parser = await getParser('csharp');
  const tree = parser.parse(source, null, {
    bufferSize: Math.max(32 * 1024, source.length + 32 * 1024),
  });

  // First pass: collect interface names so we can flip extends→implements
  // for in-file class:interface relationships. Cheap (one walk, no deep
  // parsing) and avoids guessing.
  const interfaceNamesInFile = new Set();
  (function preWalk(node) {
    if (node.type === 'interface_declaration') {
      const n = declName(node);
      if (n) interfaceNamesInFile.add(n);
    }
    for (let i = 0; i < node.namedChildCount; i++) preWalk(node.namedChild(i));
  })(tree.rootNode);

  const symbols = [];
  const references = [];
  const dispatchEdges = []; // C# switch expressions could populate this in future
  const classEdges = [];
  const exportedNames = new Set();
  const enclosingStack = [];
  const containingTypeStack = []; // names of class/struct/record/enum we're inside

  function pushSymbol(name, kind, node, mods, extra = {}) {
    symbols.push({
      name,
      kind,
      startLine: node.startPosition.row + 1,
      startCol:  node.startPosition.column,
      endLine:   node.endPosition.row + 1,
      endCol:    node.endPosition.column,
      isAsync:     mods.has('async'),
      isGenerator: false,
      isStatic:    mods.has('static'),
      ...extra,
    });
    if (isExportedFromModifiers(mods)) exportedNames.add(name);
    enclosingStack.push(symbols.length - 1);
  }

  function walk(node) {
    let pushedSymbol = false;
    let pushedTypeFrame = false;

    if (TYPE_DECLS[node.type]) {
      const name = declName(node);
      if (name) {
        const mods = modifiersOf(node);
        pushSymbol(name, TYPE_DECLS[node.type], node, mods);
        extractTypeEdges(node, classEdges, interfaceNamesInFile);
        containingTypeStack.push(name);
        pushedTypeFrame = true;
        pushedSymbol = true;
      }
    } else if (MEMBER_DECLS.has(node.type)) {
      // Constructor name is the containing type's name.
      let name;
      if (node.type === 'constructor_declaration') {
        name = declName(node) || containingTypeStack[containingTypeStack.length - 1] || '';
      } else if (node.type === 'destructor_declaration') {
        const id = node.namedChildren.find((c) => c.type === 'identifier');
        name = id ? `~${id.text}` : '';
      } else {
        name = declName(node);
      }
      if (name) {
        const mods = modifiersOf(node);
        let kind = 'method';
        if (node.type === 'constructor_declaration')        kind = 'constructor';
        else if (node.type === 'destructor_declaration')    kind = 'destructor';
        else if (node.type === 'property_declaration')      kind = 'property';
        else if (node.type === 'operator_declaration')      kind = 'operator';
        else if (node.type === 'conversion_operator_declaration') kind = 'operator';
        else if (node.type === 'indexer_declaration')       kind = 'indexer';
        else if (node.type === 'event_declaration')         kind = 'event';
        pushSymbol(name, kind, node, mods);
        pushedSymbol = true;
      }
    }

    if (node.type === 'invocation_expression') {
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
    if (pushedTypeFrame) containingTypeStack.pop();
  }

  walk(tree.rootNode);

  for (const s of symbols) {
    s.isExported = exportedNames.has(s.name);
  }

  return { symbols, references, dispatchEdges, classEdges, exportedNames: [...exportedNames] };
}

module.exports = { extractFromSource };
