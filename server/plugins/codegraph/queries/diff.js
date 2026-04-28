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

function gitDiffNameStatus(repoPath, fromSha, toSha) {
  const out = childProcess.execFileSync('git', [
    'diff', '--name-status', '-M50%', fromSha, toSha,
  ], { ...GIT_BASE_OPTS, cwd: repoPath, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const added = [], modified = [], deleted = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const parts = line.split('\t');
    const status = parts[0][0];
    if (status === 'A')       added.push(parts[1]);
    else if (status === 'M' || status === 'T') modified.push(parts[1]);
    else if (status === 'D')  deleted.push(parts[1]);
    else if (status === 'R') { deleted.push(parts[1]); added.push(parts[2]); }
    else if (status === 'C') { added.push(parts[2]); }
  }
  return { added, modified, deleted };
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

// Identity: name + kind + container. Excludes line numbers so the same
// symbol that moved within a file isn't reported as add+remove. Including
// the file path lets the key disambiguate same-named symbols in different
// files (which we then emit per-file in the result anyway).
function symbolKey(file, sym) {
  return `${file}|${sym.kind}|${sym.containerName || ''}|${sym.name}`;
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

async function symbolsForFile(content, filePath) {
  const ex = extractorFor(filePath);
  if (!ex) return null; // unsupported language; caller filters
  const buffer = Buffer.isBuffer(content) ? content.toString('utf8') : String(content);
  const out = await ex.extract(buffer);
  return Array.isArray(out?.symbols) ? out.symbols : [];
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
  const indexableTotal = indexableA.length + indexableM.length + indexableD.length;
  const skipped = [
    ...ns.added.filter((f) => !languageFor(f)),
    ...ns.modified.filter((f) => !languageFor(f)),
    ...ns.deleted.filter((f) => !languageFor(f)),
  ];

  if (indexableTotal > maxFiles) {
    return {
      from_sha: fromSha,
      to_sha:   toSha,
      added_symbols:   [],
      removed_symbols: [],
      changed_files:   { added: ns.added, modified: ns.modified, deleted: ns.deleted },
      skipped_files:   skipped,
      truncated:       true,
      max_files:       maxFiles,
      total_files_changed: ns.added.length + ns.modified.length + ns.deleted.length,
      truncation_hint: `Diff scope ${indexableTotal} indexable files exceeds the ${maxFiles}-file cap. Narrow the range (compare adjacent commits) or raise max_files.`,
    };
  }

  const added = [];
  const removed = [];

  // Added files: every symbol is new.
  for (const file of indexableA) {
    const content = gitShowFile(repoPath, toSha, file);
    const syms = await symbolsForFile(content, file);
    if (!syms) continue;
    for (const s of syms) added.push(projectSymbol(file, s));
  }
  // Deleted files: every symbol is gone.
  for (const file of indexableD) {
    const content = gitShowFile(repoPath, fromSha, file);
    const syms = await symbolsForFile(content, file);
    if (!syms) continue;
    for (const s of syms) removed.push(projectSymbol(file, s));
  }
  // Modified files: extract both sides, set-diff by stable key.
  for (const file of indexableM) {
    const fromContent = gitShowFile(repoPath, fromSha, file);
    const toContent   = gitShowFile(repoPath, toSha,   file);
    const fromSyms = (await symbolsForFile(fromContent, file)) || [];
    const toSyms   = (await symbolsForFile(toContent,   file)) || [];
    const fromKeys = new Set(fromSyms.map((s) => symbolKey(file, s)));
    const toKeys   = new Set(toSyms.map((s)   => symbolKey(file, s)));
    for (const s of toSyms)   if (!fromKeys.has(symbolKey(file, s))) added.push(projectSymbol(file, s));
    for (const s of fromSyms) if (!toKeys.has(symbolKey(file, s)))   removed.push(projectSymbol(file, s));
  }

  return {
    from_sha: fromSha,
    to_sha:   toSha,
    added_symbols:   added,
    removed_symbols: removed,
    changed_files:   { added: ns.added, modified: ns.modified, deleted: ns.deleted },
    skipped_files:   skipped,
    truncated:       false,
    max_files:       maxFiles,
    total_files_changed: ns.added.length + ns.modified.length + ns.deleted.length,
  };
}

module.exports = { cgDiff };
