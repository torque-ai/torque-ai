// Verify-fix prompt builders + stack guidance. Build the markdown prompt
// the orchestrator hands to the auto-verify-fix task when verify fails,
// plus the prior-attempts block that summarizes what previous retries
// touched and how the failure set evolved.
//
// Mostly pure — `countPriorVerifyRetryTasksForBatch` and the
// failing-test-name diff inside `renderProgression` lazy-require DB and
// verify-signature modules at call time.
//
// Extracted from server/factory/loop-controller.js as Phase 2a of the
// god-object refactor. Behavior preserved; no signature changes.

const VERIFY_FIX_PROMPT_TAIL_BUDGET = 16000;
const VERIFY_FIX_PROMPT_PRIOR_BUDGET = 1800;

function stripAnsi(text) {
  const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
  return typeof text === 'string'
    ? text.replace(ansiPattern, '')
    : '';
}

function countPriorVerifyRetryTasksForBatch(batch_id) {
  if (!batch_id) return 0;
  try {
    const taskCore = require('../../db/task-core');
    const tasks = taskCore.listTasks({
      tags: [`factory:batch_id=${batch_id}`],
      limit: 200,
    });
    return tasks.filter((t) =>
      Array.isArray(t.tags)
      && t.tags.some((tag) => typeof tag === 'string' && tag.startsWith('factory:verify_retry=')),
    ).length;
  } catch {
    return 0;
  }
}

function renderFilesTouched(files, file_count) {
  const arr = Array.isArray(files) ? files : [];
  if (arr.length === 0) return 'none';
  const head = arr.slice(0, 5).join(', ');
  const extra = file_count > 5 ? ` (+${file_count - 5} more)` : '';
  return `${head}${extra}`;
}

function renderAttempt(a, labelNumber) {
  const verifyRetryIdx = labelNumber == null ? '' : ` (verify retry #${labelNumber})`;
  const kindLabel = a.kind === 'verify_retry' ? `verify_retry${verifyRetryIdx}` : 'execute';
  const head = `- Attempt ${a.attempt} (${kindLabel}): ${a.file_count} files touched`;
  const filesPart = a.file_count > 0 ? ` — ${renderFilesTouched(a.files_touched, a.file_count)}.` : '';
  const classified = a.file_count === 0 && a.zero_diff_reason
    ? ` — classified as \`${a.zero_diff_reason}\`.`
    : '.';
  const summary = String(a.stdout_tail || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  const summaryLine = summary ? `\n  Codex summary: "${summary}"` : '';
  return `${head}${filesPart}${classified}${summaryLine}`;
}

function renderProgression(prevOutput, currOutput) {
  try {
    const { extractFailingTestNames } = require('../verify-signature');
    const prev = extractFailingTestNames(prevOutput);
    const curr = extractFailingTestNames(currOutput);
    if (prev.length === 0 && curr.length === 0) return null;

    const prevSet = new Set(prev);
    const currSet = new Set(curr);
    const newlyPassing = prev.filter((n) => !currSet.has(n));
    const newlyFailing = curr.filter((n) => !prevSet.has(n));

    const lines = ['Verify error progression:'];
    lines.push(`- Previous run failed with: ${prev.length} failure${prev.length === 1 ? '' : 's'}${prev.length ? ` ("${prev.slice(0, 3).join('", "')}"${prev.length > 3 ? ', …' : ''})` : ''}`);
    lines.push(`- This run is failing with: ${curr.length} failure${curr.length === 1 ? '' : 's'}${curr.length ? ` ("${curr.slice(0, 3).join('", "')}"${curr.length > 3 ? ', …' : ''})` : ''}`);
    let verdict;
    if (newlyPassing.length > 0 && newlyFailing.length === 0) {
      verdict = `  → Partial progress. ${newlyPassing.length} test${newlyPassing.length === 1 ? '' : 's'} now passing. Keep current approach.`;
    } else if (newlyFailing.length > 0 && newlyPassing.length === 0) {
      verdict = `  → New failures introduced. Consider reverting part of last attempt.`;
    } else if (newlyPassing.length === 0 && newlyFailing.length === 0 && prev.length > 0) {
      verdict = `  → Same failures. Previous approach did not move the needle; try a different angle.`;
    } else if (newlyPassing.length > 0 && newlyFailing.length > 0) {
      verdict = `  → Mixed: ${newlyPassing.length} newly passing, ${newlyFailing.length} newly failing.`;
    } else {
      verdict = `  → No comparable change.`;
    }
    lines.push(verdict);
    return lines.join('\n');
  } catch {
    return null;
  }
}

function buildPriorAttemptsBlock(priorAttempts, verifyOutputPrev, verifyOutput) {
  const attempts = Array.isArray(priorAttempts) ? [...priorAttempts] : [];
  if (attempts.length === 0) return null;

  attempts.sort((a, b) => a.attempt - b.attempt);

  let verifyRetryIdx = 0;
  const rendered = attempts.map((a) => {
    if (a.kind === 'verify_retry') {
      verifyRetryIdx += 1;
      return renderAttempt(a, verifyRetryIdx);
    }
    return renderAttempt(a, null);
  });

  let elidedCount = 0;
  let block = `Prior attempts on this work item:\n${rendered.join('\n')}`;
  while (block.length > VERIFY_FIX_PROMPT_PRIOR_BUDGET && rendered.length > 1) {
    rendered.shift();
    elidedCount += 1;
    block = `Prior attempts on this work item:\n(${elidedCount} earlier attempt${elidedCount === 1 ? '' : 's'} elided)\n${rendered.join('\n')}`;
  }

  const progression = renderProgression(verifyOutputPrev, verifyOutput);
  if (progression) block += `\n\n${progression}`;

  return block;
}

// detectVerifyStack — work-item-aware: codex's auto-verify-fix loop on
// dotnet projects: it tries broad refactors instead of reading the failing
// test source to find the specific assert. This helper identifies the
// stack from the verify command + output so buildVerifyFixPrompt can
// append targeted, stack-aware instructions.
function detectVerifyStack({ verifyCommand, verifyOutput }) {
  const cmd = String(verifyCommand || '').toLowerCase();
  const out = String(verifyOutput || '');

  if (
    /\bdotnet\s+test\b/.test(cmd)
    || /\bAssert\.(That|AreEqual|IsTrue|IsFalse|IsNull|NotNull|Throws)\b/.test(out)
    || /\bExpected:.*\n\s*But was:/m.test(out)
    || /\bNUnit\b|\bxUnit\b|\bMicrosoft\.NET\.Test\.Sdk\b/.test(out)
    || /\bTest\s+(?:Run|Assembly)\s+Failed\b/i.test(out)
  ) return 'dotnet';

  if (/\bpytest\b|\bpython\s+-m\s+pytest\b/.test(cmd) || /\bAssertionError\b/.test(out)) {
    return 'pytest';
  }

  if (/\bvitest\b|\bjest\b|\bnpm\s+(?:run\s+)?test\b/.test(cmd)) {
    return 'jstest';
  }

  return null;
}

// Each *_VERIFY_FIX_GUIDANCE block is wrapped in a fenced diagnostic block
// under a "Verify command output:" header so the heavy-validation governance
// guard (server/utils/heavy-validation-guard.js stripDiagnosticFencedBlocks)
// ignores the literal "dotnet test" / "pytest" / "vitest" mentions inside.
const DOTNET_VERIFY_FIX_GUIDANCE = [
  '',
  '---',
  'Verify command output:',
  '```',
  'Dotnet test guidance (this verify uses dotnet test):',
  '- Identify the FIRST failing test in the verify output. Look for `Failed!` summary lines and the `Expected:` / `But was:` lines just above them.',
  '- Use `read_file` to open the failing test file FIRST, not the production code. The test\'s assert tells you what behavior the production code must satisfy.',
  '- Then use `read_file` on the production file mentioned in the test\'s arrange/act block.',
  '- Make the SMALLEST change that turns the assert green — usually a one-line patch in the production code (return value, branch, missing case).',
  '- For NUnit/xUnit: an `Assert.Throws<T>` failure usually means the production code throws a different exception type — fix the throw type, do not catch & rethrow.',
  '- For `Expected: not equal to <X>` / `But was: <X>` failures: the production code is returning the SAME thing as the unwanted value — change the production code, not the test.',
  '- If the failing test references a public enum member that doesn\'t exist (e.g. `StartupFailureReason.LanSocketSendFailed`), add the missing enum member to the production enum file. Enums need members listed in source order — append new members at the end of the enum body.',
  '- If a classifier / mapper method is missing a case, the test usually looks like `Assert.That(Classify(input), Is.EqualTo(expectedReason))`. Read the existing `Classify` method, add the missing case for `input`, return `expectedReason`.',
  '- Do NOT run `dotnet test` yourself; the host will re-run verify after your edits.',
  '```',
].join('\n');

const PYTEST_VERIFY_FIX_GUIDANCE = [
  '',
  '---',
  'Verify command output:',
  '```',
  'Pytest guidance (this verify uses pytest):',
  '- Find the failing test in the verify output (look for `FAILED` lines and the `AssertionError` / `assert <expr>` line).',
  '- Read the failing test source first to understand what behavior is being asserted.',
  '- Most pytest failures mean the production code returns a value that differs from the assert — patch the production code to match the assert\'s expectation, unless the test is clearly out of date.',
  '- Do NOT run `pytest` yourself; the host will re-run verify after your edits.',
  '```',
].join('\n');

const JSTEST_VERIFY_FIX_GUIDANCE = [
  '',
  '---',
  'Verify command output:',
  '```',
  'JS test guidance (this verify uses vitest/jest/npm test):',
  '- Find the failing test (look for `FAIL` file lines, `expect(...).toBe(...)` mismatches with `Expected:` / `Received:`).',
  '- Read the failing test source first; the assert is the spec.',
  '- Most failures mean the production code\'s return value differs from `expect(...)`. Patch the production code unless the test is clearly out of date.',
  '- Do NOT run `vitest` / `jest` / `npm test` yourself; the host will re-run verify after your edits.',
  '```',
].join('\n');

function getVerifyStackGuidance(stack) {
  if (stack === 'dotnet') return DOTNET_VERIFY_FIX_GUIDANCE;
  if (stack === 'pytest') return PYTEST_VERIFY_FIX_GUIDANCE;
  if (stack === 'jstest') return JSTEST_VERIFY_FIX_GUIDANCE;
  return '';
}

function buildVerifyFixPrompt({
  planPath, planTitle, branch, verifyCommand, verifyOutput,
  priorAttempts, verifyOutputPrev,
}) {
  const tail = stripAnsi(String(verifyOutput || '')).slice(-VERIFY_FIX_PROMPT_TAIL_BUDGET);
  const priorBlock = buildPriorAttemptsBlock(priorAttempts, verifyOutputPrev, verifyOutput);
  const stack = detectVerifyStack({ verifyCommand, verifyOutput });
  const stackGuidance = getVerifyStackGuidance(stack);
  const lines = [
    `Plan: ${planTitle || '(unknown)'}`,
    planPath ? `Plan path: ${planPath}` : null,
    `Factory branch: ${branch}`,
    // Wrap in a fenced diagnostic block so the heavy-validation governance
    // guard ignores the literal command (e.g. `dotnet test ...`). Without
    // this, codex auto-verify-fix tasks for .NET projects would be blocked
    // by `evaluateFactoryWorktreeHeavyValidationGuard` even though the
    // command is informational, not an instruction to execute locally.
    'Verify command:',
    '```',
    verifyCommand,
    '```',
    '',
    'The plan tasks for this batch were implemented, but the verify step failed. Read the error output below and make the minimum changes needed to turn the failures green. Common issues: a test that references a module the plan forgot to update, an alignment/invariant test that needs the new entry registered, a stale snapshot, a missing import, a type mismatch, or a lint rule violation.',
    '',
    priorBlock,
    priorBlock ? '' : null,
    'Constraints:',
    '- Edit only files in this worktree.',
    '- Do NOT revert the plan\'s intended changes — fix forward.',
    '- Prefer updating the failing test assertions ONLY if the plan is clearly the authoritative spec and the test is out of date. Otherwise update the production code so the test passes.',
    '- Do not run the full verify suite yourself. Targeted re-runs of the specific failing file are fine.',
    '',
    'Verify output (tail):',
    '```',
    tail,
    '```',
    '',
    'SCOPE ENVELOPE — you MUST obey these file rules:',
    '- Modify ONLY files that appear in either:',
    '    (a) the plan\'s task list (the \'plan file\' block above), OR',
    '    (b) filenames that appear in the verify error stack trace (the \'verify output tail\' above).',
    '- Do NOT create new files unless a new file is explicitly named in the plan.',
    '- If you believe no code fix is warranted (the failing test is broken, the baseline is wrong, or the diff is unrelated), exit with no changes. Do NOT add unrelated refactors, cleanup, or new features.',
    stackGuidance || null,
    '',
    'After making the edits, stop.',
  ].filter((x) => x !== null && x !== undefined);
  return lines.join('\n');
}

module.exports = {
  VERIFY_FIX_PROMPT_TAIL_BUDGET,
  VERIFY_FIX_PROMPT_PRIOR_BUDGET,
  stripAnsi,
  countPriorVerifyRetryTasksForBatch,
  renderFilesTouched,
  renderAttempt,
  renderProgression,
  buildPriorAttemptsBlock,
  detectVerifyStack,
  getVerifyStackGuidance,
  buildVerifyFixPrompt,
};
