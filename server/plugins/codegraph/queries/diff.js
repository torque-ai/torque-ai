'use strict';

const childProcess = require('child_process');
const { extractorFor, languageFor } = require('../extractors');

const GIT_BASE_OPTS = Object.freeze({
  windowsHide: true,
  env: {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS:  '0',
    GIT_CONFIG_NOSYSTEM: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

// Renames keep their (from, to) pair so the symbol-diff pass can extract
// both sides and set-diff against the NEW path. Splitting an R into
// {deleted: from, added: to} (the previous shape) reported every symbol in
// the renamed file as add+remove even when the content was byte-identical.
function gitDiffNameStatus(repoPath, fromSha, toSha) {
  const out = childProcess.execFileSync('git', [
    'diff', '--name-status', '-M50%', fromSha, toSha,
  ], { ...GIT_BASE_OPTS, cwd: repoPath, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const added = [], modified = [], deleted = [], renamed = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const parts = line.split('\t');
    const status = parts[0][0];
    if (status === 'A')       added.push(parts[1]);
    else if (status === 'M' || status === 'T') modified.push(parts[1]);
    else if (status === 'D')  deleted.push(parts[1]);
    else if (status === 'R') renamed.push({ from: parts[1], to: parts[2] });
    else if (status === 'C') { added.push(parts[2]); }
  }
  return { added, modified, deleted, renamed };
}

function gitShowFile(repoPath, sha, filePath) {
  return childProcess.execFileSync('git', ['show', `${sha}:${filePath}`], {
    ...GIT_BASE_OPTS, cwd: repoPath, maxBuffer: 32 * 1024 * 1024,
  });
}

function gitShaReachable(repoPath, sha) {
  // rev-parse --verify <sha>^{commit} forces a strict commit-existence check.
  // Plain `cat-file -e` is more lenient — it accepts unique short prefixes
  // and any object type (blob/tree/commit). The `^{commit}` peel ensures we
  // reject blob/tree shas that would let cgDiff proceed with a non-commit.
  try {
    childProcess.execFileSync('git', ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], {
      ...GIT_BASE_OPTS, cwd: repoPath,
    });
    return true;
  } catch {
    return false;
  }
}

// Identity: name + kind + container, scoped to a stable file key. For
// modifies the key uses the (single) path; for renames it uses the NEW
// path on both sides so the rename itself doesn't surface as add+remove.
// Excludes line numbers so a symbol that moves within a file is invariant.
function symbolKey(stableFile, sym) {
  return `${stableFile}|${sym.kind}|${sym.containerName || ''}|${sym.name}`;
}

function projectSymbol(file, sym) {
  return {
    name: sym.name,
    kind: sym.kind,
    file,
    line: sym.startLine,
    ...(sym.containerName ? { container: sym.containerName } : {}),
  };
}

// Boolean signature flags whose flips are real surface changes (e.g. a
// function going sync → async breaks every caller's await contract).
// The diff identity intentionally ignores these — flips show up in the
// `signature_changed_symbols` array instead, so a flag flip and a true
// add+remove aren't conflated.
const SIGNATURE_FLAGS = ['isAsync', 'isExported', 'isStatic', 'isGenerator'];

function flagsOf(sym) {
  const out = {};
  for (const f of SIGNATURE_FLAGS) out[f] = Boolean(sym[f]);
  return out;
}

function diffFlags(fromSym, toSym) {
  const changed = {};
  for (const f of SIGNATURE_FLAGS) {
    const a = Boolean(fromSym[f]);
    const b = Boolean(toSym[f]);
    if (a !== b) changed[f] = { from: a, to: b };
  }
  return Object.keys(changed).length > 0 ? changed : null;
}

// Extract symbols from a file's content. Returns:
//   - { symbols: [...] } on success
//   - { skipped: { reason: 'unsupported' } } when no extractor matches
//   - { skipped: { reason: 'parse', error: msg } } when the parser throws
// Mirrors the indexer.js try/catch policy so one corrupt or borderline
// file in the diff scope can't take the whole cg_diff call down.
async function symbolsForFile(content, filePath) {
  const ex = extractorFor(filePath);
  if (!ex) return { skipped: { file: filePath, reason: 'unsupported' } };
  const buffer = Buffer.isBuffer(content) ? content.toString('utf8') : String(content);
  try {
    const out = await ex.extract(buffer);
    return { symbols: Array.isArray(out?.symbols) ? out.symbols : [] };
  } catch (err) {
    return { skipped: { file: filePath, reason: 'parse', error: err.message } };
  }
}

// Compare symbol sets between two shas. Bounded to changed files only —
// fast for typical commits (10-100 files). Beyond `maxFiles`, returns
// truncated:true with no symbol diff so callers don't pay for huge diffs.
async function cgDiff({ repoPath, fromSha, toSha, maxFiles = 500 }) {
  if (!gitShaReachable(repoPath, fromSha)) {
    throw new Error(`from_sha not reachable in repo: ${fromSha}`);
  }
  if (!gitShaReachable(repoPath, toSha)) {
    throw new Error(`to_sha not reachable in repo: ${toSha}`);
  }

  const ns = gitDiffNameStatus(repoPath, fromSha, toSha);
  const indexableA = ns.added.filter(languageFor);
  const indexableM = ns.modified.filter(languageFor);
  const indexableD = ns.deleted.filter(languageFor);
  // Renames are paired-modifies when BOTH sides are indexable. If only one
  // side is indexable (e.g. .png → .png.js), fall back to add/delete shape
  // so symbols still surface naturally on the indexable side.
  const indexableR = [];
  const skipped = [
    ...ns.added.filter((f) => !languageFor(f)),
    ...ns.modified.filter((f) => !languageFor(f)),
    ...ns.deleted.filter((f) => !languageFor(f)),
  ];
  for (const r of ns.renamed) {
    const fromIx = !!languageFor(r.from);
    const toIx   = !!languageFor(r.to);
    if (fromIx && toIx) {
      indexableR.push(r);
    } else if (toIx) {
      indexableA.push(r.to);
      skipped.push(r.from);
    } else if (fromIx) {
      indexableD.push(r.from);
      skipped.push(r.to);
    } else {
      skipped.push(r.from, r.to);
    }
  }
  const indexableTotal =
    indexableA.length + indexableM.length + indexableD.length + indexableR.length;

  // Total file events for reporting — counts a rename as a single event.
  const totalFilesChanged =
    ns.added.length + ns.modified.length + ns.deleted.length + ns.renamed.length;
  // changed_files preserves the rename pairs so callers can distinguish
  // them from independent add+delete pairs.
  const changedFiles = {
    added:    ns.added,
    modified: ns.modified,
    deleted:  ns.deleted,
    renamed:  ns.renamed,
  };

  if (indexableTotal > maxFiles) {
    return {
      from_sha: fromSha,
      to_sha:   toSha,
      added_symbols:              [],
      removed_symbols:            [],
      signature_changed_symbols:  [],
      changed_files:              changedFiles,
      skipped_files:              skipped,
      parse_errors:               [],
      truncated:                  true,
      max_files:                  maxFiles,
      total_files_changed:        totalFilesChanged,
      truncation_hint: `Diff scope ${indexableTotal} indexable files exceeds the ${maxFiles}-file cap. Narrow the range (compare adjacent commits) or raise max_files.`,
    };
  }

  const added = [];
  const removed = [];
  const signatureChanged = [];
  const parseErrors = [];

  function intoSkipped(res) {
    if (!res.skipped) return;
    if (res.skipped.reason === 'parse') parseErrors.push(res.skipped);
  }

  // Added files: every symbol is new.
  for (const file of indexableA) {
    const r = await symbolsForFile(gitShowFile(repoPath, toSha, file), file);
    intoSkipped(r);
    if (!r.symbols) continue;
    for (const s of r.symbols) added.push(projectSymbol(file, s));
  }
  // Deleted files: every symbol is gone.
  for (const file of indexableD) {
    const r = await symbolsForFile(gitShowFile(repoPath, fromSha, file), file);
    intoSkipped(r);
    if (!r.symbols) continue;
    for (const s of r.symbols) removed.push(projectSymbol(file, s));
  }
  // Modified files: extract both sides, set-diff by stable key, then
  // detect signature-flag flips for symbols present on both sides.
  for (const file of indexableM) {
    await diffFilePair({
      repoPath, fromSha, toSha,
      fromPath: file, toPath: file, stableFile: file,
      added, removed, signatureChanged, parseErrors,
    });
  }
  // Renamed files (both sides indexable): treat as a paired modify keyed
  // on the NEW path so a content-stable rename is 0/0, and within-file
  // symbol changes still surface as add/remove/signature_changed.
  for (const r of indexableR) {
    await diffFilePair({
      repoPath, fromSha, toSha,
      fromPath: r.from, toPath: r.to, stableFile: r.to,
      added, removed, signatureChanged, parseErrors,
    });
  }

  return {
    from_sha: fromSha,
    to_sha:   toSha,
    added_symbols:             added,
    removed_symbols:           removed,
    signature_changed_symbols: signatureChanged,
    changed_files:             changedFiles,
    skipped_files:             skipped,
    parse_errors:              parseErrors,
    truncated:                 false,
    max_files:                 maxFiles,
    total_files_changed:       totalFilesChanged,
  };
}

// Extract symbols at fromSha:fromPath and toSha:toPath, set-diff by stable
// identity, and emit signature flips for symbols present on both sides.
// Used for both pure modifies (fromPath === toPath) and renames.
async function diffFilePair({
  repoPath, fromSha, toSha,
  fromPath, toPath, stableFile,
  added, removed, signatureChanged, parseErrors,
}) {
  const fromRes = await symbolsForFile(gitShowFile(repoPath, fromSha, fromPath), fromPath);
  const toRes   = await symbolsForFile(gitShowFile(repoPath, toSha,   toPath),   toPath);
  if (fromRes.skipped?.reason === 'parse') parseErrors.push(fromRes.skipped);
  if (toRes.skipped?.reason === 'parse')   parseErrors.push(toRes.skipped);
  const fromSyms = fromRes.symbols || [];
  const toSyms   = toRes.symbols   || [];
  const fromMap = new Map(fromSyms.map((s) => [symbolKey(stableFile, s), s]));
  const toMap   = new Map(toSyms.map((s)   => [symbolKey(stableFile, s), s]));
  for (const [key, s] of toMap) {
    if (!fromMap.has(key)) added.push(projectSymbol(toPath, s));
  }
  for (const [key, s] of fromMap) {
    if (!toMap.has(key))   removed.push(projectSymbol(fromPath, s));
  }
  // Symbols present on both sides — check for signature-flag flips.
  for (const [key, fromSym] of fromMap) {
    const toSym = toMap.get(key);
    if (!toSym) continue;
    const flagDiff = diffFlags(fromSym, toSym);
    if (!flagDiff) continue;
    signatureChanged.push({
      ...projectSymbol(toPath, toSym),
      from_flags: flagsOf(fromSym),
      to_flags:   flagsOf(toSym),
      changed:    flagDiff,
    });
  }
}

module.exports = { cgDiff };
