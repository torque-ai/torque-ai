#!/usr/bin/env node
// PreToolUse hook: blocks Edit/Write/NotebookEdit on torque-public main worktree.
// Overrides: set TORQUE_ALLOW_MAIN_EDIT=1 in env (emergency hotfix only).

const { execFileSync } = require('child_process');
const path = require('path');

let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    if (process.env.TORQUE_ALLOW_MAIN_EDIT === '1') return;

    const data = JSON.parse(input || '{}');
    const filePath =
      data?.tool_input?.file_path ||
      data?.tool_input?.notebook_path;
    if (!filePath) return;

    const fileDir = path.dirname(filePath);
    const git = (args) =>
      execFileSync('git', ['-C', fileDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

    let toplevel, gitDir, commonDir, branch;
    try {
      toplevel = git(['rev-parse', '--show-toplevel']);
      gitDir = git(['rev-parse', '--absolute-git-dir']);
      commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
      branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    } catch {
      return;
    }

    if (path.basename(toplevel).toLowerCase() !== 'torque-public') return;
    if (gitDir !== commonDir) return;

    const reason =
      `torque-public main edit blocked (branch: ${branch}). All feature work — including docs and config — must use a worktree. ` +
      `Run: scripts/worktree-create.sh <feature-name> [--no-install]  then open .worktrees/feat-<name>/ in Claude Code. ` +
      `Emergency override (hotfix only): set TORQUE_ALLOW_MAIN_EDIT=1.`;

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }));
  } catch {
    // never block on hook error
  }
});
