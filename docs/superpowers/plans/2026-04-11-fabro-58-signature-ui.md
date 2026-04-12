# Fabro #58: Signature-Derived Input UIs (Windmill)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Parse a task or workflow's input `main` function signature (TypeScript type annotations or JSON Schema) and auto-generate a runnable input form in the dashboard. Authors can refine field titles, descriptions, enums, and resource types via JSDoc comments or a sidecar schema — but don't hand-build UI. Inspired by Windmill.

**Architecture:** A new `signature-parser.js` uses TypeScript's compiler API to inspect exported `main(args: Args)` or `run({foo, bar})` signatures and emit JSON Schema. A `schema-to-form.jsx` renders the schema as a React form with widgets per type. The form lives in the dashboard's task-launch modal and workflow-test panel. JSDoc `@title`, `@description`, `@enum`, `@format`, `@example` tags refine the inferred schema.

**Tech Stack:** Node.js, TypeScript compiler API (`typescript`), React + JSON Schema form widget (or custom). Builds on plans 1 (workflow-as-code), 23 (typed signatures).

---

## File Structure

**New files:**
- `server/signature/signature-parser.js`
- `server/signature/jsdoc-refiner.js`
- `server/tests/signature-parser.test.js`
- `server/tests/jsdoc-refiner.test.js`
- `dashboard/src/components/SchemaForm.jsx`
- `dashboard/src/components/SchemaField.jsx`

**Modified files:**
- `server/handlers/mcp-tools.js` — `get_task_signature`, `get_workflow_signature`
- `dashboard/src/views/TaskSubmit.jsx` — use SchemaForm instead of textarea

---

## Task 1: Signature parser

- [ ] **Step 1: Tests**

Create `server/tests/signature-parser.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { parseSignature } = require('../signature/signature-parser');

describe('parseSignature', () => {
  it('extracts basic scalar types', () => {
    const src = `export function main(args: { name: string; age: number; active: boolean }) { return args; }`;
    const schema = parseSignature(src);
    expect(schema.type).toBe('object');
    expect(schema.properties).toEqual({
      name: { type: 'string' },
      age: { type: 'number' },
      active: { type: 'boolean' },
    });
    expect(schema.required.sort()).toEqual(['active', 'age', 'name']);
  });

  it('marks optional fields correctly', () => {
    const src = `export function main(args: { name: string; nickname?: string }) { return args; }`;
    const schema = parseSignature(src);
    expect(schema.required).toEqual(['name']);
  });

  it('handles array types', () => {
    const src = `export function main(args: { tags: string[]; scores: number[] }) { return args; }`;
    const schema = parseSignature(src);
    expect(schema.properties.tags).toEqual({ type: 'array', items: { type: 'string' } });
    expect(schema.properties.scores).toEqual({ type: 'array', items: { type: 'number' } });
  });

  it('handles union enums (literal strings)', () => {
    const src = `export function main(args: { mode: 'fast' | 'slow' | 'balanced' }) { return args; }`;
    const schema = parseSignature(src);
    expect(schema.properties.mode).toEqual({ type: 'string', enum: ['fast', 'slow', 'balanced'] });
  });

  it('handles nested objects', () => {
    const src = `export function main(args: { user: { name: string; age: number } }) { return args; }`;
    const schema = parseSignature(src);
    expect(schema.properties.user).toEqual({
      type: 'object',
      properties: { name: { type: 'string' }, age: { type: 'number' } },
      required: ['age', 'name'],
    });
  });

  it('returns null when no main function exists', () => {
    expect(parseSignature(`const x = 1;`)).toBeNull();
  });

  it('accepts async main', () => {
    const src = `export async function main(args: { x: number }) { return args.x; }`;
    const schema = parseSignature(src);
    expect(schema.properties.x.type).toBe('number');
  });
});
```

- [ ] **Step 2: Implement**

Create `server/signature/signature-parser.js`:

```js
'use strict';
const ts = require('typescript');

function parseSignature(source, { fileName = 'input.ts', functionName = 'main' } = {}) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);

  let mainNode = null;
  function walk(node) {
    if (mainNode) return;
    if (ts.isFunctionDeclaration(node) && node.name?.text === functionName) {
      mainNode = node;
      return;
    }
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (decl.name?.text === functionName && decl.initializer) {
          if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
            mainNode = decl.initializer;
            return;
          }
        }
      }
    }
    ts.forEachChild(node, walk);
  }
  walk(sourceFile);

  if (!mainNode || mainNode.parameters.length === 0) return null;
  const firstParam = mainNode.parameters[0];
  return typeToSchema(firstParam.type);
}

function typeToSchema(typeNode) {
  if (!typeNode) return { type: 'object' };

  if (typeNode.kind === ts.SyntaxKind.StringKeyword)  return { type: 'string' };
  if (typeNode.kind === ts.SyntaxKind.NumberKeyword)  return { type: 'number' };
  if (typeNode.kind === ts.SyntaxKind.BooleanKeyword) return { type: 'boolean' };

  if (ts.isArrayTypeNode(typeNode)) {
    return { type: 'array', items: typeToSchema(typeNode.elementType) };
  }

  if (ts.isUnionTypeNode(typeNode)) {
    const literals = typeNode.types.filter(t => ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal));
    if (literals.length === typeNode.types.length) {
      return { type: 'string', enum: literals.map(t => t.literal.text) };
    }
  }

  if (ts.isTypeLiteralNode(typeNode)) {
    const properties = {};
    const required = [];
    for (const member of typeNode.members) {
      if (!ts.isPropertySignature(member) || !member.name) continue;
      const name = member.name.text || member.name.escapedText;
      properties[name] = typeToSchema(member.type);
      if (!member.questionToken) required.push(name);
    }
    const obj = { type: 'object', properties };
    if (required.length > 0) obj.required = required.sort();
    return obj;
  }

  return { type: 'object' };
}

module.exports = { parseSignature };
```

Run tests → PASS. Commit: `feat(signature): TypeScript signature → JSON Schema parser`.

---

## Task 2: JSDoc refiner

- [ ] **Step 1: Tests**

Create `server/tests/jsdoc-refiner.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { refineSchemaWithJsDoc } = require('../signature/jsdoc-refiner');

describe('refineSchemaWithJsDoc', () => {
  it('adds @title and @description to field', () => {
    const schema = { type: 'object', properties: { name: { type: 'string' } } };
    const src = `
      export function main(args: {
        /** @title User Name @description Display name of the user */
        name: string
      }) { return args; }`;
    const refined = refineSchemaWithJsDoc(schema, src);
    expect(refined.properties.name.title).toBe('User Name');
    expect(refined.properties.name.description).toBe('Display name of the user');
  });

  it('adds @format for strings', () => {
    const schema = { type: 'object', properties: { email: { type: 'string' } } };
    const src = `
      export function main(args: {
        /** @format email */
        email: string
      }) { return args; }`;
    const refined = refineSchemaWithJsDoc(schema, src);
    expect(refined.properties.email.format).toBe('email');
  });

  it('adds @example as default placeholder', () => {
    const schema = { type: 'object', properties: { port: { type: 'number' } } };
    const src = `
      export function main(args: {
        /** @example 8080 */
        port: number
      }) { return args; }`;
    const refined = refineSchemaWithJsDoc(schema, src);
    expect(refined.properties.port.default).toBe(8080);
  });

  it('no-op when no JSDoc comments exist', () => {
    const schema = { type: 'object', properties: { x: { type: 'number' } } };
    const src = `export function main(args: { x: number }) { return args; }`;
    const refined = refineSchemaWithJsDoc(schema, src);
    expect(refined).toEqual(schema);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/signature/jsdoc-refiner.js`:

```js
'use strict';
const ts = require('typescript');

// Parse JSDoc comments from parameter properties and overlay @title/@description/@format/@example
// onto an existing JSON Schema.
function refineSchemaWithJsDoc(schema, source) {
  const sf = ts.createSourceFile('input.ts', source, ts.ScriptTarget.Latest, true);
  let paramType = null;
  function walk(node) {
    if (paramType) return;
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'main' && node.parameters[0]?.type) {
      paramType = node.parameters[0].type;
      return;
    }
    ts.forEachChild(node, walk);
  }
  walk(sf);
  if (!paramType || !ts.isTypeLiteralNode(paramType)) return schema;

  const out = { ...schema, properties: { ...(schema.properties || {}) } };
  for (const member of paramType.members) {
    if (!ts.isPropertySignature(member) || !member.name) continue;
    const name = member.name.text || member.name.escapedText;
    if (!out.properties[name]) continue;

    const jsDocs = ts.getJSDocCommentsAndTags(member);
    for (const doc of jsDocs) {
      if (!doc.tags) continue;
      for (const tag of doc.tags) {
        const tagName = tag.tagName.text;
        const text = typeof tag.comment === 'string' ? tag.comment : (tag.comment || []).map(c => c.text || '').join('');
        if (tagName === 'title')       out.properties[name].title = text.trim();
        if (tagName === 'description') out.properties[name].description = text.trim();
        if (tagName === 'format')      out.properties[name].format = text.trim();
        if (tagName === 'example') {
          const v = text.trim();
          out.properties[name].default = isNumeric(v) ? Number(v) : v;
        }
      }
    }
  }
  return out;
}

function isNumeric(s) { return !isNaN(parseFloat(s)) && isFinite(s); }

module.exports = { refineSchemaWithJsDoc };
```

Run tests → PASS. Commit: `feat(signature): JSDoc refiner for title/description/format/example`.

---

## Task 3: Dashboard SchemaForm + MCP tools

- [ ] **Step 1: MCP tool defs + handler**

In `server/tool-defs/`:

```js
get_task_signature: {
  description: 'Given a TypeScript source file or inline source, return a JSON Schema describing its main() args. Useful for generating input forms before task submission.',
  inputSchema: {
    type: 'object',
    oneOf: [
      { required: ['file_path'], properties: { file_path: {type:'string'} } },
      { required: ['source'], properties: { source: {type:'string'} } },
    ],
  },
},
```

Handler:

```js
case 'get_task_signature': {
  const { parseSignature } = require('../signature/signature-parser');
  const { refineSchemaWithJsDoc } = require('../signature/jsdoc-refiner');
  const source = args.source || require('fs').readFileSync(args.file_path, 'utf8');
  const base = parseSignature(source);
  if (!base) return { schema: null, error: 'no main(args) signature found' };
  return { schema: refineSchemaWithJsDoc(base, source) };
}
```

- [ ] **Step 2: SchemaField + SchemaForm components**

Create `dashboard/src/components/SchemaField.jsx`:

```jsx
export default function SchemaField({ name, schema, value, onChange, required }) {
  const label = schema.title || name;
  const desc = schema.description;

  if (schema.enum) {
    return (
      <div className="mb-3">
        <label className="block text-sm font-medium">{label}{required && ' *'}</label>
        <select value={value ?? ''} onChange={e => onChange(e.target.value)} className="border rounded px-2 py-1 w-full">
          {!required && <option value=""></option>}
          {schema.enum.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
        {desc && <p className="text-xs text-gray-500 mt-1">{desc}</p>}
      </div>
    );
  }

  if (schema.type === 'boolean') {
    return (
      <div className="mb-3">
        <label className="inline-flex items-center"><input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} /> <span className="ml-2 text-sm">{label}</span></label>
        {desc && <p className="text-xs text-gray-500 mt-1">{desc}</p>}
      </div>
    );
  }

  if (schema.type === 'number') {
    return (
      <div className="mb-3">
        <label className="block text-sm font-medium">{label}{required && ' *'}</label>
        <input type="number" value={value ?? schema.default ?? ''} onChange={e => onChange(e.target.value === '' ? undefined : Number(e.target.value))} className="border rounded px-2 py-1 w-full" />
        {desc && <p className="text-xs text-gray-500 mt-1">{desc}</p>}
      </div>
    );
  }

  if (schema.type === 'array' && schema.items?.type === 'string') {
    return (
      <div className="mb-3">
        <label className="block text-sm font-medium">{label}{required && ' *'}</label>
        <input placeholder="comma-separated" value={(value || []).join(', ')} onChange={e => onChange(e.target.value.split(',').map(s => s.trim()).filter(Boolean))} className="border rounded px-2 py-1 w-full" />
        {desc && <p className="text-xs text-gray-500 mt-1">{desc}</p>}
      </div>
    );
  }

  return (
    <div className="mb-3">
      <label className="block text-sm font-medium">{label}{required && ' *'}</label>
      <input type={schema.format === 'email' ? 'email' : 'text'} value={value ?? schema.default ?? ''} onChange={e => onChange(e.target.value)} className="border rounded px-2 py-1 w-full" />
      {desc && <p className="text-xs text-gray-500 mt-1">{desc}</p>}
    </div>
  );
}
```

Create `dashboard/src/components/SchemaForm.jsx`:

```jsx
import { useState } from 'react';
import SchemaField from './SchemaField';

export default function SchemaForm({ schema, onSubmit }) {
  const [values, setValues] = useState({});
  const required = new Set(schema.required || []);

  function submit(e) {
    e.preventDefault();
    for (const r of required) {
      if (values[r] === undefined || values[r] === '') { alert(`${r} is required`); return; }
    }
    onSubmit(values);
  }

  return (
    <form onSubmit={submit} className="max-w-lg">
      {Object.entries(schema.properties || {}).map(([name, fieldSchema]) => (
        <SchemaField
          key={name} name={name} schema={fieldSchema}
          value={values[name]} onChange={v => setValues(s => ({...s, [name]: v}))}
          required={required.has(name)}
        />
      ))}
      <button type="submit" className="px-3 py-1 bg-blue-600 text-white rounded">Submit</button>
    </form>
  );
}
```

- [ ] **Step 3: Wire into task-submit view**

In `dashboard/src/views/TaskSubmit.jsx`: when a task template has a source file, call `get_task_signature`, render `<SchemaForm>`. On submit, pass values as `additional_input` to the submit task call.

`await_restart`. Smoke: upload a TypeScript file with `main(args: { name: string; age: number })`. Confirm the form appears with 2 fields. Submit, confirm the values reach the task.

Commit: `feat(signature): dashboard SchemaForm + MCP get_task_signature`.
