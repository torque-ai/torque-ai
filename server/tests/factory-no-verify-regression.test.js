'use strict';

// Regression pins for the LEARN-stage worktree_merge_failed chain.
//
// When factory-internal `git commit` calls run from inside TORQUE's
// synchronous execFileSync chain (e.g. LEARN → mergeWorktree) the server's
// own event loop is blocked. The pre-commit hook's /api/version probe times
// out, falls back to pii-fallback-scan.js, and the fallback regex scanner
// exits 1 on any RFC1918 IP match — a false-positive on legitimate test
// fixtures that blocks the commit and fails the merge.
//
// The factory already does equivalent PII sanitization inline one step
// earlier via pii-guard.scanAndReplace. Running the hook again is both
// duplicate work and actively harmful in this code path. Every internal
// commit passes --no-verify so the hook never runs.
//
// These tests assert the flag at the source level rather than via live
// git integration because the commit paths only fire under specific
// git-config + content conditions that are awkward to reproduce portably.
// The flag being present in the commit arg list is the actual invariant
// we need to lock down, and a regex over the source captures exactly that.

const fs = require('fs');
const path = require('path');

function matchCommitBlock(source, messageFragment) {
  // Find a `runGit(..., ['commit', ..., <messageFragment>...])` block.
  const escaped = messageFragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `runGit\\([^,]+,\\s*\\[\\s*'commit'[\\s\\S]*?'${escaped}[^']*'[\\s\\S]*?\\]`
  );
  return source.match(re);
}

describe('factory-internal commits pass --no-verify', () => {
  it('worktree-manager renormalize commit passes --no-verify', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../plugins/version-control/worktree-manager.js'),
      'utf8'
    );
    const block = matchCommitBlock(source, 'chore: normalize line endings');
    expect(block).not.toBeNull();
    expect(block[0]).toContain("'--no-verify'");
  });

  it('worktree-manager pre-merge cleanup commit passes --no-verify', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../plugins/version-control/worktree-manager.js'),
      'utf8'
    );
    const block = matchCommitBlock(source, 'chore: pre-merge cleanup');
    expect(block).not.toBeNull();
    expect(block[0]).toContain("'--no-verify'");
  });

  it('factory worktree auto-commit passes --no-verify', () => {
    // worktree-auto-commit.js uses a different runGit helper with the
    // commit message built from buildCommitMessage(), so we look for
    // the commit call and verify --no-verify is in the arg array.
    const source = fs.readFileSync(
      path.resolve(__dirname, '../factory/worktree-auto-commit.js'),
      'utf8'
    );
    const block = source.match(
      /runGit\([^,]+,\s*\[\s*'commit'[\s\S]*?commitMessage[\s\S]*?\]/
    );
    expect(block).not.toBeNull();
    expect(block[0]).toContain("'--no-verify'");
  });
});
