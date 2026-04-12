# Fabro #93: Accessibility-Tree Browser Tool (Browser Use)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Upgrade TORQUE's `peek_ui` + research stage (Plan 48) with **accessibility-tree-first** page state — agent sees a labeled, indexed list of interactive elements instead of raw HTML or screenshots. High-level action primitives (`click`, `input`, `extract`, `scroll`, `switch_tab`). Vision fallback only when DOM isn't enough. Multi-tab + authenticated sessions via saved Playwright storage state. Inspired by Browser Use.

**Architecture:** A new `server/browser-agent/` module sits above Playwright:
- `ax-state.js` — builds `{ url, title, elements: [{ index, role, name, selector, visible, enabled }] }` from DOM + AX tree
- `actions.js` — compact action primitives (click/input/scroll/extract/switch_tab/close_tab)
- `session.js` — manages tabs + storage state files for auth persistence
- `vision-fallback.js` — optional screenshot pass when AX state is ambiguous

MCP tools expose each action. `browser_get_state` returns the AX view.

**Tech Stack:** Node.js, Playwright, existing peek_ui infra. Builds on plans 48 (research), 74 (Firecrawl), 75 (sandbox).

---

## File Structure

**New files:**
- `server/browser-agent/ax-state.js`
- `server/browser-agent/actions.js`
- `server/browser-agent/session.js`
- `server/browser-agent/vision-fallback.js`
- `server/tests/ax-state.test.js`
- `server/tests/actions.test.js`
- `server/tests/session.test.js`

**Modified files:**
- `server/handlers/mcp-tools.js` — `browser_get_state`, `browser_click`, `browser_input`, `browser_extract`, `browser_switch_tab`, `browser_save_auth`, `browser_load_auth`

---

## Task 1: AX state builder

- [ ] **Step 1: Tests**

Create `server/tests/ax-state.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { buildAxState, filterInteractive } = require('../browser-agent/ax-state');

describe('filterInteractive', () => {
  it('keeps button + link + input + textbox nodes', () => {
    const nodes = [
      { role: 'button', name: 'Click me' },
      { role: 'link', name: 'Home' },
      { role: 'textbox', name: 'Email' },
      { role: 'paragraph', name: 'not interactive' },
      { role: 'StaticText', name: 'also skip' },
    ];
    const kept = filterInteractive(nodes);
    expect(kept.map(n => n.role)).toEqual(['button', 'link', 'textbox']);
  });

  it('drops nodes with no accessible name unless they are inputs', () => {
    const nodes = [
      { role: 'button', name: '' },
      { role: 'textbox', name: '', placeholder: 'Enter email' },
      { role: 'link', name: 'OK' },
    ];
    const kept = filterInteractive(nodes);
    expect(kept.map(n => n.role)).toEqual(['textbox', 'link']);
  });

  it('skips invisible or disabled nodes', () => {
    const nodes = [
      { role: 'button', name: 'Hidden', visible: false },
      { role: 'button', name: 'Disabled', disabled: true },
      { role: 'button', name: 'Active' },
    ];
    const kept = filterInteractive(nodes);
    expect(kept.map(n => n.name)).toEqual(['Active']);
  });
});

describe('buildAxState (pure transformation)', () => {
  it('assigns indexes + role-based selector hints', () => {
    const raw = {
      url: 'https://example.com', title: 'Example',
      nodes: [
        { role: 'button', name: 'Submit', backendNodeId: 10 },
        { role: 'textbox', name: 'Email', backendNodeId: 11 },
      ],
    };
    const state = buildAxState(raw);
    expect(state.url).toBe('https://example.com');
    expect(state.elements[0].index).toBe(0);
    expect(state.elements[0].role).toBe('button');
    expect(state.elements[0].selector).toContain('button');
  });

  it('truncates long names but keeps index stable', () => {
    const raw = {
      url: 'x', title: 'y',
      nodes: [{ role: 'button', name: 'a'.repeat(500) }],
    };
    const state = buildAxState(raw);
    expect(state.elements[0].name.length).toBeLessThanOrEqual(200);
  });

  it('returns empty elements list for empty input', () => {
    const state = buildAxState({ url: 'x', title: 'y', nodes: [] });
    expect(state.elements).toEqual([]);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/browser-agent/ax-state.js`:

```js
'use strict';

const INTERACTIVE_ROLES = new Set(['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox', 'menuitem', 'tab', 'slider', 'option', 'searchbox']);

function filterInteractive(nodes) {
  return nodes.filter(n => {
    if (!INTERACTIVE_ROLES.has(n.role)) return false;
    if (n.visible === false) return false;
    if (n.disabled === true) return false;
    // Inputs may have an empty accessible name if they have a placeholder.
    const isInput = n.role === 'textbox' || n.role === 'searchbox' || n.role === 'combobox';
    if (!isInput && !n.name) return false;
    return true;
  });
}

function buildAxState({ url, title, nodes = [] }) {
  const kept = filterInteractive(nodes);
  const elements = kept.map((n, idx) => ({
    index: idx,
    role: n.role,
    name: (n.name || n.placeholder || '').slice(0, 200),
    selector: buildSelectorHint(n),
    visible: n.visible !== false,
    enabled: !n.disabled,
    backend_id: n.backendNodeId || null,
  }));
  return { url, title, elements };
}

function buildSelectorHint(node) {
  // Approximate a Playwright-friendly selector. The actual resolution happens
  // on the page via Playwright's getByRole when we re-bind the element.
  const name = node.name || node.placeholder || '';
  return `role=${node.role}${name ? `[name="${name.slice(0, 60).replace(/"/g, '\\"')}"]` : ''}`;
}

module.exports = { buildAxState, filterInteractive, INTERACTIVE_ROLES };
```

Run tests → PASS. Commit: `feat(browser): AX state builder filters to interactive labeled elements`.

---

## Task 2: Actions + session

- [ ] **Step 1: Actions tests**

Create `server/tests/actions.test.js`:

```js
'use strict';
const { describe, it, expect, vi } = require('vitest');
const { createActions } = require('../browser-agent/actions');

describe('actions', () => {
  let pageMock;
  beforeEach(() => {
    pageMock = {
      getByRole: vi.fn(() => ({ click: vi.fn(async () => {}), fill: vi.fn(async () => {}) })),
      locator: vi.fn(() => ({ first: () => ({ click: vi.fn(async () => {}), scrollIntoViewIfNeeded: vi.fn() }) })),
      evaluate: vi.fn(async () => 'extracted'),
      url: () => 'https://example.com',
    };
  });

  it('click uses Playwright getByRole with the element name', async () => {
    const a = createActions({ page: pageMock });
    await a.click({ role: 'button', name: 'Submit' });
    expect(pageMock.getByRole).toHaveBeenCalledWith('button', { name: 'Submit' });
  });

  it('input fills the matching field', async () => {
    const getByRole = pageMock.getByRole;
    const fill = vi.fn(async () => {});
    getByRole.mockReturnValue({ fill });
    const a = createActions({ page: pageMock });
    await a.input({ role: 'textbox', name: 'Email', value: 'alice@example.com' });
    expect(fill).toHaveBeenCalledWith('alice@example.com');
  });

  it('extract runs a selector + returns text', async () => {
    const a = createActions({ page: pageMock });
    const text = await a.extract({ selector: 'article' });
    expect(pageMock.evaluate).toHaveBeenCalled();
    expect(text).toBe('extracted');
  });

  it('scroll accepts direction keyword', async () => {
    const a = createActions({ page: pageMock });
    await a.scroll({ direction: 'down', amount: 500 });
    expect(pageMock.evaluate).toHaveBeenCalled();
  });

  it('unknown action throws', async () => {
    const a = createActions({ page: pageMock });
    await expect(a.run({ type: 'bogus' })).rejects.toThrow(/unknown action/i);
  });
});
```

(Note: pageMock / vi.fn pattern shown. Replace pageMock.evaluate with a specific selector text in real impl.)

- [ ] **Step 2: Implement**

Create `server/browser-agent/actions.js`:

```js
'use strict';

function createActions({ page }) {
  async function click({ role, name, selector }) {
    const locator = selector ? page.locator(selector).first() : page.getByRole(role, { name });
    await locator.click();
    return { ok: true, url: page.url() };
  }

  async function input({ role, name, value, selector }) {
    const locator = selector ? page.locator(selector).first() : page.getByRole(role, { name });
    await locator.fill(value);
    return { ok: true };
  }

  async function scroll({ direction = 'down', amount = 500 }) {
    const dy = direction === 'up' ? -amount : amount;
    await page.evaluate(({ dy }) => window.scrollBy(0, dy), { dy });
    return { ok: true };
  }

  async function extract({ selector, limit = 5000 }) {
    const text = await page.evaluate(({ selector, limit }) => {
      const nodes = document.querySelectorAll(selector);
      return Array.from(nodes).map(n => n.textContent || '').join('\n').slice(0, limit);
    }, { selector, limit });
    return text;
  }

  async function goto({ url }) { await page.goto(url); return { ok: true, url: page.url() }; }

  async function run(action) {
    if (action.type === 'click')    return click(action);
    if (action.type === 'input')    return input(action);
    if (action.type === 'scroll')   return scroll(action);
    if (action.type === 'extract')  return { text: await extract(action) };
    if (action.type === 'goto')     return goto(action);
    throw new Error(`unknown action type: ${action.type}`);
  }

  return { click, input, scroll, extract, goto, run };
}

module.exports = { createActions };
```

- [ ] **Step 3: Session (storage state + multi-tab)**

Create `server/browser-agent/session.js`:

```js
'use strict';
const fs = require('fs');
const path = require('path');

function createSession({ browserContextFactory, storageDir }) {
  fs.mkdirSync(storageDir, { recursive: true });

  async function open({ name, storageFile = null } = {}) {
    const context = await browserContextFactory({
      storageState: storageFile && fs.existsSync(storageFile) ? storageFile : undefined,
    });
    const page = await context.newPage();
    return { name, context, page };
  }

  async function saveAuth(session, { name }) {
    const file = path.join(storageDir, `${name}.json`);
    await session.context.storageState({ path: file });
    return file;
  }

  async function loadAuth(session, { name }) {
    const file = path.join(storageDir, `${name}.json`);
    if (!fs.existsSync(file)) return null;
    return file;
  }

  async function listTabs(session) {
    return session.context.pages().map((p, i) => ({ index: i, url: p.url(), title: p.title ? p.title() : '' }));
  }

  async function switchTab(session, { index }) {
    const pages = session.context.pages();
    if (index < 0 || index >= pages.length) throw new Error('tab index out of range');
    session.page = pages[index];
    await session.page.bringToFront();
    return { index, url: session.page.url() };
  }

  return { open, saveAuth, loadAuth, listTabs, switchTab };
}

module.exports = { createSession };
```

Run tests → PASS. Commit: `feat(browser): actions + session + saved auth storage`.

---

## Task 3: MCP wiring

- [ ] **Step 1: Tool defs**

```js
browser_get_state: { description: 'Return the accessibility-tree state of the current page as a list of interactive elements.', inputSchema: { type: 'object', properties: { include_screenshot: { type: 'boolean' } } } },
browser_click: { description: 'Click an element by role + accessible name.', inputSchema: { type: 'object', required: ['role','name'], properties: { role: {type:'string'}, name: {type:'string'} } } },
browser_input: { description: 'Fill an input by role + accessible name.', inputSchema: { type: 'object', required: ['role','name','value'], properties: { role: {type:'string'}, name: {type:'string'}, value: {type:'string'} } } },
browser_extract: { description: 'Extract text matching a CSS selector from the current page.', inputSchema: { type: 'object', required: ['selector'], properties: { selector: {type:'string'}, limit: {type:'integer'} } } },
browser_switch_tab: { description: 'Switch focus to a different tab by index.', inputSchema: { type: 'object', required: ['index'], properties: { index: {type:'integer'} } } },
browser_save_auth: { description: 'Save the current session cookies/storage to a named file for later reuse.', inputSchema: { type: 'object', required: ['name'], properties: { name: {type:'string'} } } },
browser_load_auth: { description: 'Load a saved auth state into a new browser context.', inputSchema: { type: 'object', required: ['name'], properties: { name: {type:'string'} } } },
```

- [ ] **Step 2: AX capture via Playwright**

Wire up an internal helper that Plays uses CDP (`Accessibility.getFullAXTree`) to feed `buildAxState`:

```js
async function captureAxState(page) {
  const session = await page.context().newCDPSession(page);
  const { nodes } = await session.send('Accessibility.getFullAXTree');
  return buildAxState({
    url: page.url(),
    title: await page.title(),
    nodes: nodes.map(n => ({
      role: n.role?.value,
      name: n.name?.value,
      visible: !n.ignored,
      disabled: !!n.properties?.find(p => p.name === 'disabled')?.value?.value,
      backendNodeId: n.backendDOMNodeId,
    })),
  });
}
```

`await_restart`. Smoke: `browser_load_auth({name:'github'})` (assuming you saved a profile earlier), navigate to a page, `browser_get_state` — confirm interactive elements returned with labels. `browser_click({role:'link', name:'Settings'})` — confirm page changes.

Commit: `feat(browser): AX state capture + MCP action primitives + auth persistence`.
