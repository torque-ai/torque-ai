'use strict';

const childProcess = require('node:child_process');
const { getProviderLanePolicyFromProject } = require('./provider-lane-policy');

// Register built-in dep-resolver adapters on module load. Idempotent —
// the registry holds a Map keyed by manager name.
(function registerBuiltinDepAdapters() {
  try {
    const registry = require('./dep-resolver/registry');
    const { createPythonAdapter } = require('./dep-resolver/adapters/python');
    if (!registry.getAdapter('python')) {
      registry.registerAdapter('python', createPythonAdapter());
    }
  } catch (_e) { void _e; }
})();

const DEFAULT_LLM_TIMEOUT_MS = 10 * 60_000;
function readEnvTimeoutMs() {
  const raw = process.env.TORQUE_VERIFY_REVIEWER_TIMEOUT_MS;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}
const LLM_TIMEOUT_MS = readEnvTimeoutMs() || DEFAULT_LLM_TIMEOUT_MS;
const ENVIRONMENT_EXIT_CODES = new Set([127, 126, 124]);
const ENVIRONMENT_STDERR_PATTERNS = [
  /\bEPERM\b/,
  /\bEACCES\b/,
  /\bPermissionError\b.*(?:Access is denied|Permission denied|WinError\s+5)/i,
  /^(?=[\s\S]*(?:pytest|\.pytest|pytest-))(?=[\s\S]*\bPermissionError\b)(?=[\s\S]*(?:Access is denied|Permission denied|WinError\s+5))/i,
  /\bENOENT\b/,
  /\btimeout after \d+/i,
  /\bkilled by signal\b/i,
];
const REVIEW_TASK_TIMEOUT_RE = /\btimeout exceeded\b/i;

function buildLlmResult(overrides = {}) {
  return {
    verdict: null,
    critique: null,
    status: 'no_verdict',
    taskId: null,
    ...overrides,
  };
}

function timeoutMinutesForMs(timeoutMs) {
  const numeric = Number(timeoutMs);
  if (!Number.isFinite(numeric) || numeric <= 0) return 1;
  return Math.max(1, Math.ceil(numeric / 60_000));
}

function normalizeVerifyOutput(verifyOutput) {
  if (!verifyOutput || typeof verifyOutput !== 'object') {
    return {
      exitCode: null,
      stdout: '',
      stderr: '',
      output: '',
      timedOut: false,
    };
  }
  const stdout = String(verifyOutput.stdout || '');
  const stderr = String(verifyOutput.stderr || '');
  const output = String(verifyOutput.output || '');
  let exitCode = typeof verifyOutput.exitCode === 'number' ? verifyOutput.exitCode : null;
  if (exitCode === null) {
    const exitMatch = output.match(/\bexit[_ -]?code\b\D+(\d+)/i);
    if (exitMatch) {
      exitCode = Number(exitMatch[1]);
    }
  }
  const combined = [stdout, stderr, output]
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n');
  return {
    ...verifyOutput,
    exitCode,
    stdout,
    stderr,
    output,
    combined,
    timedOut: verifyOutput.timedOut === true,
  };
}

function detectEnvironmentFailure(verifyOutput) {
  const normalized = normalizeVerifyOutput(verifyOutput);
  const signals = [];
  let reason = null;

  if (normalized.timedOut === true) {
    signals.push('timed_out');
    reason = 'timeout';
  }

  const exitCode = normalized.exitCode;
  if (typeof exitCode === 'number' && ENVIRONMENT_EXIT_CODES.has(exitCode)) {
    signals.push(`exit_${exitCode}`);
    if (exitCode === 127) reason = reason || 'command_not_found';
    else if (exitCode === 126) reason = reason || 'permission_denied';
    else if (exitCode === 124) reason = reason || 'timeout';
  }

  const stderr = [normalized.stderr, normalized.output].filter(Boolean).join('\n');
  const stderrChecks = [
    { re: /\bEPERM\b/, signal: 'stderr_EPERM', reason: 'permission_denied' },
    { re: /\bEACCES\b/, signal: 'stderr_EACCES', reason: 'permission_denied' },
    {
      re: /\bPermissionError\b.*(?:Access is denied|Permission denied|WinError\s+5)/i,
      signal: 'stderr_PermissionError',
      reason: 'permission_denied',
    },
    {
      re: /^(?=[\s\S]*(?:pytest|\.pytest|pytest-))(?=[\s\S]*\bPermissionError\b)(?=[\s\S]*(?:Access is denied|Permission denied|WinError\s+5))/i,
      signal: 'stderr_pytest_temp_permission',
      reason: 'permission_denied',
    },
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
  const normalized = normalizeVerifyOutput(verifyOutput);
  const combined = normalized.combined || '';
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
  const vitestFailRe = /^\s*FAIL\s+([A-Za-z0-9_./\\-]+?\.(?:ts|tsx|js|jsx|mjs|cjs))(?=\s*(?:>|\[|$))/gm;
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

// The reviewer is a structured yes/no judgment ("does this diff explain
// those failures?"). For ordinary projects, Cerebras/groq deliver JSON in
// ~1-3s vs Codex's ~5-10min for the same task. Lane-locked projects must
// inherit their target routing instead of letting this helper drift providers.
// Override via env for ops flexibility; empty string opts back into smart routing.
function readReviewerProviderOverride() {
  const raw = process.env.TORQUE_VERIFY_REVIEWER_PROVIDER;
  if (raw === undefined) return undefined;
  const trimmed = String(raw).trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveReviewerProvider(project) {
  const envOverride = readReviewerProviderOverride();
  if (envOverride !== undefined) return envOverride;

  const lanePolicy = getProviderLanePolicyFromProject(project || {});
  if (lanePolicy?.expected_provider) {
    return null;
  }

  return 'cerebras';
}

// Reinforces the JSON-shape contract when the first attempt produced
// unparseable output. Some models occasionally wrap the verdict in
// markdown fences or prose. Appending this on retry tightens the spec
// and usually produces clean JSON without burning a re-route.
const STRICT_JSON_SUFFIX = '\n\nIMPORTANT: Output JSON only — no markdown, no fences, no commentary outside the JSON object. Exactly: {"verdict":"go" or "no-go","critique":"..."}\n';

async function submitAndParseTiebreak({ prompt, workingDirectory, project, workItem, timeoutMs, reviewerProvider }) {
  const { submitFactoryInternalTask } = require('./internal-task-submit');
  const { handleAwaitTask } = require('../handlers/workflow/await');
  const taskCore = require('../db/task-core');

  const timeoutMinutes = timeoutMinutesForMs(timeoutMs);
  let taskId;
  try {
    const submitResult = await submitFactoryInternalTask({
      task: prompt,
      working_directory: workingDirectory || project?.path || process.cwd(),
      kind: 'verify_review',
      project_id: project?.id,
      work_item_id: workItem?.id,
      timeout_minutes: timeoutMinutes,
      // The prompt already contains all needed context (failing tests,
      // modified files, verify excerpt). Skip context-stuffing so the
      // model focuses on the verdict instead of re-deriving it from
      // scanned project files.
      context_stuff: false,
      // prefer_free=true gives cerebras → groq → google-ai → openrouter
      // fallback if the primary provider is unhealthy. Avoids paying
      // Codex prices for what a fast free model handles in seconds.
      prefer_free: true,
      ...(reviewerProvider ? { provider: reviewerProvider } : {}),
      // Structured-output hint: the cerebras adapter (and any future
      // adapter) treats response_format=json_object as a signal to
      // a) flip on the API's JSON mode, b) prefer the smaller/faster
      // structured model, and c) clamp temperature to 0. Cuts the
      // invalid_output retry rate to near zero on JSON-mode-capable
      // providers.
      extra_metadata: {
        response_format: 'json_object',
        max_tokens: 512,
      },
    });
    taskId = submitResult?.task_id || null;
  } catch (_e) {
    return buildLlmResult({ status: 'submit_failed' });
  }
  if (!taskId) return buildLlmResult({ status: 'submit_failed' });

  let awaitResult = null;
  try {
    awaitResult = await handleAwaitTask({
      task_id: taskId,
      timeout_minutes: timeoutMinutes,
      heartbeat_minutes: 0,
    });
  } catch (_e) {
    return buildLlmResult({ status: 'await_failed', taskId });
  }
  const task = taskCore.getTask(taskId);
  if (!task) {
    return buildLlmResult({
      status: awaitResult?.status === 'timeout' ? 'timeout' : 'missing_task',
      taskId,
    });
  }
  if (task.status === 'cancelled' && REVIEW_TASK_TIMEOUT_RE.test(String(task.error_output || task.output || ''))) {
    return buildLlmResult({ status: 'timeout', taskId });
  }
  if (awaitResult?.status === 'timeout' && task.status !== 'completed') {
    return buildLlmResult({ status: 'timeout', taskId });
  }
  if (task.status !== 'completed') return buildLlmResult({ status: 'not_completed', taskId });

  const raw = String(task.output || '').trim();
  if (!raw) return buildLlmResult({ status: 'empty_output', taskId });
  try {
    const jsonMatch = raw.match(/\{[\s\S]*?\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(raw);
    const verdict = parsed && parsed.verdict === 'no-go' ? 'no-go'
                  : parsed && parsed.verdict === 'go' ? 'go'
                  : null;
    if (verdict === null) return buildLlmResult({ status: 'invalid_output', taskId });
    const critique = typeof parsed.critique === 'string' ? parsed.critique.trim() : null;
    return buildLlmResult({ verdict, critique, status: 'completed', taskId });
  } catch (_e) {
    void _e;
    return buildLlmResult({ status: 'invalid_output', taskId });
  }
}

async function runLlmTiebreak({ failingTests, modifiedFiles, workItem, project, workingDirectory, verifyOutput, timeoutMs = LLM_TIMEOUT_MS }) {
  const prompt = buildTiebreakPrompt({ failingTests, modifiedFiles, workItem, verifyOutput });
  const reviewerProvider = resolveReviewerProvider(project);
  const args = { workingDirectory, project, workItem, timeoutMs, reviewerProvider };

  const first = await module.exports.submitAndParseTiebreak({ ...args, prompt });
  if (first.status !== 'invalid_output') return first;

  // Retry once with a stricter JSON-only instruction. Without this, a
  // single malformed response (markdown-wrapped JSON, prose around the
  // object) sends the project to verify_reviewed_ambiguous_paused with
  // confidence=low — which then needs auto-recovery + another reviewer
  // task anyway. One in-process retry costs the same time, returns a
  // verdict the first attempt almost had, and avoids burning auto-
  // recovery attempts on a parse-error nuisance.
  const strictPrompt = `${prompt}${STRICT_JSON_SUFFIX}`;
  const second = await module.exports.submitAndParseTiebreak({ ...args, prompt: strictPrompt });
  return second;
}

const VERIFY_EXCERPT_MAX_CHARS = 3000;
const WORK_ITEM_DESCRIPTION_MAX_CHARS = 800;

function extractVerifyExcerpt(verifyOutput) {
  if (!verifyOutput) return '';
  const normalized = normalizeVerifyOutput(verifyOutput);
  const combined = (normalized.combined || '').trim();
  if (!combined) return '';
  if (combined.length <= VERIFY_EXCERPT_MAX_CHARS) return combined;
  return `[...truncated...]\n${combined.slice(-VERIFY_EXCERPT_MAX_CHARS)}`;
}

function truncateForPrompt(value, max) {
  const s = typeof value === 'string' ? value : '';
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n[...truncated...]`;
}

function buildTiebreakPrompt({ failingTests, modifiedFiles, workItem, verifyOutput }) {
  const description = truncateForPrompt(workItem?.description, WORK_ITEM_DESCRIPTION_MAX_CHARS) || '(none)';
  const verifyExcerpt = extractVerifyExcerpt(verifyOutput);
  return `You are a quality reviewer for a software factory's verify step.

The factory ran a work item's task on a feature branch. The verify command (test runner) exited non-zero. Before burning another retry cycle, I need to know whether the failing tests were caused by this task's diff or by a pre-existing broken baseline.

Work item title: ${workItem?.title || '(none)'}
Work item description: ${description}

Failing test file paths:
${failingTests.map((p) => `  - ${p}`).join('\n') || '  (none parsed)'}

Files modified by the diff:
${modifiedFiles.map((p) => `  - ${p}`).join('\n') || '  (none)'}

Verify command output (tail, ~3KB):
\`\`\`
${verifyExcerpt || '(none captured)'}
\`\`\`

Return ONLY valid JSON in this exact shape:
{"verdict":"go"|"no-go","critique":"one sentence explaining the verdict"}

- "go" means: the failures ARE attributable to this diff. Retry makes sense.
- "no-go" means: the failures are NOT attributable. The project's baseline is broken; retrying will not help.
`;
}

async function reviewVerifyFailure({
  verifyOutput,
  workingDirectory,
  worktreeBranch,
  mergeBase,
  workItem,
  project,
  batch_id,
  options = {},
}) {
  const env = detectEnvironmentFailure(verifyOutput);
  if (env.detected) {
    return {
      classification: 'environment_failure',
      confidence: 'high',
      modifiedFiles: [],
      failingTests: [],
      intersection: [],
      environmentSignals: env.signals,
      llmVerdict: null,
      llmCritique: null,
      suggestedRejectReason: 'verify_failed_environment',
    };
  }

  // Missing-dependency classification: adapters detect common patterns
  // (ModuleNotFoundError, Cannot find module, etc.), LLM maps module→package.
  try {
    const combined = normalizeVerifyOutput(verifyOutput).combined || '';
    const registry = require('./dep-resolver/registry');
    const hit = registry.detect(combined);
    if (hit && hit.adapter && typeof hit.adapter.mapModuleToPackage === 'function') {
      const mapping = await hit.adapter.mapModuleToPackage({
        module_name: hit.module_name,
        error_output: combined,
        manifest_excerpt: '',
        project,
        workItem,
      });
      if (mapping && mapping.package_name && (mapping.confidence === 'high' || mapping.confidence === 'medium')) {
        return {
          classification: 'missing_dep',
          confidence: mapping.confidence,
          manager: hit.manager,
          module_name: hit.module_name,
          package_name: mapping.package_name,
          error_output: combined,
          modifiedFiles: [],
          failingTests: [],
          intersection: [],
          environmentSignals: [],
          llmVerdict: null,
          llmCritique: null,
          suggestedRejectReason: null,
        };
      }
    }
  } catch (_depErr) {
    // dep-resolver failures must not block the existing classifier path
    void _depErr;
  }

  const failingTests = module.exports.parseFailingTests(verifyOutput);
  const modifiedFiles = await module.exports.getModifiedFiles(workingDirectory, worktreeBranch, mergeBase);
  const intersection = failingTests.filter((t) => modifiedFiles.includes(t));

  if (modifiedFiles.length === 0 && batch_id) {
    try {
      const factoryDecisions = require('../db/factory-decisions');
      const priorDecisions = factoryDecisions.listDecisions(project?.id || null, { stage: 'execute', limit: 20 });
      const priorSkippedClean = priorDecisions.filter((d) => d.batch_id === batch_id && d.action === 'auto_commit_skipped_clean');
      if (priorSkippedClean.length >= 1) {
        return {
          classification: 'zero_diff_cascade',
          confidence: 'high',
          modifiedFiles,
          failingTests,
          intersection,
          environmentSignals: [],
          llmVerdict: null,
          llmCritique: null,
          suggestedRejectReason: 'zero_diff_across_retries',
        };
      }
    } catch (_e) {
      // factory-decisions lookup failed; fall through to existing logic
    }
  }

  if (intersection.length > 0) {
    return {
      classification: 'task_caused',
      confidence: 'high',
      modifiedFiles,
      failingTests,
      intersection,
      environmentSignals: [],
      llmVerdict: null,
      llmCritique: null,
      suggestedRejectReason: null,
    };
  }

  const deterministicBase = failingTests.length > 0 ? 'baseline_candidate' : 'ambiguous';

  // Skip the LLM tiebreak when there's nothing to reason about. Running it
  // on a completely empty signal (no parsed failing tests AND no modified
  // files) would burn a Torque submission to no purpose — and legacy tests
  // that don't mock reviewVerifyFailure would see an unexpected extra
  // internal-task submission. Return ambiguous/low immediately.
  if (failingTests.length === 0 && modifiedFiles.length === 0) {
    return {
      classification: 'ambiguous',
      confidence: 'low',
      modifiedFiles,
      failingTests,
      intersection,
      environmentSignals: [],
      llmVerdict: null,
      llmCritique: null,
      suggestedRejectReason: null,
    };
  }

  const llm = await module.exports.runLlmTiebreak({
    failingTests,
    modifiedFiles,
    workItem,
    project,
    workingDirectory,
    verifyOutput,
    timeoutMs: options.llmTimeoutMs,
  });

  if (!llm || llm.verdict === null) {
    if (llm?.status === 'timeout') {
      return {
        classification: 'reviewer_timeout',
        confidence: 'high',
        modifiedFiles,
        failingTests,
        intersection,
        environmentSignals: [],
        llmVerdict: null,
        llmCritique: null,
        llmStatus: llm.status,
        llmTaskId: llm.taskId || null,
        suggestedRejectReason: null,
      };
    }
    return {
      classification: 'ambiguous',
      confidence: 'low',
      modifiedFiles,
      failingTests,
      intersection,
      environmentSignals: [],
      llmVerdict: null,
      llmCritique: null,
      llmStatus: llm?.status || null,
      llmTaskId: llm?.taskId || null,
      suggestedRejectReason: null,
    };
  }

  if (llm.verdict === 'no-go') {
    return {
      classification: 'baseline_broken',
      confidence: deterministicBase === 'baseline_candidate' ? 'high' : 'medium',
      modifiedFiles,
      failingTests,
      intersection,
      environmentSignals: [],
      llmVerdict: 'no-go',
      llmCritique: llm.critique,
      llmStatus: llm.status,
      llmTaskId: llm.taskId || null,
      suggestedRejectReason: 'verify_failed_baseline_unrelated',
    };
  }

  return {
    classification: 'task_caused',
    confidence: deterministicBase === 'baseline_candidate' ? 'medium' : 'low',
    modifiedFiles,
    failingTests,
    intersection,
    environmentSignals: [],
    llmVerdict: 'go',
    llmCritique: llm.critique,
    llmStatus: llm.status,
    llmTaskId: llm.taskId || null,
    suggestedRejectReason: null,
  };
}

module.exports = {
  LLM_TIMEOUT_MS,
  ENVIRONMENT_EXIT_CODES,
  ENVIRONMENT_STDERR_PATTERNS,
  normalizeVerifyOutput,
  detectEnvironmentFailure,
  parseFailingTests,
  getModifiedFiles,
  runLlmTiebreak,
  submitAndParseTiebreak,
  reviewVerifyFailure,
  buildTiebreakPrompt,
  extractVerifyExcerpt,
  STRICT_JSON_SUFFIX,
};
