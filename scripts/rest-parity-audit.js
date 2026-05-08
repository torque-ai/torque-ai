#!/usr/bin/env node
'use strict';

// rest-parity-audit — enumerate MCP tools (server/tool-defs/ + plugins),
// enumerate REST→tool mappings (server/api/routes.js + v2-router.js +
// related handler files), diff to surface gaps, write a markdown report
// to docs/rest-parity-gap-report.md.
//
// Run: node scripts/rest-parity-audit.js [--json]

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'server');

// ─── MCP tool enumeration ──────────────────────────────────────────────

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
      // Catch both `tool-defs.js` and `new-tool-defs.js` shapes (snapscope ships both).
      for (const name of fs.readdirSync(pluginDir)) {
        if (/(?:^|-)tool-defs(?:\.|$)/.test(name) && name.endsWith('.js')) {
          files.push(path.join(pluginDir, name));
        }
      }
    }
  }
  // SSE transport defines its own tool array (SSE_TOOLS) for session-scoped
  // tools like `subscribe_task_events` and `check_notifications`. Same
  // tool-def shape, just lives outside the tool-defs/ tree.
  const sseProtocol = path.join(SERVER, 'transports', 'sse', 'protocol.js');
  if (fs.existsSync(sseProtocol)) files.push(sseProtocol);
  return files;
}

// Tools that don't live in any tool-defs file but ARE registered by name
// in `server/tools.js`'s inline switch dispatcher (the small set that the
// server-level `handleToolCall` handles directly: ping, restart_server,
// restart_status, get_task_log_disk_usage, unlock_all_tools, get_tool_schema,
// unlock_tier, coord_status, …). Without this scan they'd appear as
// "orphan routes" in the diff. We extract them via regex on the same
// `case 'name':` shape the dispatcher uses, scoped to the dispatcher
// function so we don't pick up unrelated string literals elsewhere in
// the file.
const INLINE_CASE_REGEX = /\bcase\s+['"`]([a-z_][a-z_0-9]*)['"`]\s*:/g;

function extractInlineToolNames() {
  const file = path.join(SERVER, 'tools.js');
  if (!fs.existsSync(file)) return new Set();
  const text = fs.readFileSync(file, 'utf8');
  // Slice to the dispatcher body to avoid matching JSON-schema branches
  // (`case 'string':`, `case 'number':`, etc.) that sit elsewhere in the file.
  const dispatcherStart = text.indexOf('async function handleToolCall(');
  if (dispatcherStart < 0) return new Set();
  const dispatcherEnd = text.indexOf('\n}\n', dispatcherStart);
  const region = dispatcherEnd > dispatcherStart
    ? text.slice(dispatcherStart, dispatcherEnd)
    : text.slice(dispatcherStart);
  const names = new Set();
  let m;
  while ((m = INLINE_CASE_REGEX.exec(region)) !== null) names.add(m[1]);
  return names;
}

// Tool defs are JS modules — easiest reliable extraction is regex on
// `name: 'foo'` patterns, since they live inside object literals with
// description/inputSchema. Tolerates single/double/backtick value quotes
// and both bare-key (`name:`) and JSON-style quoted-key shapes
// (`"name":` / `'name':`) — task-management-defs / task-submission-defs
// use the quoted-key shape, the rest use bare keys. The leading boundary
// is `(?:^|[\s,{(])` so we match in object literals but not as a suffix
// of identifiers like `clientName` or `pluginName`.
const NAME_REGEX = /(?:^|[\s,{(])["']?name["']?\s*:\s*['"`]([a-z_][a-z_0-9]*)['"`]/g;

function extractToolNamesFromFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const names = new Set();
  let m;
  while ((m = NAME_REGEX.exec(text)) !== null) names.add(m[1]);
  return names;
}

function enumerateMcpTools() {
  const files = listToolDefFiles();
  const allTools = new Map(); // name → array of source files
  for (const file of files) {
    const names = extractToolNamesFromFile(file);
    const rel = path.relative(ROOT, file);
    for (const name of names) {
      if (!allTools.has(name)) allTools.set(name, []);
      allTools.get(name).push(rel);
    }
  }
  // Inline-dispatched tools in server/tools.js — count them as defined
  // even if they don't have a tool-defs entry (most do, but the inline
  // entry is what makes them dispatchable, so it's a valid source).
  const inlineNames = extractInlineToolNames();
  for (const name of inlineNames) {
    if (!allTools.has(name)) allTools.set(name, []);
    if (!allTools.get(name).includes('server/tools.js')) {
      allTools.get(name).push('server/tools.js');
    }
  }
  return allTools;
}

// ─── REST route enumeration ────────────────────────────────────────────

const REST_FILES = [
  'server/api/routes.js',
  'server/api/routes-passthrough.js',
  'server/api/routes-generated-supplement.js',
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

const TOOL_REF_REGEX = /tool\s*:\s*['"`]([a-z_][a-z_0-9]*)['"`]/g;

function enumerateRestToolMappings() {
  const restMap = new Map(); // tool name → array of source files
  for (const rel of REST_FILES) {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    let m;
    while ((m = TOOL_REF_REGEX.exec(text)) !== null) {
      const name = m[1];
      if (!restMap.has(name)) restMap.set(name, []);
      const entry = restMap.get(name);
      if (!entry.includes(rel)) entry.push(rel);
    }
  }
  return restMap;
}

// ─── Gap analysis ──────────────────────────────────────────────────────

// Categorize gaps by tool-defs source file (which is a stable proxy for
// the tool's domain — codegraph, factory, scheduling, etc.).
function categoryFromSource(sourceFiles) {
  for (const s of sourceFiles) {
    if (s.includes('plugins/codegraph')) return 'plugin: codegraph';
    if (s.includes('plugins/snapscope')) return 'plugin: snapscope';
    if (s.includes('plugins/version-control')) return 'plugin: version-control';
    if (s.includes('plugins/remote-agents')) return 'plugin: remote-agents';
    if (s.includes('plugins/model-freshness')) return 'plugin: model-freshness';
  }
  const first = sourceFiles[0];
  const m = first.match(/tool-defs[\/\\]([^/\\]+)\.js$/);
  return m ? `core: ${m[1]}` : `core: ${path.basename(first, '.js')}`;
}

function analyze() {
  const mcp = enumerateMcpTools();
  const rest = enumerateRestToolMappings();

  const covered = [];
  const gaps = [];
  for (const [name, sources] of mcp.entries()) {
    if (rest.has(name)) {
      covered.push({ name, sources, restSources: rest.get(name) });
    } else {
      gaps.push({ name, sources, category: categoryFromSource(sources) });
    }
  }
  const orphanedRoutes = [];
  for (const [name, sources] of rest.entries()) {
    if (!mcp.has(name)) orphanedRoutes.push({ name, restSources: sources });
  }

  const gapsByCategory = new Map();
  for (const g of gaps) {
    if (!gapsByCategory.has(g.category)) gapsByCategory.set(g.category, []);
    gapsByCategory.get(g.category).push(g);
  }

  return {
    totals: {
      mcp_tools: mcp.size,
      rest_mapped: rest.size,
      covered: covered.length,
      gaps: gaps.length,
      orphaned_routes: orphanedRoutes.length,
    },
    covered,
    gaps,
    gapsByCategory,
    orphanedRoutes,
  };
}

// ─── Report rendering ──────────────────────────────────────────────────

function renderMarkdown(result) {
  const { totals, gapsByCategory, orphanedRoutes } = result;
  const lines = [];
  lines.push('# REST-parity gap report');
  lines.push('');
  lines.push(`Generated by \`scripts/rest-parity-audit.js\` on ${new Date().toISOString()}.`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`| Metric | Count |`);
  lines.push(`|---|---|`);
  lines.push(`| MCP tools defined (across \`server/tool-defs/\` + plugin \`tool-defs.js\`) | ${totals.mcp_tools} |`);
  lines.push(`| MCP tools with a REST mapping (\`tool: 'name'\` in any route file) | ${totals.covered} |`);
  lines.push(`| **MCP tools missing REST coverage (gap)** | **${totals.gaps}** |`);
  lines.push(`| Distinct \`tool:\` references in route files | ${totals.rest_mapped} |`);
  lines.push(`| REST routes pointing at non-existent tools (drift) | ${totals.orphaned_routes} |`);
  lines.push('');
  lines.push(`Coverage: **${((totals.covered / totals.mcp_tools) * 100).toFixed(1)}%**`);
  lines.push('');

  const categories = [...gapsByCategory.entries()].sort((a, b) => b[1].length - a[1].length);
  lines.push('## Gaps by category');
  lines.push('');
  lines.push(`| Category | Tools without REST | First few |`);
  lines.push(`|---|---|---|`);
  for (const [cat, list] of categories) {
    const sample = list.slice(0, 5).map(g => `\`${g.name}\``).join(', ');
    lines.push(`| ${cat} | ${list.length} | ${sample}${list.length > 5 ? ', …' : ''} |`);
  }
  lines.push('');

  lines.push('## Full gap list');
  lines.push('');
  for (const [cat, list] of categories) {
    lines.push(`### ${cat} (${list.length})`);
    lines.push('');
    for (const g of list.sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`- \`${g.name}\` — defined in ${g.sources.map(s => `\`${s}\``).join(', ')}`);
    }
    lines.push('');
  }

  if (orphanedRoutes.length > 0) {
    lines.push('## Orphaned REST routes');
    lines.push('');
    lines.push('REST routes that proxy to a `tool:` name not found in any tool-defs file. Either the tool was renamed/removed (route should follow), or the tool lives outside the standard tool-defs directories (in which case the audit script should be extended).');
    lines.push('');
    for (const o of orphanedRoutes.sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`- \`${o.name}\` — referenced by ${o.restSources.map(s => `\`${s}\``).join(', ')}`);
    }
    lines.push('');
  }

  lines.push('## How to use this report');
  lines.push('');
  lines.push('- Treat each category as a phase. Phases with the most operational impact (lifecycle, scheduling, host management) come first.');
  lines.push('- Each new REST route belongs in `server/api/routes.js` (or the relevant `v2-*` handler file) using the existing declarative shape: `{ method, path, tool, mapBody | mapQuery | mapParams }`.');
  lines.push('- Re-run this script after each phase to track progress.');
  lines.push('');

  return lines.join('\n');
}

// ─── Entrypoint ────────────────────────────────────────────────────────

function main() {
  const result = analyze();
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify({
      totals: result.totals,
      gaps: result.gaps,
      orphaned_routes: result.orphanedRoutes,
    }, null, 2));
    process.stdout.write('\n');
    return;
  }
  const md = renderMarkdown(result);
  const outPath = path.join(ROOT, 'docs', 'rest-parity-gap-report.md');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, md);
  console.log(`Wrote ${path.relative(ROOT, outPath)}`);
  console.log(`MCP tools: ${result.totals.mcp_tools}, REST-covered: ${result.totals.covered}, gap: ${result.totals.gaps}, orphaned routes: ${result.totals.orphaned_routes}`);
}

main();
