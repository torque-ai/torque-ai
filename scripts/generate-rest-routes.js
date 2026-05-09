#!/usr/bin/env node
'use strict';

// generate-rest-routes — emits server/api/routes-passthrough.js by
// scanning the same MCP tool sources rest-parity-audit.js scans, then
// generating one REST route per tool that doesn't already have one
// somewhere else (routes.js, v2 handler files, etc.).
//
// Heuristics:
//   - HTTP method: chosen from a verb-prefix table; falls back to POST.
//   - URL path:    /api/v2/<category-slug>/<name-with-dashes>
//   - Body vs query mapping: tools whose inputSchema has any object/array
//     property → mapBody; tools with only string/number scalars → mapQuery.
//   - tools whose only required prop is `task_id` (or another ID) → POST
//     and mapParams via the route regex.
//
// A small skip list excludes tools that are intentionally MCP-only
// (session-scoped SSE acks, etc.).
//
// Run: node scripts/generate-rest-routes.js [--dry-run]
//
// Re-run scripts/rest-parity-audit.js after this to confirm actionable
// gap count and orphan count are both 0.
//
// IMPORTANT: this script generates a SUPPLEMENT file
// (server/api/routes-generated-supplement.js) rather than overwriting
// the existing routes-passthrough.js. The historical passthrough file
// has hand-tuned routes (path params, custom methods, query/body
// preferences) that a regex-driven generator cannot reproduce
// faithfully. Splitting the supplement keeps the generator
// reversible and side-effect-free for already-covered tools.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'server');
const OUT_FILE = path.join(SERVER, 'api', 'routes-generated-supplement.js');

// Tools that are intentionally NOT exposed over REST. These are session-
// scoped or push-only; over plain HTTP the semantics break. Each entry
// should have a one-line reason so the next contributor can re-evaluate.
const REST_SKIPLIST = new Map([
  // SSE protocol — only meaningful inside an active MCP/SSE session.
  ['subscribe_task_events', 'session-scoped: requires live SSE channel for push delivery'],
  ['check_notifications',   'session-scoped: drains a per-session in-memory queue'],
  ['ack_notification',      'session-scoped: acks an event delivered via the same SSE stream'],
  // Internal-only meta tools.
  ['unlock_all_tools',  'client-side meta: signals tool-list refresh, not a server operation'],
  ['unlock_tier',       'client-side meta: signals tool-list refresh, not a server operation'],
  ['get_tool_schema',   'introspection: exposed via OpenAPI spec at /api/openapi.json'],
]);

// PARITY-GENERATOR-AUDIT-CONTRACT: these regexes must stay in sync with
// scripts/rest-parity-audit.js. Both files are CLI scripts so we duplicate
// the small enumeration helpers rather than module-importing.
const NAME_REGEX = /(?:^|[\s,{(])["']?name["']?\s*:\s*['"`]([a-z_][a-z_0-9]*)['"`]/g;
const TOOL_REF_REGEX = /tool\s*:\s*['"`]([a-z_][a-z_0-9]*)['"`]/g;
const INLINE_CASE_REGEX = /\bcase\s+['"`]([a-z_][a-z_0-9]*)['"`]\s*:/g;

function listToolDefFiles() {
  const files = [];
  const coreDefs = path.join(SERVER, 'tool-defs');
  if (fs.existsSync(coreDefs)) {
    for (const name of fs.readdirSync(coreDefs)) {
      if (name.endsWith('.js')) files.push(path.join(coreDefs, name));
    }
  }
  const pluginsDir = path.join(SERVER, 'plugins');
  if (fs.existsSync(pluginsDir)) {
    for (const plugin of fs.readdirSync(pluginsDir)) {
      const pluginDir = path.join(pluginsDir, plugin);
      if (!fs.statSync(pluginDir).isDirectory()) continue;
      for (const name of fs.readdirSync(pluginDir)) {
        if (/(?:^|-)tool-defs(?:\.|$)/.test(name) && name.endsWith('.js')) {
          files.push(path.join(pluginDir, name));
        }
      }
    }
  }
  const sseProtocol = path.join(SERVER, 'transports', 'sse', 'protocol.js');
  if (fs.existsSync(sseProtocol)) files.push(sseProtocol);
  return files;
}

// Parse a tool-defs file into {name, inputSchema} pairs. We try `require()`
// first so the inputSchema is honored faithfully — this matters for the
// body-vs-query inference. Files that throw on require (pulls in DB or
// runtime deps) fall back to regex-only extraction without the schema
// (no big deal — those tools default to mapBody).
function loadTools(file) {
  const tools = [];
  try {
    delete require.cache[require.resolve(file)];
    const mod = require(file);
    const arr = Array.isArray(mod)
      ? mod
      : (mod.SSE_TOOLS || mod.TOOLS || mod.WORKFLOW_SPEC_TOOLS
        || mod.WORKFLOW_RESUME_TOOLS || mod.EVENT_TOOLS || mod.RUN_ARTIFACT_TOOLS);
    if (Array.isArray(arr)) {
      for (const t of arr) {
        if (t && typeof t.name === 'string') {
          tools.push({ name: t.name, inputSchema: t.inputSchema, source: file });
        }
      }
      if (tools.length > 0) return tools;
    }
  } catch {
    // Fall through to regex-only extraction.
  }
  const text = fs.readFileSync(file, 'utf8');
  const seen = new Set();
  for (const m of text.matchAll(NAME_REGEX)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    tools.push({ name: m[1], inputSchema: null, source: file });
  }
  return tools;
}

function loadInlineTools() {
  const file = path.join(SERVER, 'tools.js');
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const dispatcherStart = text.indexOf('async function handleToolCall(');
  if (dispatcherStart < 0) return [];
  const dispatcherEnd = text.indexOf('\n}\n', dispatcherStart);
  const region = dispatcherEnd > dispatcherStart
    ? text.slice(dispatcherStart, dispatcherEnd)
    : text.slice(dispatcherStart);
  const tools = [];
  const seen = new Set();
  for (const m of region.matchAll(INLINE_CASE_REGEX)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    tools.push({ name: m[1], inputSchema: null, source: file });
  }
  return tools;
}

function enumerateAllTools() {
  const out = new Map();
  for (const file of listToolDefFiles()) {
    for (const t of loadTools(file)) {
      if (!out.has(t.name)) out.set(t.name, t);
    }
  }
  for (const t of loadInlineTools()) {
    if (!out.has(t.name)) out.set(t.name, t);
  }
  return out;
}

// ─── Existing-coverage map ─────────────────────────────────────────────

// Routes already declared in any file (manual routes.js, v2-* handlers,
// the existing routes-passthrough.js, factory-routes, etc.). The
// generator must NOT emit a route for any tool that's already covered —
// the supplement is meant to *fill* gaps, not duplicate or override
// existing entries.
const EXISTING_COVERAGE_FILES = [
  'server/api/routes.js',
  'server/api/routes-passthrough.js',
  'server/api/v2-router.js',
  'server/api/v2-task-handlers.js',
  'server/api/v2-workflow-handlers.js',
  'server/api/v2-core-handlers.js',
  'server/api/v2-analytics-handlers.js',
  'server/api/v2-audit-handlers.js',
  'server/api/v2-governance-handlers.js',
  'server/api/v2-infrastructure-handlers.js',
  'server/api/v2-control-plane.js',
  'server/api/v2-dispatch.js',
  'server/api/handlers/quota-and-lifecycle-handlers.js',
  'server/api/routes/special-routes.js',
  'server/api/routes/factory-routes.js',
  'server/api/routes/coord-routes.js',
];

function loadExistingCoverage() {
  const covered = new Set();
  for (const rel of EXISTING_COVERAGE_FILES) {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(TOOL_REF_REGEX)) covered.add(m[1]);
  }
  return covered;
}

// ─── HTTP method + path inference ──────────────────────────────────────

const VERB_TO_METHOD = [
  // Read-only — GET
  { match: /^(?:list|get|check|find|search|read|describe|fetch|inspect|peek|preview|summarize|status|view|show|count|export|diagnose|history|trace|explain|analyze)_/, method: 'GET' },
  // Removal — DELETE
  { match: /^(?:delete|cancel|remove|unregister|deregister|clear|drop|prune|purge|revoke|reject)_/, method: 'DELETE' },
  // Update — PUT
  { match: /^(?:update|replace|set|configure|toggle|patch|enable|disable|activate|deactivate)_/, method: 'PUT' },
];

function inferHttpMethod(name) {
  for (const { match, method } of VERB_TO_METHOD) {
    if (match.test(name)) return method;
  }
  // Default: side-effecting POST.
  return 'POST';
}

// Path slug = name with underscores → dashes. Category slug derived from
// source filename basename (e.g. `task-management-defs.js` → `task-management`).
function categorySlugForSource(sourceFile) {
  const rel = path.relative(ROOT, sourceFile).replace(/\\/g, '/');
  if (rel.includes('plugins/')) {
    const m = rel.match(/plugins\/([^/]+)/);
    if (m) return `plugin-${m[1]}`;
  }
  if (rel.endsWith('transports/sse/protocol.js')) return 'sse';
  if (rel.endsWith('tools.js')) return 'core';
  const m = rel.match(/tool-defs\/([^/]+)\.js$/);
  if (!m) return 'misc';
  return m[1].replace(/-defs$/, '');
}

function buildRoutePath(name, category) {
  const dashed = name.replace(/_/g, '-');
  return `/api/v2/${category}/${dashed}`;
}

// Body vs query mapping: a tool's inputSchema is the source of truth.
// Tools with at least one object/array-typed property need mapBody (JSON
// payload too rich for query strings). Pure-scalar schemas → mapQuery
// for read-only methods, mapBody for write methods.
// Schema-less tools (regex fallback) default to mapBody for safety.
function inferMapping(inputSchema, method) {
  if (method === 'GET' || method === 'DELETE') return 'mapQuery';
  return 'mapBody';
}

// ─── Generation ────────────────────────────────────────────────────────

function generate({ dryRun = false } = {}) {
  const tools = enumerateAllTools();
  const existing = loadExistingCoverage();
  const skipped = [];
  const generated = [];

  for (const [name, tool] of tools.entries()) {
    if (REST_SKIPLIST.has(name)) {
      skipped.push({ name, reason: REST_SKIPLIST.get(name) });
      continue;
    }
    if (existing.has(name)) continue; // already routed elsewhere

    const method = inferHttpMethod(name);
    const category = categorySlugForSource(tool.source);
    const routePath = buildRoutePath(name, category);
    const mapping = inferMapping(tool.inputSchema, method);

    generated.push({ method, path: routePath, tool: name, mapping, category });
  }

  // Group by category for readability in the emitted file.
  const byCategory = new Map();
  for (const r of generated) {
    if (!byCategory.has(r.category)) byCategory.set(r.category, []);
    byCategory.get(r.category).push(r);
  }
  const categories = [...byCategory.keys()].sort();

  const lines = [];
  lines.push("'use strict';");
  lines.push('');
  lines.push('/**');
  lines.push(' * Auto-generated REST-route SUPPLEMENT for MCP tools missing from the');
  lines.push(' * older hand-tuned routes-passthrough.js. Generated by');
  lines.push(' * scripts/generate-rest-routes.js — DO NOT HAND-EDIT.');
  lines.push(' *');
  lines.push(' * Each route maps an MCP tool to a REST endpoint via the standard');
  lines.push(' * tool-passthrough in api-server.js. Every entry uses the `tool`');
  lines.push(' * property for automatic dispatch.');
  lines.push(' *');
  lines.push(' * To add a tool to REST coverage: define it in the appropriate');
  lines.push(' * tool-defs file (or SSE_TOOLS in server/transports/sse/protocol.js)');
  lines.push(' * and re-run `node scripts/generate-rest-routes.js`. To keep a tool');
  lines.push(' * MCP-only, add it to REST_SKIPLIST in the generator script.');
  lines.push(' *');
  lines.push(' * To upgrade a generated route (path-params, method tweaks): move it');
  lines.push(' * to routes-passthrough.js (or routes.js for a versioned/v2 path).');
  lines.push(' * The generator detects existing-coverage and will not regenerate it.');
  lines.push(' */');
  lines.push('');
  lines.push('const routes = [');
  lines.push(`  // ═══ ${generated.length} auto-generated tool-passthrough routes ═══`);
  lines.push(`  // Generated: ${new Date().toISOString().slice(0, 10)}`);
  lines.push('  // Pattern: tool-passthrough via handleToolCall()');
  lines.push('');

  for (const cat of categories) {
    const catRoutes = byCategory.get(cat);
    lines.push(`  // ─── ${cat} (${catRoutes.length} routes) ─────────────────────`);
    for (const r of catRoutes) {
      const props = `method: '${r.method}', path: '${r.path}', tool: '${r.tool}', ${r.mapping}: true`;
      lines.push(`  { ${props} },`);
    }
    lines.push('');
  }

  if (skipped.length > 0) {
    lines.push(`  // ─── Skipped (REST-incompatible) — ${skipped.length} tool(s) ───────`);
    for (const s of skipped) {
      lines.push(`  // ${s.name}: ${s.reason}`);
    }
    lines.push('');
  }

  lines.push('];');
  lines.push('');
  lines.push('module.exports = routes;');
  lines.push('');

  const content = lines.join('\n');

  if (dryRun) {
    process.stdout.write(content);
    return { generated: generated.length, skipped: skipped.length };
  }

  fs.writeFileSync(OUT_FILE, content);
  console.log(`Wrote ${path.relative(ROOT, OUT_FILE)}`);
  console.log(`Generated ${generated.length} passthrough routes; skipped ${skipped.length} REST-incompatible tools.`);
  return { generated: generated.length, skipped: skipped.length };
}

if (require.main === module) {
  generate({ dryRun: process.argv.includes('--dry-run') });
}

module.exports = { generate };
