#!/usr/bin/env node
'use strict';

// One-shot rewriter: prepend `torque-remote ` to bare heavy-validation
// commands in saved auto-generated plan files. Plans authored before
// `task_avoids_local_heavy_validation` shipped (2026-04-26 commit
// 530b2c1a) now hard-block at materialization. Rather than wait for the
// planner to re-cycle each work item, this rewrites known-fixable patterns
// in place so the existing plans pass the materialization guard.
//
// Patterns handled (mirrors server/utils/heavy-validation-guard.js):
//   - dotnet build / dotnet test
//   - pwsh scripts/build.ps1 / pwsh scripts/test.ps1
//   - bash scripts/build.sh / bash scripts/test.sh
//
// If a heavy command on a line is already preceded by `torque-remote` on
// the same line, that line is left alone.
//
// Pass plan-directory roots as positional args. Run from any cwd:
//   node scripts/rewrite-stale-plans.js <plan-dir>...
//   node scripts/rewrite-stale-plans.js --apply <plan-dir>...

const fs = require('fs');
const path = require('path');

const PATTERNS = [
  /\bdotnet\s+test\b/i,
  /\bdotnet\s+build\b/i,
  /\b(?:pwsh|powershell(?:\.exe)?)(?:\s+-file)?\s+(?:\.?[\\/])?scripts[\\/](?:build|test)\.ps1\b/i,
  /\b(?:bash|sh)\s+(?:\.?[\\/])?scripts[\\/](?:build|test)\.sh\b/i,
];

function isCommandRoutedRemotely(lineLower, commandIndex) {
  // STRICTER than server/utils/heavy-validation-guard.js: that helper
  // checks whether `torque-remote` appears anywhere earlier on the line,
  // which is correct for it (any occurrence means at least one heavy
  // command is routed). For multi-command lines like
  // "`dotnet test ...` and `dotnet build ...`", we need to know whether
  // THIS specific command is directly preceded by torque-remote.
  // We require torque-remote to appear within the previous ~32 chars,
  // separated only by whitespace/backticks/parens — no intervening
  // command name. That tolerates the wrapped form `torque-remote dotnet`
  // while rejecting the false-positive where torque-remote prefixed an
  // earlier command on the same line.
  if (commandIndex < 0) return false;
  const prefix = lineLower.slice(Math.max(0, commandIndex - 32), commandIndex);
  return /torque-remote[\s`'"()]+$/.test(prefix);
}

function rewriteLine(line) {
  // Handle multiple heavy commands on a single line (e.g.,
  // "Validate with `dotnet test ...` and then run `dotnet build ...`").
  // After each rewrite the prepended `torque-remote ` makes the next
  // pass of isCommandRoutedRemotely skip that occurrence; loop until
  // no rewriteable matches remain. Bounded to MAX_PASSES for safety.
  const MAX_PASSES = 10;
  let changed = line;
  let didRewrite = false;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const lower = changed.toLowerCase();
    let earliest = null;
    for (const re of PATTERNS) {
      const m = re.exec(lower);
      if (!m) continue;
      if (isCommandRoutedRemotely(lower, m.index)) continue;
      if (earliest === null || m.index < earliest.index) {
        earliest = { index: m.index, length: m[0].length };
      }
    }
    if (!earliest) break;
    const before = changed.slice(0, earliest.index);
    const middle = changed.slice(earliest.index, earliest.index + earliest.length);
    const after = changed.slice(earliest.index + earliest.length);
    changed = `${before}torque-remote ${middle}${after}`;
    didRewrite = true;
  }
  return { line: changed, changed: didRewrite };
}

function rewriteFile(filePath, apply) {
  const original = fs.readFileSync(filePath, 'utf8');
  const lines = original.split(/\r?\n/);
  let anyChange = false;
  const newLines = lines.map((line) => {
    const result = rewriteLine(line);
    if (result.changed) anyChange = true;
    return result.line;
  });
  if (!anyChange) return { changed: false };
  if (apply) {
    fs.writeFileSync(filePath, newLines.join('\n'), 'utf8');
  }
  return { changed: true };
}

function listMdFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => path.join(dir, f));
}

(function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const verbose = args.includes('--verbose');
  const roots = args.filter((a) => !a.startsWith('--'));
  if (roots.length === 0) {
    console.error('usage: node rewrite-stale-plans.js [--apply] [--verbose] <plan-dir>...');
    console.error('  Each plan-dir is typically <project>/docs/superpowers/plans/auto-generated');
    process.exit(2);
  }
  let totalScanned = 0;
  let totalChanged = 0;
  const changedFiles = [];
  for (const root of roots) {
    const files = listMdFiles(root);
    for (const f of files) {
      totalScanned++;
      try {
        const result = rewriteFile(f, apply);
        if (result.changed) {
          totalChanged++;
          changedFiles.push(f);
        }
      } catch (e) {
        console.error(`error: ${f}: ${e.message}`);
      }
    }
  }
  console.log(`scanned: ${totalScanned}`);
  console.log(`would-rewrite: ${totalChanged}${apply ? ' (APPLIED)' : ' (dry-run; pass --apply to write)'}`);
  if (verbose && changedFiles.length > 0) {
    console.log('files:');
    for (const f of changedFiles) console.log(`  ${f}`);
  } else if (changedFiles.length > 0 && changedFiles.length <= 30) {
    console.log('files (basename):');
    for (const f of changedFiles) console.log(`  ${path.basename(f)}`);
  } else if (changedFiles.length > 30) {
    console.log(`(${changedFiles.length} files — pass --verbose for full list)`);
  }
})();
