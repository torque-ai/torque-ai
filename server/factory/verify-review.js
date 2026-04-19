'use strict';

const childProcess = require('node:child_process');

const LLM_TIMEOUT_MS = 60_000;
const ENVIRONMENT_EXIT_CODES = new Set([127, 126, 124]);
const ENVIRONMENT_STDERR_PATTERNS = [
  /\bEPERM\b/,
  /\bEACCES\b/,
  /\bENOENT\b/,
  /\btimeout after \d+/i,
  /\bkilled by signal\b/i,
];

function detectEnvironmentFailure(verifyOutput) {
  const signals = [];
  let reason = null;

  if (verifyOutput && verifyOutput.timedOut === true) {
    signals.push('timed_out');
    reason = 'timeout';
  }

  const exitCode = verifyOutput ? verifyOutput.exitCode : null;
  if (typeof exitCode === 'number' && ENVIRONMENT_EXIT_CODES.has(exitCode)) {
    signals.push(`exit_${exitCode}`);
    if (exitCode === 127) reason = reason || 'command_not_found';
    else if (exitCode === 126) reason = reason || 'permission_denied';
    else if (exitCode === 124) reason = reason || 'timeout';
  }

  const stderr = verifyOutput ? String(verifyOutput.stderr || '') : '';
  const stderrChecks = [
    { re: /\bEPERM\b/, signal: 'stderr_EPERM', reason: 'permission_denied' },
    { re: /\bEACCES\b/, signal: 'stderr_EACCES', reason: 'permission_denied' },
    { re: /\bENOENT\b/, signal: 'stderr_ENOENT', reason: 'missing_file_or_dir' },
    { re: /\btimeout after \d+/i, signal: 'stderr_timeout', reason: 'timeout' },
    { re: /\bkilled by signal\b/i, signal: 'stderr_killed', reason: 'timeout' },
  ];
  for (const check of stderrChecks) {
    if (check.re.test(stderr)) {
      signals.push(check.signal);
      reason = reason || check.reason;
    }
  }

  return { detected: signals.length > 0, signals, reason };
}

function parseFailingTests(verifyOutput) {
  if (!verifyOutput) return [];
  const combined = String(verifyOutput.stdout || '') + '\n' + String(verifyOutput.stderr || '');
  if (!combined.trim()) return [];

  const paths = new Set();

  // Pytest: "FAILED tests/foo.py::test_bar - ..." or "FAILED tests/foo.py - collection error"
  const pytestRe = /^FAILED\s+([A-Za-z0-9_./\\-]+?\.py)(?:::|\s|$)/gm;
  for (const m of combined.matchAll(pytestRe)) {
    paths.add(m[1]);
  }

  // Vitest arrow pointer: "❯ src/foo.test.ts:line:col"
  const vitestPointerRe = /❯\s+([A-Za-z0-9_./\\-]+?\.(?:ts|tsx|js|jsx|mjs|cjs)):\d+/g;
  for (const m of combined.matchAll(vitestPointerRe)) {
    paths.add(m[1]);
  }
  // Vitest FAIL header: "FAIL  src/foo.test.ts > describe > it"
  const vitestFailRe = /^\s*FAIL\s+([A-Za-z0-9_./\\-]+?\.(?:ts|tsx|js|jsx|mjs|cjs))\s*>/gm;
  for (const m of combined.matchAll(vitestFailRe)) {
    paths.add(m[1]);
  }

  // Dotnet test: "Test Files: <path>/<name>.dll" or "Failed ... Files: <path>/<name>.dll"
  const dotnetRe = /(?:Test Files?:|Files:)\s*([A-Za-z]:[\\/]?[^\s]+\.dll|[\\/][^\s]+\.dll|[A-Za-z0-9_./\\-]+?\.dll)/g;
  for (const m of combined.matchAll(dotnetRe)) {
    paths.add(m[1]);
  }

  return Array.from(paths);
}

async function getModifiedFiles(workingDirectory, worktreeBranch, mergeBase) {
  if (!workingDirectory || !worktreeBranch || !mergeBase) return [];
  return new Promise((resolve) => {
    let stdout = '';
    let child;
    try {
      child = childProcess.spawn('git', ['diff', '--name-only', `${mergeBase}...${worktreeBranch}`], {
        cwd: workingDirectory,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch (_e) {
      resolve([]);
      return;
    }
    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.on('error', () => resolve([]));
    child.on('close', (code) => {
      if (code !== 0) return resolve([]);
      const paths = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      resolve(paths);
    });
  });
}

async function runLlmTiebreak({ failingTests, modifiedFiles, workItem, project, timeoutMs = LLM_TIMEOUT_MS }) {
  const { submitFactoryInternalTask } = require('./internal-task-submit');
  const { handleAwaitTask } = require('../handlers/workflow/await');
  const taskCore = require('../db/task-core');

  const prompt = buildTiebreakPrompt({ failingTests, modifiedFiles, workItem });
  let taskId;
  try {
    const submitResult = await submitFactoryInternalTask({
      task: prompt,
      working_directory: project?.path || process.cwd(),
      kind: 'plan_generation',
      project_id: project?.id,
      work_item_id: workItem?.id,
      timeout_minutes: Math.max(1, Math.floor(timeoutMs / 60_000)),
    });
    taskId = submitResult?.task_id || null;
  } catch (_e) {
    return { verdict: null, critique: null };
  }
  if (!taskId) return { verdict: null, critique: null };

  try {
    await handleAwaitTask({
      task_id: taskId,
      timeout_minutes: Math.max(1, Math.floor(timeoutMs / 60_000)),
      heartbeat_minutes: 0,
    });
  } catch (_e) {
    return { verdict: null, critique: null };
  }
  const task = taskCore.getTask(taskId);
  if (!task || task.status !== 'completed') return { verdict: null, critique: null };

  const raw = String(task.output || '').trim();
  if (!raw) return { verdict: null, critique: null };
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(raw);
    const verdict = parsed && parsed.verdict === 'no-go' ? 'no-go'
                  : parsed && parsed.verdict === 'go' ? 'go'
                  : null;
    if (verdict === null) return { verdict: null, critique: null };
    const critique = typeof parsed.critique === 'string' ? parsed.critique.trim() : null;
    return { verdict, critique };
  } catch (_e) {
    void _e;
    return { verdict: null, critique: null };
  }
}

function buildTiebreakPrompt({ failingTests, modifiedFiles, workItem }) {
  return `You are a quality reviewer for a software factory's verify step.

The factory ran a work item's task on a feature branch. The verify command (test runner) exited non-zero. Before burning another retry cycle, I need to know whether the failing tests were caused by this task's diff or by a pre-existing broken baseline.

Work item title: ${workItem?.title || '(none)'}
Work item description: ${workItem?.description || '(none)'}

Failing test file paths:
${failingTests.map((p) => `  - ${p}`).join('\n') || '  (none parsed)'}

Files modified by the diff:
${modifiedFiles.map((p) => `  - ${p}`).join('\n') || '  (none)'}

Return ONLY valid JSON in this exact shape:
{"verdict":"go"|"no-go","critique":"one sentence explaining the verdict"}

- "go" means: the failures ARE attributable to this diff. Retry makes sense.
- "no-go" means: the failures are NOT attributable. The project's baseline is broken; retrying will not help.
`;
}

async function reviewVerifyFailure(_opts) {
  return {
    classification: 'ambiguous',
    confidence: 'low',
    modifiedFiles: [],
    failingTests: [],
    intersection: [],
    environmentSignals: [],
    llmVerdict: null,
    llmCritique: null,
    suggestedRejectReason: null,
  };
}

module.exports = {
  LLM_TIMEOUT_MS,
  ENVIRONMENT_EXIT_CODES,
  ENVIRONMENT_STDERR_PATTERNS,
  detectEnvironmentFailure,
  parseFailingTests,
  getModifiedFiles,
  runLlmTiebreak,
  reviewVerifyFailure,
};
