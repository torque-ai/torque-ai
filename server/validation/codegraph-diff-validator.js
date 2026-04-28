'use strict';

// Post-Codex codegraph diff inspection.
//
// After verify_command passes for a Codex (or any) task, we additionally run
// cg_diff(baselineCommit, HEAD) on the working directory's repo and inspect:
//
//   1. signature_changed_symbols — a function that flipped sync→async or
//      gained/lost the exported flag is a CALLER-VISIBLE breaking change
//      that the task description usually doesn't mention. We surface those
//      whose names don't appear in the task description.
//
//   2. parse_errors — when the extractor throws on a file Codex wrote, the
//      file is borderline-syntactic. Tests may pass but downstream tooling
//      (codegraph indexer, IDE, future cg_diff calls) will choke on it.
//
// Soft signal only. We never flip the task to failed. The output gets
// annotated and tags get applied so the dashboard / QC can pick it up; the
// task still auto-commits if the rest of the pipeline is happy.
//
// Skip-silently policy mirrors codegraph-plan-augmenter: if codegraph isn't
// loaded, the index isn't built, either sha is unreachable, or any cg_* call
// throws / times out, we return an empty warning set and let the close path
// continue.

const childProcess = require('child_process');

const CG_DIFF_TIMEOUT_MS = 5_000;

const GIT_BASE_OPTS = Object.freeze({
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS:  '0',
    GIT_CONFIG_NOSYSTEM: '1',
  },
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); },
                 (e) => { clearTimeout(t); reject(e); });
  });
}

function defaultCodegraphHandlers() {
  try {
    const cg = require('../plugins/codegraph');
    const tools = typeof cg.mcpTools === 'function' ? cg.mcpTools() : [];
    if (!tools || !tools.length) return null;
    const map = {};
    for (const t of tools) map[t.name] = t.handler;
    if (!map.cg_diff) return null;
    return map;
  } catch {
    return null;
  }
}

function readStructured(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.structuredData) return result.structuredData;
  return null;
}

function readHeadSha(workingDirectory) {
  try {
    const out = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], {
      ...GIT_BASE_OPTS, cwd: workingDirectory, encoding: 'utf8',
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

// Filter signature changes to ones the task description doesn't mention by
// bare-symbol name. Mention can be backtick-quoted, free text, or qualified
// (foo() / Foo.bar / module.foo). We use a word-boundary substring check —
// false negatives (we keep too many warnings) are better than false positives
// (we hide a real breaking change).
function filterUndeclaredSignatureChanges(signatureChanged, taskDescription) {
  const desc = String(taskDescription || '');
  if (!desc) return signatureChanged.slice();
  const undeclared = [];
  for (const sig of signatureChanged) {
    const name = sig && typeof sig.name === 'string' ? sig.name : '';
    if (!name) continue;
    const re = new RegExp(`(?<![A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`);
    if (!re.test(desc)) undeclared.push(sig);
  }
  return undeclared;
}

function describeFlagChange(changed) {
  if (!changed || typeof changed !== 'object') return 'flag flip';
  const parts = [];
  for (const [k, v] of Object.entries(changed)) {
    if (v && typeof v === 'object' && 'from' in v && 'to' in v) {
      parts.push(`${k}: ${v.from}→${v.to}`);
    }
  }
  return parts.length > 0 ? parts.join(', ') : 'flag flip';
}

// Public entrypoint. Always resolves; never throws. Caller treats an empty
// warning list as "nothing to flag".
//
// Inputs:
//   repoPath           — abs path to the repo root (passed to cg_diff)
//   workingDirectory   — where to run `git rev-parse HEAD` from
//   fromSha            — pre-task baseline (ctx.proc.baselineCommit)
//   taskDescription    — used to filter signature changes the task already
//                        mentions; pass empty string to keep all of them
//   handlers           — optional cg handlers (test injection)
//
// Returns: { warnings, signature_undeclared, parse_errors,
//            from_sha, to_sha, ran }
//   ran=false when we couldn't run cg_diff at all (no codegraph, no shas, ...)
async function inspectPostTaskDiff({
  repoPath,
  workingDirectory,
  fromSha,
  taskDescription,
  handlers = null,
} = {}) {
  const empty = (extra = {}) => ({
    warnings: [],
    signature_undeclared: [],
    parse_errors: [],
    from_sha: null,
    to_sha: null,
    ran: false,
    ...extra,
  });

  if (typeof repoPath !== 'string' || !repoPath) return empty();
  if (typeof fromSha !== 'string' || !fromSha) return empty();

  const cg = handlers || defaultCodegraphHandlers();
  if (!cg) return empty();

  const toSha = readHeadSha(workingDirectory || repoPath);
  if (!toSha) return empty();
  if (toSha === fromSha) {
    // Codex made no commits — nothing to inspect. Common path for tasks
    // that produce only working-tree edits (those don't reach this code
    // anyway in the close handler).
    return empty({ from_sha: fromSha, to_sha: toSha });
  }

  let result;
  try {
    result = readStructured(await withTimeout(
      cg.cg_diff({ repo_path: repoPath, from_sha: fromSha, to_sha: toSha }),
      CG_DIFF_TIMEOUT_MS,
    ));
  } catch {
    return empty({ from_sha: fromSha, to_sha: toSha });
  }
  if (!result || typeof result !== 'object') {
    return empty({ from_sha: fromSha, to_sha: toSha });
  }

  const signatureChanged = Array.isArray(result.signature_changed_symbols)
    ? result.signature_changed_symbols
    : [];
  const parseErrors = Array.isArray(result.parse_errors) ? result.parse_errors : [];

  const undeclared = filterUndeclaredSignatureChanges(signatureChanged, taskDescription);
  const warnings = [];
  for (const sig of undeclared) {
    const name = sig && typeof sig.name === 'string' ? sig.name : '<unknown>';
    const file = sig && typeof sig.file === 'string' ? sig.file : '<unknown>';
    warnings.push({
      level: 'warn',
      code: 'cg_diff_signature_change_undeclared',
      symbol: name,
      file,
      changed: sig.changed,
      message:
        `\`${name}\` (${file}) flipped ${describeFlagChange(sig.changed)} during this task, ` +
        `but the task description does not mention \`${name}\`. ` +
        'This is a caller-visible contract change — review before auto-committing.',
    });
  }
  for (const pe of parseErrors) {
    const file = pe && typeof pe.file === 'string' ? pe.file : '<unknown>';
    const reason = pe && typeof pe.reason === 'string' ? pe.reason : 'parse';
    const errorMsg = pe && typeof pe.error === 'string' ? pe.error : '';
    warnings.push({
      level: 'warn',
      code: 'cg_diff_parse_error',
      file,
      reason,
      error: errorMsg,
      message:
        `Codegraph extractor failed on \`${file}\` (${reason}): ${errorMsg.slice(0, 120)}. ` +
        'The file may be syntactically borderline; downstream codegraph queries will skip it.',
    });
  }

  return {
    warnings,
    signature_undeclared: undeclared,
    parse_errors: parseErrors,
    from_sha: fromSha,
    to_sha: toSha,
    ran: true,
  };
}

module.exports = {
  inspectPostTaskDiff,
  filterUndeclaredSignatureChanges,
  defaultCodegraphHandlers,
  CG_DIFF_TIMEOUT_MS,
};
