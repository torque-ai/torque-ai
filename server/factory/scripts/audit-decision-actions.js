'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SOURCE_GLOBS = [
  'server/factory',
  'server/plugins/auto-recovery-core',
];

// Match logDecision({ ... action: 'foo' ... }), logDecision(db, { ... action: 'foo' ... }),
// and aliased forms like logDecisionFn(...) used in some emit sites. The \w*
// suffix lets us catch `logDecisionFn` (loop-controller.js) without re-introducing
// the `logDecision\s*\(` literal that triggered self-scan false positives.
const EMIT_LITERAL_RE = /logDecision\w*\s*\(\s*(?:[a-zA-Z_$][\w$]*\s*,\s*)?\{[^}]*\baction\s*:\s*['"]([\w-]+)['"]/g;

// Match logDecision*(...) calls where action: is followed by a non-string-literal expression.
const EMIT_DYNAMIC_RE = /logDecision\w*\s*\(\s*(?:[a-zA-Z_$][\w$]*\s*,\s*)?\{[^}]*\baction\s*:\s*(?!['"])([^,}\n]+)/g;

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

module.exports = {
  discoverEmitSites,
  discoverClassifierRules,
  discoverBenignPatterns,
  runDecisionActionsAudit,
  __internals: { walkJsFiles, fileLineFromIndex },
};
