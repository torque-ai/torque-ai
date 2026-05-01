# Routing Templates Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hardcoded if/else routing logic with user-configurable routing templates — category-to-provider mappings that users create, save, and switch between via dashboard and MCP tools.

**Architecture:** Extract task classification regex from `analyzeTaskForRouting()` into a standalone `category-classifier.js`. Create a `template-store.js` for CRUD + active template resolution. Refactor `analyzeTaskForRouting()` to call classifier, lookup template, resolve provider. Dashboard gets a top-level tab restructure on the renamed Strategy page with a new Routing Templates tab.

**Tech Stack:** Node.js (CommonJS), SQLite (better-sqlite3), React + Tailwind (Vite), Vitest

**Spec:** `docs/superpowers/specs/2026-03-17-routing-templates-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `server/routing/category-classifier.js` | Pure function: `classify(description, files)` returns a category key. All regex patterns extracted from `analyzeTaskForRouting()`. |
| `server/routing/template-store.js` | Template CRUD, preset loading from JSON, active template get/set, validation, resolution (complexity overrides then base rule then default). |
| `server/routing/templates/system-default.json` | Preset: mirrors current hardcoded behavior |
| `server/routing/templates/cost-saver.json` | Preset: everything local except complex code gen |
| `server/routing/templates/quality-first.json` | Preset: cloud for reasoning/code/architecture |
| `server/routing/templates/all-local.json` | Preset: everything on Ollama |
| `server/routing/templates/cloud-sprint.json` | Preset: maximum speed, everything to cloud |
| `server/handlers/routing-template-handlers.js` | MCP tool handlers + REST handlers for template CRUD |
| `server/tool-defs/routing-template-defs.js` | MCP tool definitions (7 tools) |
| `server/tests/category-classifier.test.js` | Unit tests for classification |
| `server/tests/routing-templates.test.js` | Unit tests for template store |
| `server/tests/routing-templates-integration.test.js` | Integration tests for routing with templates |
| `dashboard/src/views/RoutingTemplates.jsx` | Routing Templates tab component |
| `dashboard/src/views/RoutingTemplates.test.jsx` | Dashboard tests |

---

### Task 1: Category Classifier — Tests

**Files:**
- Create: `server/tests/category-classifier.test.js`
- Create: `server/routing/category-classifier.js` (stub)

- [ ] **Step 1: Create stub classifier**

Create `server/routing/category-classifier.js` with a stub that always returns `'default'`:

```js
'use strict';

const CATEGORIES = [
  'security', 'xaml_wpf', 'architectural', 'reasoning',
  'large_code_gen', 'documentation', 'simple_generation',
  'targeted_file_edit', 'default',
];

function classify(taskDescription, files) {
  return 'default';
}

function getCategories() {
  return CATEGORIES.map(key => ({ key, displayName: key, description: '' }));
}

module.exports = { classify, getCategories, CATEGORIES };
```

- [ ] **Step 2: Write failing tests**

Create `server/tests/category-classifier.test.js`:

```js
'use strict';
const { classify, getCategories, CATEGORIES } = require('../routing/category-classifier');

describe('category-classifier', () => {
  describe('classify()', () => {
    it('classifies security tasks', () => {
      expect(classify('Fix the SQL injection vulnerability in auth module')).toBe('security');
      expect(classify('Add encryption to credential storage')).toBe('security');
      expect(classify('Audit for XSS and CSRF vulnerabilities')).toBe('security');
    });

    it('classifies XAML/WPF tasks', () => {
      expect(classify('Fix the layout in MainWindow.xaml')).toBe('xaml_wpf');
      expect(classify('Update WPF styles for dark theme', ['App.xaml'])).toBe('xaml_wpf');
      expect(classify('Build MAUI page for settings')).toBe('xaml_wpf');
    });

    it('classifies architectural tasks', () => {
      expect(classify('Refactor the multi-module dependency graph')).toBe('architectural');
      expect(classify('Design the migration strategy for v3')).toBe('architectural');
    });

    it('classifies reasoning tasks', () => {
      expect(classify('Analyze the root cause of the memory leak')).toBe('reasoning');
      expect(classify('Debug complex race condition in scheduler')).toBe('reasoning');
      expect(classify('Review the entire authentication flow')).toBe('reasoning');
    });

    it('classifies large code gen tasks', () => {
      expect(classify('Implement the notification system from scratch')).toBe('large_code_gen');
      expect(classify('Build a feature for user profile management')).toBe('large_code_gen');
      expect(classify('Create a module for data export')).toBe('large_code_gen');
    });

    it('classifies documentation tasks', () => {
      expect(classify('Document the API endpoints')).toBe('documentation');
      expect(classify('Write a README for the project')).toBe('documentation');
      expect(classify('Add JSDoc comments to utils.js')).toBe('documentation');
    });

    it('classifies simple generation tasks', () => {
      expect(classify('Generate a commit message for the changes')).toBe('simple_generation');
      expect(classify('Scaffold the boilerplate for a new service')).toBe('simple_generation');
    });

    it('classifies targeted file edit tasks', () => {
      expect(classify('Add JSDoc to the getUser function in src/users.ts')).toBe('targeted_file_edit');
      expect(classify('Fix the import statement in utils/helpers.js')).toBe('targeted_file_edit');
    });

    it('returns default for unmatched tasks', () => {
      expect(classify('Do something')).toBe('default');
      expect(classify('')).toBe('default');
      expect(classify(null)).toBe('default');
    });

    it('respects priority — security wins over documentation', () => {
      expect(classify('Document the security audit results')).toBe('security');
    });

    it('respects priority — XAML wins via file extension', () => {
      expect(classify('Update the styles', ['Theme.xaml'])).toBe('xaml_wpf');
    });
  });

  describe('getCategories()', () => {
    it('returns all 9 categories with metadata', () => {
      const cats = getCategories();
      expect(cats).toHaveLength(9);
      expect(cats.map(c => c.key)).toEqual(CATEGORIES);
      for (const cat of cats) {
        expect(cat).toHaveProperty('key');
        expect(cat).toHaveProperty('displayName');
        expect(cat).toHaveProperty('description');
      }
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/category-classifier.test.js`
Expected: Multiple failures (stub returns `'default'` for everything)

- [ ] **Step 4: Commit**

```bash
git add server/routing/category-classifier.js server/tests/category-classifier.test.js
git commit -m "test: add category classifier tests (red phase)"
```

---

### Task 2: Category Classifier — Implementation

**Files:**
- Modify: `server/routing/category-classifier.js`

- [ ] **Step 1: Implement classify()**

Replace the stub in `server/routing/category-classifier.js` with the full implementation. Extract the regex patterns from `server/db/provider-routing-core.js` lines 343-471 (the `isSecurityTask`, `isXamlTask`, `isArchitecturalTask`, `isReasoningTask`, `isLargeCodeTask`, `isDocsTask`, `isSimpleGenTask`, and `isTargetedFileEdit` patterns):

```js
'use strict';

const CATEGORIES = [
  'security', 'xaml_wpf', 'architectural', 'reasoning',
  'large_code_gen', 'documentation', 'simple_generation',
  'targeted_file_edit', 'default',
];

const CATEGORY_META = {
  security: {
    displayName: 'Security',
    description: 'Authentication, encryption, vulnerability scanning, OWASP',
    keywords: 'auth, encrypt, vulnerability, injection, xss, csrf',
  },
  xaml_wpf: {
    displayName: 'XAML / WPF',
    description: 'XAML files, WPF, UWP, MAUI, Avalonia',
    keywords: '.xaml files, WPF, MAUI, Avalonia',
  },
  architectural: {
    displayName: 'Architectural',
    description: 'System design, refactoring, migration strategy',
    keywords: 'architect, refactor, redesign, system design',
  },
  reasoning: {
    displayName: 'Reasoning',
    description: 'Complex analysis, debugging, root cause investigation',
    keywords: 'analyze, debug, root cause, deep analysis',
  },
  large_code_gen: {
    displayName: 'Large Code Gen',
    description: 'Implementing systems, building features, creating modules',
    keywords: 'implement system, build feature, create module',
  },
  documentation: {
    displayName: 'Documentation',
    description: 'Writing docs, READMEs, JSDoc, explanations',
    keywords: 'document, explain, summarize, readme, jsdoc',
  },
  simple_generation: {
    displayName: 'Simple Generation',
    description: 'Commit messages, boilerplate, scaffolding',
    keywords: 'commit message, boilerplate, scaffold, template',
  },
  targeted_file_edit: {
    displayName: 'Targeted File Edits',
    description: 'Fixing, updating, or modifying specific files',
    keywords: 'fix, update, modify + specific file reference',
  },
  default: {
    displayName: 'Default (catch-all)',
    description: 'Everything that does not match another category',
    keywords: '',
  },
};

// --- Classification patterns (extracted from provider-routing-core.js) ---

const SECURITY_RE = /\b(security|vulnerab|audit|penetrat|auth|encrypt|credential|secret|injection|xss|csrf|owasp)\b/i;
const XAML_KEYWORD_RE = /\b(xaml|wpf|uwp|maui|avalonia)\b/i;
const ARCHITECTURAL_RE = /\b(architect|refactor.*multi|redesign|migration strategy|system design)\b/i;
const REASONING_RE = /\b(reason|analyze|debug complex|root cause|review.*entire|explain.*architecture|deep.*analysis)\b/i;
const LARGE_CODE_RE = /\b(implement.*system|build.*feature|create.*module|complex.*generation|multi.*file.*refactor)\b/i;
const DOCS_RE = /\b(document|explain|summarize|describe|comment|readme|changelog|jsdoc|docstring)\b/i;
const SIMPLE_GEN_RE = /\b(commit message|boilerplate|scaffold|template|stub)\b/i;

const FILE_REF_RE = /[\w\-./\\]+\.\w{1,5}\b/;
const EDIT_PATTERNS = [
  /\b(add|insert|append)\b.{0,30}\b(jsdoc|comment|docstring|annotation|import|export|field|property|method|function|getter|setter|constructor|decorator|attribute|type|param|return)\b/i,
  /\b(fix|update|change|modify|replace|rename|move)\b.{0,40}\b(in|at|on|to)\b/i,
  /\b(remove|delete)\b.{0,30}\b(unused|dead|deprecated|obsolete|import|line|method|function|comment)\b/i,
  /\b(add|write|create)\b.{0,20}\b(test|spec)\b.{0,20}\b(for|to|in)\b/i,
  /\bjsdoc\b|\bdocstring\b|\bxml doc\b|\btsdoc\b/i,
  /\badd\b.{0,15}\b(logging|log statement|console\.log)\b/i,
  /\b(add|update)\b.{0,20}\b(error handling|validation|null check|type guard)\b/i,
];

function hasXamlFile(files) {
  return Array.isArray(files) && files.some(f => /\.xaml$/i.test(f));
}

function isTargetedFileEdit(desc) {
  if (!FILE_REF_RE.test(desc)) return false;
  return EDIT_PATTERNS.some(p => p.test(desc));
}

/**
 * Classify a task description into a routing category.
 * Returns a single category key (first match wins). Returns 'default' if no match.
 * @param {string|null} taskDescription
 * @param {string[]} [files]
 * @returns {string}
 */
function classify(taskDescription, files) {
  const desc = taskDescription || '';
  if (!desc) return 'default';

  // Priority order matches the original if/else chain in analyzeTaskForRouting
  if (SECURITY_RE.test(desc)) return 'security';
  if (XAML_KEYWORD_RE.test(desc) || hasXamlFile(files)) return 'xaml_wpf';
  if (ARCHITECTURAL_RE.test(desc)) return 'architectural';
  if (REASONING_RE.test(desc)) return 'reasoning';
  if (LARGE_CODE_RE.test(desc)) return 'large_code_gen';
  if (DOCS_RE.test(desc)) return 'documentation';
  if (SIMPLE_GEN_RE.test(desc)) return 'simple_generation';
  if (isTargetedFileEdit(desc)) return 'targeted_file_edit';

  return 'default';
}

/**
 * List all categories with display metadata.
 * @returns {{ key: string, displayName: string, description: string, keywords: string }[]}
 */
function getCategories() {
  return CATEGORIES.map(key => ({
    key,
    ...CATEGORY_META[key],
  }));
}

module.exports = { classify, getCategories, CATEGORIES };
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/category-classifier.test.js`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add server/routing/category-classifier.js
git commit -m "feat: implement category classifier with regex extraction"
```

---

### Task 3: Template Store — Tests

**Files:**
- Create: `server/tests/routing-templates.test.js`
- Create: `server/routing/template-store.js` (stub)
- Create: `server/routing/templates/system-default.json`

- [ ] **Step 1: Create the System Default preset JSON**

Create `server/routing/templates/system-default.json`:

```json
{
  "name": "System Default",
  "description": "Mirrors TORQUE's built-in routing behavior",
  "rules": {
    "security": "anthropic",
    "xaml_wpf": "anthropic",
    "architectural": "deepinfra",
    "reasoning": "deepinfra",
    "large_code_gen": "codex",
    "documentation": "groq",
    "simple_generation": "ollama",
    "targeted_file_edit": "hashline-ollama",
    "default": "ollama"
  },
  "complexity_overrides": {}
}
```

- [ ] **Step 2: Create stub template-store**

Create `server/routing/template-store.js` with stubs for all exported functions — each returns empty/null. The full list: `setDb`, `ensureTable`, `seedPresets`, `listTemplates`, `getTemplate`, `getTemplateByName`, `createTemplate`, `updateTemplate`, `deleteTemplate`, `getActiveTemplate`, `setActiveTemplate`, `resolveProvider`, `validateTemplate`.

- [ ] **Step 3: Write failing tests**

Create `server/tests/routing-templates.test.js` using `setupTestDb('routing-templates')` from `vitest-setup.js`. Tests should cover:

- `ensureTable + seedPresets`: seeds 5+ presets, all marked `preset=1`
- CRUD: create user template, reject duplicate name, get by id, get by name, update user template, reject update on preset, delete user template, reject delete on preset
- Active template: returns System Default when nothing set, sets and gets active, falls back to System Default if active is deleted
- `resolveProvider`: base rules, complexity overrides, missing overrides fall to base, unknown category falls to default
- `validateTemplate`: valid passes, missing default rejects, empty name rejects, missing category keys rejects (e.g., template with only `default` but missing `security`, `reasoning`, etc. should fail)

Follow the test patterns in `server/tests/economy-policy.test.js` — use `setupTestDb`/`teardownTestDb`, `beforeAll`/`afterAll`, and `beforeEach` for cleanup.

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/routing-templates.test.js`
Expected: Multiple failures (stubs return empty/null)

- [ ] **Step 5: Commit**

```bash
git add server/tests/routing-templates.test.js server/routing/template-store.js server/routing/templates/system-default.json
git commit -m "test: add template store tests (red phase)"
```

---

### Task 4: Template Store — Implementation

**Files:**
- Modify: `server/routing/template-store.js`
- Create: `server/routing/templates/cost-saver.json`
- Create: `server/routing/templates/quality-first.json`
- Create: `server/routing/templates/all-local.json`
- Create: `server/routing/templates/cloud-sprint.json`

- [ ] **Step 1: Create remaining preset JSON files**

Create these four JSON files in `server/routing/templates/`:

**cost-saver.json:** All categories to `ollama` except `security` to `anthropic` and `targeted_file_edit` to `hashline-ollama`. Complexity override: `large_code_gen.complex` to `codex`.

**quality-first.json:** Reasoning/large_code_gen/architectural to `codex`, docs/simple_generation/default to `deepinfra`, security/xaml_wpf to `anthropic`, targeted_file_edit to `hashline-ollama`. Complexity override: `targeted_file_edit.simple` to `hashline-ollama`.

**all-local.json:** Every category to `ollama`, except `targeted_file_edit` to `hashline-ollama`. No complexity overrides.

**cloud-sprint.json:** Security/xaml_wpf to `anthropic`, reasoning/large_code_gen/architectural/default to `codex`, documentation/simple_generation to `groq`, targeted_file_edit to `hashline-ollama`. No complexity overrides.

See the spec's Built-in Presets section for exact mappings.

- [ ] **Step 2: Implement template-store.js**

Replace the stub with the full implementation. Key functions:

- `ensureTable()`: `CREATE TABLE IF NOT EXISTS routing_templates (...)` — schema from spec
- `seedPresets()`: read all `.json` files from `server/routing/templates/`, `INSERT OR IGNORE` with `preset=1` and `id` = `preset-<filename>`
- `parseRow(row)`: parse `rules_json` and `complexity_overrides_json` from DB row
- `listTemplates()`: `SELECT * ORDER BY preset DESC, name ASC`, map through `parseRow`
- `getTemplate(id)` / `getTemplateByName(name)`: single-row SELECT
- `validateTemplate(data)`: check name non-empty (max 100 chars), rules is object with ALL category keys present (all 9 from `CATEGORIES`), `default` key is mandatory, all values are non-empty strings, complexity override levels are `simple`/`normal`/`complex`
- `createTemplate(data)`: validate, generate UUID via `crypto.randomUUID()`, INSERT
- `updateTemplate(id, data)`: check not preset (throw if so), validate merged data, UPDATE
- `deleteTemplate(id)`: check not preset (throw if so), clear active selection if this was active, DELETE
- `getActiveTemplate()`: read `config` key `active_routing_template`, fetch template, fall back to `getTemplateByName('System Default')`
- `setActiveTemplate(templateId)`: `INSERT OR REPLACE` into config table, or DELETE if null
- `resolveProvider(template, category, complexity)`: check `complexity_overrides[category][complexity]` first, then `rules[category]`, then `rules.default`

Follow the patterns in `server/economy/policy.js` for DB access via a lazy `require('../database')` or injected `setDb()`.

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/routing-templates.test.js`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add server/routing/template-store.js server/routing/templates/
git commit -m "feat: implement template store with CRUD, presets, and resolution"
```

---

### Task 5: DB Migration + Seeding

**Files:**
- Modify: `server/db/schema-migrations.js`
- Modify: `server/db/schema-seeds.js`

- [ ] **Step 1: Add routing_templates table migration**

Append to the end of `runMigrations()` in `server/db/schema-migrations.js` (before the closing `}`). Follow the same try/catch pattern as the `model_registry` table at line 493:

```js
  // Routing templates
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS routing_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        rules_json TEXT NOT NULL,
        complexity_overrides_json TEXT,
        preset INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
  } catch (e) {
    logger.debug(`Schema migration (routing_templates): ${e.message}`);
  }
```

- [ ] **Step 2: Add preset seeding to schema-seeds.js**

Append to the end of `seedDefaults()` in `server/db/schema-seeds.js`:

```js
  // Seed routing template presets
  try {
    const templateStore = require('../routing/template-store');
    templateStore.setDb(db);
    templateStore.ensureTable();
    templateStore.seedPresets();
  } catch (e) {
    logger.debug(`Schema seed (routing templates): ${e.message}`);
  }
```

- [ ] **Step 3: Run existing migration tests**

Run: `cd server && npx vitest run tests/db-migrations.test.js`
Expected: All existing migration tests PASS

- [ ] **Step 4: Commit**

```bash
git add server/db/schema-migrations.js server/db/schema-seeds.js
git commit -m "feat: add routing_templates table migration and preset seeding"
```

---

### Task 6: MCP Tool Definitions + Handlers

**Files:**
- Create: `server/tool-defs/routing-template-defs.js`
- Create: `server/handlers/routing-template-handlers.js`

- [ ] **Step 1: Create tool definitions**

Create `server/tool-defs/routing-template-defs.js` with 7 tool definitions matching the spec's MCP Tools table. Follow the exact pattern in `server/tool-defs/economy-defs.js` — export an array of `{ name, description, inputSchema }` objects.

Tools: `list_routing_templates`, `get_routing_template`, `set_routing_template`, `delete_routing_template`, `activate_routing_template`, `get_active_routing`, `list_routing_categories`.

- [ ] **Step 2: Create handlers**

Create `server/handlers/routing-template-handlers.js`. Follow the pattern in `server/handlers/economy-handlers.js`:

- Import `template-store` and `category-classifier`
- `makeTextResult(message, isError)` helper (same pattern as economy handlers)
- One handler function per tool: `handleListTemplates`, `handleGetTemplate`, `handleSetTemplate` (upsert by name, reject preset names), `handleDeleteTemplate`, `handleActivateTemplate`, `handleGetActiveRouting`, `handleListCategories`
- Export `toolDefs` (require the defs file), `toolHandlers` (map of tool name to handler function), and named REST handler functions

The `set_routing_template` handler should check if a template with the given name exists — if it's a preset, return error; if it's a user template, update it; if it doesn't exist, create it.

- [ ] **Step 3: Commit**

```bash
git add server/tool-defs/routing-template-defs.js server/handlers/routing-template-handlers.js
git commit -m "feat: add MCP tool definitions and handlers for routing templates"
```

---

### Task 7: Register Tools + Routes

**Files:**
- Modify: `server/tools.js`
- Modify: `server/api/routes.js`
- Modify: `server/api/v2-dispatch.js`

- [ ] **Step 1: Register handler module in tools.js**

Add to the handler modules array in `server/tools.js` (after the economy-handlers require at line 71):

```js
  require('./handlers/routing-template-handlers'),
```

- [ ] **Step 2: Add REST routes in routes.js**

Add 8 route entries to the routes array in `server/api/routes.js` (near the economy routes at line 1198). Routes: GET/POST `/api/routing/templates`, GET/PUT/DELETE `/api/routing/templates/:id`, GET/PUT `/api/routing/active`, GET `/api/routing/categories`. Each with `buildV2Middleware()`.

- [ ] **Step 3: Add dispatch handlers in v2-dispatch.js**

Add dispatch functions for each route. Follow the exact pattern of `handleV2CpGetEconomyStatus` and `handleV2CpSetEconomyMode` at lines 94-109:
- GET handlers: require handlers module, call handler, parse text result, return `{ data, meta }`
- POST/PUT/DELETE handlers: read body with `readJsonBody(req)`, call handler, return response with appropriate status codes (201 for create, 200 for update/delete, 404/403/400 for errors per the spec's REST Error Responses table)

- [ ] **Step 4: Commit**

```bash
git add server/tools.js server/api/routes.js server/api/v2-dispatch.js
git commit -m "feat: register routing template tools and REST routes"
```

---

### Task 8: Refactor analyzeTaskForRouting — Integration Tests First

**Files:**
- Create: `server/tests/routing-templates-integration.test.js`

- [ ] **Step 1: Write integration tests**

Create `server/tests/routing-templates-integration.test.js` using `setupTestDb('routing-templates-integration')`. Tests:

- Routes security task per System Default template (security -> anthropic)
- Routes per custom template when active (security -> ollama with custom template)
- Respects complexity overrides (reasoning with complex override -> codex)
- Skips template when explicit provider override (`isUserOverride: true`)
- Uses System Default when no template active (`setActiveTemplate(null)`)

Enable smart routing in beforeAll: `db.setConfig('smart_routing_enabled', '1')`. Reset active template in afterEach.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/routing-templates-integration.test.js`
Expected: Failures (analyzeTaskForRouting doesn't use templates yet)

- [ ] **Step 3: Commit**

```bash
git add server/tests/routing-templates-integration.test.js
git commit -m "test: add routing template integration tests (red phase)"
```

---

### Task 9: Refactor analyzeTaskForRouting

**Files:**
- Modify: `server/db/provider-routing-core.js`

This is the core refactoring of `analyzeTaskForRouting()` (starting at line 247).

- [ ] **Step 1: Add requires at top of file**

Add near the top of `server/db/provider-routing-core.js` (after the existing requires around line 17), using a try/catch for graceful fallback:

```js
let categoryClassifier = null;
let templateStore = null;
try {
  categoryClassifier = require('../routing/category-classifier');
  templateStore = require('../routing/template-store');
} catch (error) {
  categoryClassifier = null;
  templateStore = null;
}
```

- [ ] **Step 2: Initialize template store in setDb()**

In the `setDb()` function (line 29), add after `ensureHealthTable()`:

```js
  if (templateStore && typeof templateStore.setDb === 'function') {
    templateStore.setDb(dbInstance);
    templateStore.ensureTable();
    templateStore.seedPresets();
  }
```

- [ ] **Step 3: Insert template routing path into analyzeTaskForRouting()**

**Ordering constraint:** The template block calls `maybeApplyFallback()`, which is a `const` function expression defined at line 434 (not hoisted). The `ollamaFallbackProvider` variable it uses is declared at line 335. Both must exist before the template block executes.

**Approach:** Insert the template block AFTER the `maybeApplyFallback` definition (after line 452) and BEFORE the existing complexity-based host routing (line 477). This places it between the helper definitions and the hardcoded routing logic — templates get first shot, hardcoded paths are the fallback.

In `analyzeTaskForRouting()`, find the line after `maybeApplyFallback` closes (after line 452: `return result;` + `};`) and before the comment `// PRIMARY: Complexity-based routing` (line 473). Insert:

```js
  // Template-based routing (user-configurable category -> provider mapping)
  if (categoryClassifier && templateStore) {
    const category = categoryClassifier.classify(taskDescription, files);
    const complexity = hostManagementFns?.determineTaskComplexity
      ? hostManagementFns.determineTaskComplexity(taskDescription, files)
      : 'normal';

    const activeTemplate = templateStore.getActiveTemplate();
    if (activeTemplate) {
      const targetProvider = templateStore.resolveProvider(activeTemplate, category, complexity);
      if (targetProvider) {
        const providerConfig = getProvider(targetProvider);
        if (providerConfig && providerConfig.enabled) {
          const result = {
            provider: targetProvider,
            rule: null,
            complexity,
            reason: `Template '${activeTemplate.name}': ${category} -> ${targetProvider}`,
          };
          return maybeApplyFallback(result);
        }
        // Target unavailable — try default
        const defaultProvider = templateStore.resolveProvider(activeTemplate, 'default', complexity);
        if (defaultProvider && defaultProvider !== targetProvider) {
          const defaultConfig = getProvider(defaultProvider);
          if (defaultConfig && defaultConfig.enabled) {
            return maybeApplyFallback({
              provider: defaultProvider,
              rule: null,
              complexity,
              reason: `Template '${activeTemplate.name}': ${category} -> ${targetProvider} (unavailable), fallback to default -> ${defaultProvider}`,
            });
          }
        }
      }
    }
  }
```

**Important:** The existing complexity-based host routing and hardcoded regex routing below this block remain as fallback paths. They execute only if template routing doesn't produce a result (template not initialized, no active template, or all template providers unavailable). This ensures backward compatibility.

- [ ] **Step 4: Run integration tests**

Run: `cd server && npx vitest run tests/routing-templates-integration.test.js`
Expected: All tests PASS

- [ ] **Step 5: Run full server test suite**

Run: `cd server && npx vitest run`
Expected: No new failures. Existing routing tests should still pass because System Default mirrors old behavior and the hardcoded paths remain as fallback.

- [ ] **Step 6: Commit**

```bash
git add server/db/provider-routing-core.js
git commit -m "feat: refactor analyzeTaskForRouting to use routing templates"
```

---

### Task 10: Dashboard API Client

**Files:**
- Modify: `dashboard/src/api.js`

- [ ] **Step 1: Add routing template API functions**

Add a `routingTemplates` export to `dashboard/src/api.js` alongside the existing API namespaces. Use the existing `get`, `post`, `put`, `del` helper functions already defined in the file:

```js
export const routingTemplates = {
  list: (opts = {}) => get('/api/routing/templates', opts),
  get: (id, opts = {}) => get(`/api/routing/templates/${id}`, opts),
  create: (data, opts = {}) => post('/api/routing/templates', data, opts),
  update: (id, data, opts = {}) => put(`/api/routing/templates/${id}`, data, opts),
  remove: (id, opts = {}) => del(`/api/routing/templates/${id}`, opts),
  getActive: (opts = {}) => get('/api/routing/active', opts),
  setActive: (data, opts = {}) => put('/api/routing/active', data, opts),
  categories: (opts = {}) => get('/api/routing/categories', opts),
};
```

Check the existing helpers in api.js first — use the same function names and patterns.

- [ ] **Step 2: Commit**

```bash
git add dashboard/src/api.js
git commit -m "feat: add routing template API client functions"
```

---

### Task 11: Dashboard — Rename Strategic to Strategy

**Files:**
- Rename: `dashboard/src/views/Strategic.jsx` to `dashboard/src/views/Strategy.jsx`
- Rename: `dashboard/src/views/Strategic.test.jsx` to `dashboard/src/views/Strategy.test.jsx`
- Modify: `dashboard/src/components/Layout.jsx`
- Modify: `dashboard/src/App.jsx`

- [ ] **Step 1: Rename files**

```bash
cd dashboard/src/views && git mv Strategic.jsx Strategy.jsx && git mv Strategic.test.jsx Strategy.test.jsx
```

- [ ] **Step 2: Update Layout.jsx**

In `dashboard/src/components/Layout.jsx`:
- Change `ROUTE_NAMES` key `'/strategic'` to `'/strategy'` with label `'Strategy'`
- Change navItems entry: `{ to: '/strategy', icon: StrategicIcon, label: 'Strategy' }`

- [ ] **Step 3: Update App.jsx**

In `dashboard/src/App.jsx`:
- Change lazy import: `const Strategy = lazy(() => import('./views/Strategy'));`
- Change route: `<Route path="strategy" element={<Strategy />} />`
- Add redirect: `<Route path="strategic" element={<Navigate to="/strategy" replace />} />`

- [ ] **Step 4: Update test imports in Strategy.test.jsx**

Update import path from `'./Strategic'` to `'./Strategy'`.

- [ ] **Step 5: Update e2e spec if it exists**

If `dashboard/e2e/strategic.spec.js` exists, update route references from `/strategic` to `/strategy`.

- [ ] **Step 6: Run dashboard tests**

Run: `cd dashboard && npx vitest run`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add -A dashboard/
git commit -m "refactor: rename Strategic to Strategy across dashboard"
```

---

### Task 12: Dashboard — Routing Templates Tab Component

**Files:**
- Create: `dashboard/src/views/RoutingTemplates.jsx`

- [ ] **Step 1: Create RoutingTemplates.jsx**

Create `dashboard/src/views/RoutingTemplates.jsx`. This is the largest UI file. The component should:

**Data loading:** On mount, fetch templates list, active template, and categories from the API (`routingTemplates.list()`, `routingTemplates.getActive()`, `routingTemplates.categories()`).

**State:** `templates` (list), `activeTemplateId`, `categories` (list), `editingRules` (the current mapping being edited), `editingOverrides`, `expandedCategories` (set of category keys with complexity panel open), `selectedTemplateId`, `hasUnsavedChanges`.

**Template selector bar:** Dropdown of all templates (presets labeled with "(preset)" suffix). Buttons: New, Duplicate, Save, Delete. Save is disabled for presets. Delete is disabled for presets.

**Category table:** One row per category (from categories API response). Each row shows:
- Category display name + keyword hint in small text
- Provider dropdown (populated with all known providers)
- Colored dot matching the provider color (use PROVIDER_COLORS from Providers.jsx)
- Expand arrow (triangle) to toggle complexity overrides

**Expanded complexity row:** When expanded, shows 3 sub-rows (simple/normal/complex) each with a provider dropdown. Color-code complexity labels (green/blue/orange). Include an "inherit" option in the dropdown that clears the override (falls to base rule).

**Validation banner:** If any mapped provider is referenced but not in the known providers list or is disabled, show an amber warning bar at the bottom.

**Interactions:**
- Changing template dropdown: load that template's rules into the editing state
- Changing a provider dropdown: mark `hasUnsavedChanges = true`
- Save: POST/PUT to API, show success toast
- New: create blank template (all categories -> ollama), open it
- Duplicate: copy current template as new user template
- Delete: confirm, then DELETE, switch to System Default

Follow existing dashboard patterns: `useToast` for feedback, Tailwind classes (glass-card, bg-slate-800, text-slate-400), `useCallback` for handlers.

Reference the mockup at `.superpowers/brainstorm/8739-1773763653/q2-strategy-page-mockup.html` for the visual design.

- [ ] **Step 2: Commit**

```bash
git add dashboard/src/views/RoutingTemplates.jsx
git commit -m "feat: add RoutingTemplates tab component"
```

---

### Task 13: Dashboard — Restructure Strategy Page with Tabs

**Files:**
- Modify: `dashboard/src/views/Strategy.jsx`

- [ ] **Step 1: Add top-level tab system**

Restructure `dashboard/src/views/Strategy.jsx`:

1. Import `RoutingTemplates` from `'./RoutingTemplates'`
2. Replace the existing bottom-level `tabs` array (line 478) with a top-level tabs system
3. Create a new top-level tabs array: `['Overview', 'Decisions', 'Operations', 'Routing Templates']`
4. Add a `topTab` state variable (default: `'Overview'`)
5. Render the top-level tab bar right after the header section (after the Refresh button, before stat cards)
6. Wrap existing sections in conditional rendering by `topTab`:
   - **Overview tab:** stat cards + config panel + fallback chain + provider health grid
   - **Decisions tab:** the existing Decision History table content
   - **Operations tab:** the existing Strategic Operations content
   - **Routing Templates tab:** `<RoutingTemplates />`
7. Update the page title from "Strategic Brain" to "Strategy"
8. Remove the old bottom-level tab bar (was at line 583)

- [ ] **Step 2: Run dashboard dev server and verify**

Run: `cd dashboard && npm run dev`
Verify: Navigate to `/strategy`, confirm all 4 tabs render correctly, switching between them works.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/views/Strategy.jsx
git commit -m "feat: restructure Strategy page with top-level tabs"
```

---

### Task 14: Dashboard Tests

**Files:**
- Create: `dashboard/src/views/RoutingTemplates.test.jsx`

- [ ] **Step 1: Write dashboard tests**

Create `dashboard/src/views/RoutingTemplates.test.jsx`. Mock the API module (`vi.mock('../api', ...)`), mock the Toast hook. Tests:

- Renders template selector showing preset and user template names
- Renders category rows from the categories API response
- (Optional) Smoke test that the component mounts without errors

Follow the pattern in `dashboard/src/views/Strategic.test.jsx` (now `Strategy.test.jsx`) for mocking and rendering.

- [ ] **Step 2: Run dashboard tests**

Run: `cd dashboard && npx vitest run src/views/RoutingTemplates.test.jsx`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/views/RoutingTemplates.test.jsx
git commit -m "test: add dashboard tests for RoutingTemplates component"
```

---

### Task 15: Final Verification

- [ ] **Step 1: Run full server test suite**

Run: `cd server && npx vitest run`
Expected: All tests PASS, no regressions

- [ ] **Step 2: Run full dashboard test suite**

Run: `cd dashboard && npx vitest run`
Expected: All tests PASS, no regressions

- [ ] **Step 3: Manual smoke test**

1. Start TORQUE server
2. Open dashboard at localhost:3456
3. Navigate to `/strategy` — verify page loads with all 4 tabs
4. Click "Routing Templates" tab — verify presets show in dropdown
5. Select "Cost Saver" preset, verify category mappings update
6. Click "Duplicate", verify new user template is created
7. Change a provider mapping, click "Save"
8. Verify via MCP: call `get_active_routing` and confirm the change

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: complete routing templates -- configurable task-to-provider routing"
```
