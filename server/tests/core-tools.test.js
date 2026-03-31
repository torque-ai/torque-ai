const fs = require('fs');
const path = require('path');

const { CORE_TOOL_NAMES, EXTENDED_TOOL_NAMES, TIER_1, TIER_2, getToolNamesForTier } = require('../core-tools');

function getToolDefinitionNames() {
  const toolDefDir = path.join(__dirname, '../tool-defs');
  const toolDefFiles = fs
    .readdirSync(toolDefDir)
    .filter((f) => f.endsWith('.js'))
    .sort();

  const definitionNames = [];
  for (const file of toolDefFiles) {
    const defs = require(path.join(toolDefDir, file));
    expect(Array.isArray(defs)).toBe(true);
    for (const def of defs) {
      definitionNames.push(def && def.name);
    }
  }

  return definitionNames;
}

function buildRouteToolMapFromTools() {
  const toolsSource = fs.readFileSync(path.join(__dirname, '../tools.js'), 'utf8');
  const blockMatch = toolsSource.match(/const\s+HANDLER_MODULES\s*=\s*\[(.*?)\];/s);
  expect(blockMatch).not.toBeNull();

  const block = blockMatch[1];
  const moduleNames = Array.from(block.matchAll(/require\(\s*['"]\.\/handlers\/([^'"]+)['"]\s*\)/g))
    .map((m) => m[1]);

  const routeMap = new Map();

  const pascalToSnake = (s) => s.replace(/([A-Z])/g, (m, c, i) => (i > 0 ? '_' : '') + c.toLowerCase());
  const fixups = {
    export_report_c_s_v: 'export_report_csv',
    export_report_j_s_o_n: 'export_report_json',
    link_git_hub_issue: 'link_github_issue',
    list_git_hub_issues: 'list_github_issues',
    run_l_l_m_safeguards: 'run_llm_safeguards',
    configure_l_l_m_safeguards: 'configure_llm_safeguards',
  };

  for (const handlerName of moduleNames) {
    const mod = require(path.join(__dirname, `../handlers/${handlerName}`));
    for (const [fnName, fn] of Object.entries(mod)) {
      if (!fnName.startsWith('handle') || typeof fn !== 'function') continue;
      let toolName = pascalToSnake(fnName.slice(6));
      toolName = fixups[toolName] || toolName;
      routeMap.set(toolName, fn);
    }
  }

  routeMap.set('ping', () => ({}));
  routeMap.set('restart_server', () => ({}));
  routeMap.set('unlock_all_tools', () => ({}));
  routeMap.set('unlock_tier', () => ({}));

  return routeMap;
}

describe('CORE_TOOL_NAMES (Tier 1)', () => {
  it('exists and is an array', () => {
    expect(Array.isArray(CORE_TOOL_NAMES)).toBe(true);
  });

  it('is not empty', () => {
    expect(CORE_TOOL_NAMES.length).toBeGreaterThan(0);
  });

  it('contains only non-empty, trimmed, snake_case strings', () => {
    expect(CORE_TOOL_NAMES.every((name) =>
      typeof name === 'string' && name.trim() === name && name.length > 0 && /^[a-z0-9_]+$/.test(name)
    )).toBe(true);
  });

  it('has no duplicate names', () => {
    const uniq = new Set(CORE_TOOL_NAMES);
    expect(uniq.size).toBe(CORE_TOOL_NAMES.length);
  });

  it('stays under 40 tools (Tier 1 target)', () => {
    expect(CORE_TOOL_NAMES.length).toBeLessThan(40);
  });

  it('includes essential meta tools', () => {
    expect(CORE_TOOL_NAMES).toEqual(
      expect.arrayContaining(['ping', 'restart_server', 'await_restart', 'unlock_all_tools', 'unlock_tier']),
    );
  });

  it('includes essential task lifecycle tools', () => {
    expect(CORE_TOOL_NAMES).toEqual(
      expect.arrayContaining(['submit_task', 'cancel_task', 'task_info', 'list_tasks']),
    );
  });

  it('includes essential workflow tools', () => {
    expect(CORE_TOOL_NAMES).toEqual(
      expect.arrayContaining(['create_workflow', 'run_workflow', 'await_workflow', 'await_task', 'await_restart']),
    );
  });

  it('all core tools have matching tool definitions', () => {
    const defNames = getToolDefinitionNames();
    const defSet = new Set(defNames);
    const missing = CORE_TOOL_NAMES.filter((name) => !defSet.has(name));
    expect(missing).toEqual([]);
  });

  it('all core tools have matching handler functions', () => {
    const routeMap = buildRouteToolMapFromTools();
    const missing = CORE_TOOL_NAMES.filter((name) => !routeMap.has(name));
    expect(missing).toEqual([]);
  });
});

describe('EXTENDED_TOOL_NAMES (Tier 1 + 2)', () => {
  it('is a superset of CORE_TOOL_NAMES', () => {
    for (const name of CORE_TOOL_NAMES) {
      expect(EXTENDED_TOOL_NAMES).toContain(name);
    }
  });

  it('stays under 100 tools', () => {
    expect(EXTENDED_TOOL_NAMES.length).toBeLessThan(100);
  });

  it('has no duplicate names', () => {
    const uniq = new Set(EXTENDED_TOOL_NAMES);
    expect(uniq.size).toBe(EXTENDED_TOOL_NAMES.length);
  });

  it('contains only non-empty, trimmed, snake_case strings', () => {
    expect(EXTENDED_TOOL_NAMES.every((name) =>
      typeof name === 'string' && name.trim() === name && name.length > 0 && /^[a-z0-9_]+$/.test(name)
    )).toBe(true);
  });

  it('all extended tools have matching tool definitions', () => {
    const defNames = getToolDefinitionNames();
    const defSet = new Set(defNames);
    const missing = EXTENDED_TOOL_NAMES.filter((name) => !defSet.has(name));
    expect(missing).toEqual([]);
  });

  it('does not include SnapScope/Peek tools now that they live in the plugin', () => {
    expect(EXTENDED_TOOL_NAMES).not.toEqual(
      expect.arrayContaining(['peek_ui', 'peek_interact', 'capture_screenshots']),
    );
    expect(CORE_TOOL_NAMES).not.toContain('peek_ui');
  });

  it('includes batch orchestration tools in Tier 2', () => {
    expect(EXTENDED_TOOL_NAMES).toEqual(
      expect.arrayContaining(['run_batch', 'generate_test_tasks']),
    );
  });
});

describe('TIER_1 and TIER_2 arrays', () => {
  it('TIER_1 and TIER_2 have no overlap', () => {
    const tier1Set = new Set(TIER_1);
    const overlap = TIER_2.filter((name) => tier1Set.has(name));
    expect(overlap).toEqual([]);
  });

  it('TIER_1 + TIER_2 equals EXTENDED_TOOL_NAMES', () => {
    expect([...TIER_1, ...TIER_2]).toEqual(EXTENDED_TOOL_NAMES);
  });
});

describe('getToolNamesForTier()', () => {
  it('tier 1 returns TIER_1 tools', () => {
    const names = getToolNamesForTier(1);
    expect(names).toEqual(TIER_1);
  });

  it('tier 2 returns TIER_1 + TIER_2 tools', () => {
    const names = getToolNamesForTier(2);
    expect(names).toEqual([...TIER_1, ...TIER_2]);
  });

  it('tier 3 returns the full combined tool list', () => {
    expect(getToolNamesForTier(3)).toEqual([...TIER_1, ...TIER_2]);
  });
});

describe('tool definitions integrity', () => {
  it('tool definitions do not include duplicate names', () => {
    const defNames = getToolDefinitionNames();
    const seen = new Set();
    const dupes = [];
    for (const name of defNames) {
      if (seen.has(name)) dupes.push(name);
      seen.add(name);
    }
    expect(dupes).toEqual([]);
  });

  it('tool definitions contain only string names', () => {
    const defNames = getToolDefinitionNames();
    expect(defNames.every((name) => typeof name === 'string' && name.length > 0)).toBe(true);
  });

  it('all tool-definition modules are arrays of objects', () => {
    const toolDefDir = path.join(__dirname, '../tool-defs');
    const toolDefFiles = fs
      .readdirSync(toolDefDir)
      .filter((f) => f.endsWith('.js'))
      .sort();
    for (const file of toolDefFiles) {
      const defs = require(path.join(toolDefDir, file));
      expect(Array.isArray(defs)).toBe(true);
      defs.forEach((def) => expect(typeof def).toBe('object'));
    }
  });
});
