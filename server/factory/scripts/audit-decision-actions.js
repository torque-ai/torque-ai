'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SOURCE_GLOBS = [
  'server/factory',
  'server/plugins/auto-recovery-core',
];

// Match every form of decision-log call observed in the codebase:
//   logDecision({...})           — server/factory/decision-log.js
//   logDecision(db, {...})       — server/factory/auto-recovery/engine.js
//   logDecisionFn({...})         — alias binding in loop-controller.js (one site)
//   safeLogDecision({...})       — wrapper in loop-controller.js + worktree-auto-commit.js (most calls)
// The `(?:safeL|l)` alternation handles the case difference: `safeLogDecision`
// has capital L after the `safe` prefix, while bare `logDecision` is lowercase.
// `\w*` after `ogDecision` covers `logDecisionFn` and any future suffix variants.
// Word boundary `\b` prevents accidental matches inside unrelated identifiers
// like `MyLogDecision` or `pologDecision`.
const EMIT_LITERAL_RE = /\b(?:safeL|l)ogDecision\w*\s*\(\s*(?:[a-zA-Z_$][\w$]*\s*,\s*)?\{[^}]*\baction\s*:\s*['"]([\w-]+)['"]/g;

// Match the same call shapes where action: is followed by a non-string-literal expression.
const EMIT_DYNAMIC_RE = /\b(?:safeL|l)ogDecision\w*\s*\(\s*(?:[a-zA-Z_$][\w$]*\s*,\s*)?\{[^}]*\baction\s*:\s*(?!['"])([^,}\n]+)/g;

// Audit script's own filename — exclude from self-scan so doc-comment examples
// don't get parsed as real emit sites.
const SELF_FILENAME = 'audit-decision-actions.js';

function* walkJsFiles(rootDir) {
  const stack = [rootDir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const ent of entries) {
      const abs = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
        stack.push(abs);
      } else if (
        ent.isFile()
        && ent.name.endsWith('.js')
        && !ent.name.endsWith('.test.js')
        && ent.name !== SELF_FILENAME
      ) {
        yield abs;
      }
    }
  }
}

function fileLineFromIndex(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

function discoverEmitSites(rootDir, sourceGlobs = SOURCE_GLOBS) {
  const literal_emissions = new Map();
  const dynamic_action_sites = [];

  const resolvedRoots = sourceGlobs
    .map((g) => path.join(rootDir, g))
    .filter((p) => fs.existsSync(p));
  const rootsToWalk = resolvedRoots.length > 0 ? resolvedRoots : [rootDir];

  for (const root of rootsToWalk) {
    for (const file of walkJsFiles(root)) {
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (e) {
        continue;
      }

      EMIT_LITERAL_RE.lastIndex = 0;
      let m;
      while ((m = EMIT_LITERAL_RE.exec(text)) !== null) {
        const action = m[1];
        const line = fileLineFromIndex(text, m.index);
        const arr = literal_emissions.get(action) || [];
        arr.push({ file: path.relative(rootDir, file), line });
        literal_emissions.set(action, arr);
      }

      EMIT_DYNAMIC_RE.lastIndex = 0;
      while ((m = EMIT_DYNAMIC_RE.exec(text)) !== null) {
        const slice = text.slice(m.index, m.index + 200);
        if (/action\s*:\s*['"]/.test(slice)) continue;

        const line = fileLineFromIndex(text, m.index);
        const snippet = m[1].trim().slice(0, 80);
        dynamic_action_sites.push({ file: path.relative(rootDir, file), line, snippet });
      }
    }
  }

  return { literal_emissions, dynamic_action_sites };
}

// Matches both `id: 'rule_name'` (fixture shape) and `name: 'rule_name'` (real shape).
// The block extends until the next id/name key or end of string.
const RULE_BLOCK_RE = /\b(?:id|name)\s*:\s*['"]([\w-]+)['"][\s\S]*?(?=\b(?:id|name)\s*:\s*['"]|$)/g;

// Matches function-style action checks: decision.action === 'foo' or d.action === 'foo'
const MATCH_FN_ACTION_RE = /\.\baction\s*===\s*['"]([\w-]+)['"]/g;
// Matches object-style action field: action: 'foo' (inside a match: { ... } block)
const MATCH_OBJ_ACTION_RE = /\baction\s*:\s*['"]([\w-]+)['"]/g;

function discoverClassifierRules(rootDir) {
  const rule_ids = new Set();
  const action_matchers = new Map();

  const rulesFile = path.join(rootDir, 'server/plugins/auto-recovery-core/rules.js');
  if (!fs.existsSync(rulesFile)) {
    return { rule_ids, action_matchers };
  }

  const text = fs.readFileSync(rulesFile, 'utf8');

  // action_matchers stores Map<action, rule_id[]> — multiple rules matching the
  // same action is a structural finding the audit tool should surface, not
  // silently overwrite. Callers can len-check the array for collisions.
  function recordMatcher(action, ruleId) {
    const existing = action_matchers.get(action) || [];
    if (!existing.includes(ruleId)) existing.push(ruleId);
    action_matchers.set(action, existing);
  }

  RULE_BLOCK_RE.lastIndex = 0;
  let bm;
  while ((bm = RULE_BLOCK_RE.exec(text)) !== null) {
    const ruleId = bm[1];
    rule_ids.add(ruleId);
    const block = bm[0];

    // Extract actions from function-style match: decision.action === 'foo'
    MATCH_FN_ACTION_RE.lastIndex = 0;
    let am;
    while ((am = MATCH_FN_ACTION_RE.exec(block)) !== null) {
      recordMatcher(am[1], ruleId);
    }

    // Extract actions from object-style match: { action: 'foo' }
    // Only scan within the match/match_fn block to avoid picking up the rule name itself
    const matchBlockRe = /\bmatch(?:_fn)?\s*:\s*\{([^}]*)\}/g;
    matchBlockRe.lastIndex = 0;
    let mb;
    while ((mb = matchBlockRe.exec(block)) !== null) {
      MATCH_OBJ_ACTION_RE.lastIndex = 0;
      let ma;
      while ((ma = MATCH_OBJ_ACTION_RE.exec(mb[1])) !== null) {
        recordMatcher(ma[1], ruleId);
      }
    }
  }

  return { rule_ids, action_matchers };
}

const BENIGN_EXACT_BLOCK_RE = /BENIGN_FLOW_ACTION_EXACT\s*=\s*new\s+Set\s*\(\s*\[([^\]]*)\]/;
const BENIGN_PREFIX_BLOCK_RE = /BENIGN_FLOW_ACTION_PREFIXES\s*=\s*\[([^\]]*)\]/;

function discoverBenignPatterns(rootDir) {
  const exact = new Set();
  const prefixes = new Set();

  const engineFile = path.join(rootDir, 'server/factory/auto-recovery/engine.js');
  if (!fs.existsSync(engineFile)) {
    return { exact, prefixes };
  }

  const text = fs.readFileSync(engineFile, 'utf8');

  const exactMatch = text.match(BENIGN_EXACT_BLOCK_RE);
  if (exactMatch) {
    const items = exactMatch[1].matchAll(/['"]([\w-]+)['"]/g);
    for (const m of items) exact.add(m[1]);
  }

  const prefixMatch = text.match(BENIGN_PREFIX_BLOCK_RE);
  if (prefixMatch) {
    const items = prefixMatch[1].matchAll(/['"]([\w-]+)['"]/g);
    for (const m of items) prefixes.add(m[1]);
  }

  return { exact, prefixes };
}

function actionMatchedByBenign(action, benign) {
  if (benign.exact.has(action)) return true;
  for (const prefix of benign.prefixes) {
    if (action.startsWith(prefix)) return true;
  }
  return false;
}

function actionMatchedByClassifier(action, classifier_rules) {
  return classifier_rules.action_matchers.has(action);
}

function runDecisionActionsAudit({ rootDir, catalog }) {
  const emit = discoverEmitSites(rootDir);
  const classifier_rules = discoverClassifierRules(rootDir);
  const benign = discoverBenignPatterns(rootDir);

  const emittedSet = new Set(emit.literal_emissions.keys());
  const catalogSet = new Set(Object.keys(catalog));

  const emitted_not_in_catalog = [];
  const emitted_no_classifier = [];
  const rule_id_mismatch = [];
  const catalog_not_emitted = [];

  for (const action of emittedSet) {
    if (!catalogSet.has(action)) emitted_not_in_catalog.push(action);
  }

  for (const action of emittedSet) {
    const entry = catalog[action];
    if (!entry) continue;
    const kind = entry.classifier;
    if (kind === 'benign') {
      if (!actionMatchedByBenign(action, benign)) emitted_no_classifier.push(action);
    } else if (kind === 'recovery-rule') {
      if (!actionMatchedByClassifier(action, classifier_rules)) emitted_no_classifier.push(action);
    } else if (kind === 'b-side-reject' || kind === 'terminal' || kind === 'engine') {
      // No runtime classifier check required for these kinds — the catalog
      // entry IS the contract.
    } else {
      emitted_no_classifier.push(action);
    }
  }

  for (const [action, entry] of Object.entries(catalog)) {
    if (entry.classifier !== 'recovery-rule') continue;
    if (!entry.rule_id) {
      // Catalog malformation: recovery-rule entry must declare rule_id.
      // Surface as a mismatch with explicit null rather than skipping silently.
      rule_id_mismatch.push({ action, catalog_rule_id: null });
      continue;
    }
    if (!classifier_rules.rule_ids.has(entry.rule_id)) {
      rule_id_mismatch.push({ action, catalog_rule_id: entry.rule_id });
    }
  }

  for (const action of catalogSet) {
    if (!emittedSet.has(action)) catalog_not_emitted.push(action);
  }

  const hasGaps =
    emitted_not_in_catalog.length > 0
    || emitted_no_classifier.length > 0
    || rule_id_mismatch.length > 0
    || catalog_not_emitted.length > 0;

  return {
    emitted_not_in_catalog,
    emitted_no_classifier,
    rule_id_mismatch,
    catalog_not_emitted,
    dynamic_action_sites: emit.dynamic_action_sites,
    literal_emissions: emit.literal_emissions,
    hasGaps,
  };
}

function prettyPrintReport(report, opts = {}) {
  const lines = [];
  lines.push('=== factory_decisions audit ===');
  lines.push('');
  lines.push(`Total literal emit sites: ${report.literal_emissions.size}`);
  lines.push(`Dynamic-action sites: ${report.dynamic_action_sites.length}`);
  lines.push('');

  if (report.emitted_not_in_catalog.length > 0) {
    lines.push(`emitted_not_in_catalog (${report.emitted_not_in_catalog.length}):`);
    for (const action of report.emitted_not_in_catalog) {
      lines.push(`  - ${action}`);
      if (opts.detail) {
        const sites = report.literal_emissions.get(action) || [];
        for (const s of sites) lines.push(`      ${s.file}:${s.line}`);
      }
    }
    lines.push('');
  }

  if (report.emitted_no_classifier.length > 0) {
    lines.push(`emitted_no_classifier (${report.emitted_no_classifier.length}):`);
    for (const action of report.emitted_no_classifier) {
      lines.push(`  - ${action}`);
      if (opts.detail) {
        const sites = report.literal_emissions.get(action) || [];
        for (const s of sites) lines.push(`      ${s.file}:${s.line}`);
      }
    }
    lines.push('');
  }

  if (report.rule_id_mismatch.length > 0) {
    lines.push(`rule_id_mismatch (${report.rule_id_mismatch.length}):`);
    for (const { action, catalog_rule_id } of report.rule_id_mismatch) {
      if (catalog_rule_id === null) {
        lines.push(`  - ${action} -> missing rule_id field (catalog malformation)`);
      } else {
        lines.push(`  - ${action} -> rule_id "${catalog_rule_id}" not found in rules.js`);
      }
    }
    lines.push('');
  }

  if (report.catalog_not_emitted.length > 0) {
    lines.push(`catalog_not_emitted (${report.catalog_not_emitted.length}):`);
    for (const action of report.catalog_not_emitted) {
      lines.push(`  - ${action}`);
    }
    lines.push('');
  }

  if (report.dynamic_action_sites.length > 0 && opts.detail) {
    lines.push(`dynamic_action_sites (${report.dynamic_action_sites.length}):`);
    for (const site of report.dynamic_action_sites) {
      lines.push(`  - ${site.file}:${site.line}  ${site.snippet}`);
    }
    lines.push('');
  }

  if (!report.hasGaps) {
    lines.push('All gap categories empty.');
  }

  return lines.join('\n');
}

if (require.main === module) {
  const detail = process.argv.includes('--gap-detail');
  const rootDir = process.cwd();
  const catalogPath = path.join(rootDir, 'server/factory/decision-actions.js');
  let catalog = {};
  if (fs.existsSync(catalogPath)) {
    // eslint-disable-next-line global-require
    catalog = require(catalogPath).DECISION_ACTIONS || {};
  }
  const report = runDecisionActionsAudit({ rootDir, catalog });
  process.stdout.write(prettyPrintReport(report, { detail }) + '\n');
  process.exit(report.hasGaps ? 1 : 0);
}

module.exports = {
  discoverEmitSites,
  discoverClassifierRules,
  discoverBenignPatterns,
  runDecisionActionsAudit,
  prettyPrintReport,
  __internals: { walkJsFiles, fileLineFromIndex },
};
