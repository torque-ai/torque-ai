'use strict';

const childProcess = require('node:child_process');
const { createHash } = require('node:crypto');
const { getProviderLanePolicyFromProject, specializePolicyForKind } = require('./provider-lane-policy');
const logger = require('../logger').child({ component: 'verify-review' });

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
const ACTIVE_VERIFY_REVIEW_STATUSES = new Set(['pending', 'pending_approval', 'queued', 'running', 'waiting']);

// Files whose modification can break tests that don't import them directly:
// dependency lockfiles, build/test config, repo-wide infrastructure dirs,
// top-level shell/PowerShell scripts. When ANY modified file matches these
// patterns, `intersection: []` is no longer reliable evidence that failing
// tests are unrelated to the diff — a package.json bump can break codegraph
// tests without any literal path overlap. The classifier refuses to upgrade
// from `ambiguous` to `baseline_likely` whenever this returns true; the
// engine's strategy escalation (retry → reject_and_advance → escalate) is
// the safety net for those cases instead.
const SHARED_INFRASTRUCTURE_PATTERNS = [
  // Node / JS lockfiles + manifests
  /^(?:.*\/)?package\.json$/i,
  /^(?:.*\/)?package-lock\.json$/i,
  /^(?:.*\/)?yarn\.lock$/i,
  /^(?:.*\/)?pnpm-lock\.yaml$/i,
  /^(?:.*\/)?\.npmrc$/i,
  /^(?:.*\/)?\.yarnrc[^/]*$/i,
  // Test/build config
  /^(?:.*\/)?tsconfig[^/]*\.json$/i,
  /^(?:.*\/)?(?:jest|vitest|vite|babel|webpack|rollup|esbuild|playwright|cypress)\.config\.[a-z]+$/i,
  /^(?:.*\/)?eslint\.config\.[a-z]+$/i,
  /^(?:.*\/)?\.eslintrc[^/]*$/i,
  /^(?:.*\/)?\.prettierrc[^/]*$/i,
  /^(?:.*\/)?prettier\.config\.[a-z]+$/i,
  // Python project metadata
  /^(?:.*\/)?pyproject\.toml$/i,
  /^(?:.*\/)?requirements[^/]*\.txt$/i,
  /^(?:.*\/)?Pipfile$/i,
  /^(?:.*\/)?Pipfile\.lock$/i,
  /^(?:.*\/)?setup\.(?:py|cfg)$/i,
  // Rust / Go / .NET / JVM build files
  /^(?:.*\/)?Cargo\.toml$/i,
  /^(?:.*\/)?Cargo\.lock$/i,
  /^(?:.*\/)?go\.mod$/i,
  /^(?:.*\/)?go\.sum$/i,
  /^(?:.*\/)?[^/]+\.(?:csproj|sln|fsproj|vbproj)$/i,
  /^(?:.*\/)?build\.gradle[^/]*$/i,
  /^(?:.*\/)?settings\.gradle[^/]*$/i,
  /^(?:.*\/)?[^/]+\.gradle(?:\.kts)?$/i,
  /^(?:.*\/)?pom\.xml$/i,
  /^(?:.*\/)?Makefile$/i,
  /^(?:.*\/)?CMakeLists\.txt$/i,
  // Repo-wide infrastructure directories
  /^\.github\//i,
  /^\.gitlab\//i,
  /^\.config\//i,
  /^\.husky\//i,
  /^scripts\//i,
  /^tools\//i,
  /^bin\//i,
  /^build\//i,
  // Top-level shell/script files (depth 1 only, e.g. install-userbin.sh).
  // Nested .sh under src/ is not flagged — it's typically a fixture or
  // launcher tightly scoped to the feature it lives in.
  /^[^/]+\.(?:sh|ps1|bat|cmd|psm1)$/i,
];

function isSharedInfrastructureFile(filePath) {
  if (filePath == null) return false;
  const norm = String(filePath).replace(/\\/g, '/');
  if (!norm) return false;
  return SHARED_INFRASTRUCTURE_PATTERNS.some((re) => re.test(norm));
}

function modifiedFilesTouchingSharedInfra(modifiedFiles) {
  if (!Array.isArray(modifiedFiles)) return [];
  return modifiedFiles.filter(isSharedInfrastructureFile);
}

const PYTHON_MISSING_MODULE_RE = /ModuleNotFoundError:\s+No module named ['"]([^'"]+)['"]/i;
const PYTHON_UNITTEST_FAILED_IMPORT_RE = /Failed to import test module:\s*([A-Za-z0-9_.]+)/i;

function isTestLikePythonModule(moduleName) {
  const name = String(moduleName || '').trim();
  return /^tests?\./i.test(name)
    || /^test_[A-Za-z0-9_]+$/i.test(name)
    || /\.test_[A-Za-z0-9_]+$/i.test(name)
    || /_tests?$/i.test(name);
}

function pythonModuleToPath(moduleName) {
  const name = String(moduleName || '').trim();
  if (!name) return null;
  return `${name.replace(/\./g, '/')}.py`;
}

function normalizeSearchText(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .toLowerCase();
}

function workItemMentionsTarget(workItem, needles) {
  if (!workItem || !Array.isArray(needles) || needles.length === 0) {
    return false;
  }
  const haystack = Object.values(workItem)
    .filter((value) => typeof value === 'string')
    .map(normalizeSearchText)
    .join('\n');
  if (!haystack) return false;
  return needles.some((needle) => needle && haystack.includes(normalizeSearchText(needle)));
}

function detectMissingTaskOwnedVerifyTarget(verifyOutput, workItem) {
  const combined = normalizeVerifyOutput(verifyOutput).combined || '';
  const moduleMatch = combined.match(PYTHON_MISSING_MODULE_RE);
  const failedImportMatch = combined.match(PYTHON_UNITTEST_FAILED_IMPORT_RE);
  const moduleName = moduleMatch?.[1] || failedImportMatch?.[1] || null;
  if (!moduleName || !isTestLikePythonModule(moduleName)) {
    return { detected: false };
  }

  const modulePath = pythonModuleToPath(moduleName);
  const pathBase = modulePath ? modulePath.split('/').pop() : null;
  const needles = [
    moduleName,
    modulePath,
    modulePath ? modulePath.replace(/\.py$/i, '') : null,
    pathBase,
  ].filter(Boolean);

  if (!workItemMentionsTarget(workItem, needles)) {
    return { detected: false };
  }

  return {
    detected: true,
    module_name: moduleName,
    module_path: modulePath,
    signals: ['missing_task_owned_verify_target'],
  };
}

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

// Strip SGR (color) escape codes. Vitest 4 emits ANSI markup even when stdout
// is redirected to a non-TTY file, and the embedded ESC[xxm bytes break
// regexes that anchor on `\s+` between marker and path. Stripping here keeps
// every downstream parser (vitest 3, vitest 4, dotnet, pester, pytest)
// working against clean text.
// eslint-disable-next-line no-control-regex -- intentional: matches the SGR ESC byte vitest 4 emits.
const ANSI_CSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(s) {
  return String(s || '').replace(ANSI_CSI_RE, '');
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
    .map((part) => stripAnsi(part).trim())
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

// Detect compile/build failures. Distinct from environment_failure (no tool
// installed, permission denied, timeout) and from ambiguous (tests ran and
// failed for unclear reasons). A build failure means the verify command exited
// non-zero before any tests could run — exactly the case where failingTests=[]
// is *more* certain, not less. Routing this through the auto-retry path
// (instead of the ambiguous-pause path) is what catches "code doesn't compile"
// regressions like SpudgetBooks f9cf2275 (missing `using`, variable shadow).
function detectBuildFailure(verifyOutput) {
  const normalized = normalizeVerifyOutput(verifyOutput);
  const exit = normalized.exitCode;
  if (typeof exit === 'number' && exit === 0) {
    return { detected: false, signals: [] };
  }
  const combined = normalized.combined || '';
  const signals = [];

  // .NET / C#: roslyn emits "error CS\d+:" and trailing "Build FAILED.\n N Error(s)".
  if (/\berror CS\d{3,5}:/.test(combined)) signals.push('csharp_compile_error');
  if (/^\s*Build FAILED\.\s*$/m.test(combined)) signals.push('dotnet_build_failed_marker');
  // The trailing `\b` after `\)` would never match (`)` is non-word and the
  // following char is whitespace or end-of-line, also non-word). Anchor on
  // the leading `\b` and a non-greedy whitespace/EOL terminator instead.
  const dotnetErrCount = combined.match(/\b([1-9]\d*)\s+Error\(s\)/);
  if (dotnetErrCount) signals.push(`dotnet_error_count_${dotnetErrCount[1]}`);

  // TypeScript / tsc: "error TS\d+:" or watch-mode "Found N error(s)".
  // Same trailing-\b fix here — `.` followed by whitespace doesn't transition.
  if (/\berror TS\d+:/.test(combined)) signals.push('ts_compile_error');
  if (/Found\s+[1-9]\d*\s+errors?\./.test(combined)) signals.push('tsc_found_errors');

  // Java javac
  if (/^.+\.java:\d+:\s+error:/m.test(combined)) signals.push('javac_error');

  // GCC / clang: file:line:col: error: <description>. Anchored to known C-family
  // extensions to avoid matching python tracebacks like `Module.py:10:5: error:`.
  if (/^.+\.(?:c|cc|cpp|cxx|c\+\+|h|hpp|hh|m|mm):\d+:\d+:\s+error:/m.test(combined)) signals.push('cc_error');

  // make / gmake
  if (/make(?:\[\d+\])?:\s+\*\*\*\s+\[.+\]\s+Error\s+\d+/.test(combined)) signals.push('make_error');

  // Rust cargo: "error[E####]:" with non-zero exit + "could not compile"
  if (/\berror\[E\d{4,5}\]:/.test(combined)) signals.push('rust_compile_error');
  if (/error: could not compile/.test(combined)) signals.push('cargo_could_not_compile');

  // Go: lines like "./pkg/foo.go:42:13: undefined: Bar" before the test
  // runner emits PASS/FAIL summaries. Earlier rev gated this on the entire
  // output being free of PASS/FAIL anywhere, which suppressed detection
  // whenever any sibling package reported PASS. Anchor instead to the
  // go-compile-error idiom: `cannot find` / `undefined:` / `expected` etc.
  // following the file:line:col, which test-runtime panics don't emit.
  if (/^.+\.go:\d+:\d+:\s+(?:undefined:|cannot find|expected\s|syntax error|imported and not used\b|undeclared name\b)/m.test(combined)) {
    signals.push('go_compile_error');
  }

  return { detected: signals.length > 0, signals };
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

  // Vitest arrow pointer (stack trace): "❯ src/foo.test.ts:line:col"
  const vitestPointerRe = /❯\s+([A-Za-z0-9_./\\-]+?\.(?:ts|tsx|js|jsx|mjs|cjs)):\d+/g;
  for (const m of combined.matchAll(vitestPointerRe)) {
    paths.add(m[1]);
  }
  // Vitest 4 file-level pointer: "❯ src/foo.test.ts (1 test | 1 failed) 338ms"
  // Vitest 4 emits a per-file summary on its own line — the pointer is followed
  // by a parenthesized "(N test[s] | M failed)" rather than the colon-line-col
  // pair from a stack trace. Without this, projects whose only signal is the
  // file-level summary (the FAIL header is wrapped in ANSI background colors
  // that even after stripping leave an unusual whitespace prefix) get no path
  // matches and parseFailingTests returns []. Live regression: torque-public
  // 2026-04-25.
  const vitest4FileRe = /❯\s+([A-Za-z0-9_./\\-]+?\.(?:ts|tsx|js|jsx|mjs|cjs))\s+\([^)]*\bfailed\b[^)]*\)/g;
  for (const m of combined.matchAll(vitest4FileRe)) {
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

  // Pester (PowerShell). Two stack-trace shapes:
  //   Pester 5: "at <ScriptBlock>, C:\path\to\Foo.Tests.ps1:42"
  //   Pester 4: "at line: 42 in C:\path\to\Foo.Tests.ps1"
  // Both end up with the *.Tests.ps1 path next to a colon-line marker.
  // Also catch the bare "[-] " failure-marker line which sometimes
  // includes the script file in the test name (rare but seen with
  // -OutputFormat Detailed). Without this parser, PowerShell-based
  // projects (e.g. StateTrace running Invoke-AllChecks.ps1) returned
  // failingTests=[] forever, and the verify-review tiebreak short-
  // circuited to ambiguous on every cycle — observed live 2026-04-25.
  const pesterStackRe = /\.[Tt]ests\.[Pp][Ss]1\b/;
  if (pesterStackRe.test(combined)) {
    // Stack-trace forms — extract the .Tests.ps1 path.
    const pesterPathRe = /(?:at\s+(?:<ScriptBlock>|line:\s*\d+\s+in)[\s,]+)([A-Za-z]:[\\/][^\s,]+?\.[Tt]ests\.[Pp][Ss]1|\.{1,2}[\\/][^\s,]+?\.[Tt]ests\.[Pp][Ss]1|[A-Za-z0-9_][A-Za-z0-9_./\\-]*\.[Tt]ests\.[Pp][Ss]1)/g;
    for (const m of combined.matchAll(pesterPathRe)) {
      paths.add(m[1]);
    }
    // Failed-test summary line: "Failed: ... <Describe>.<It>" doesn't
    // include the path; Pester writes the path in the stack trace
    // immediately below. The pesterPathRe above catches that.
    // Bare-line backstop for unusual formats: "X [-] ... <path>.Tests.ps1"
    const pesterMarkerRe = /^[\s✅-]*\[-\][^\n]*?([A-Za-z]:[\\/][^\s,]+?\.[Tt]ests\.[Pp][Ss]1|[A-Za-z0-9_][A-Za-z0-9_./\\-]*\.[Tt]ests\.[Pp][Ss]1)/gm;
    for (const m of combined.matchAll(pesterMarkerRe)) {
      paths.add(m[1]);
    }
  }

  return Array.from(paths);
}

// `git diff` can hang if the index is locked or the filesystem is wedged.
// Without a timeout, this Promise never resolves and the caller — the
// verify-review classifier inside the auto-recovery loop — blocks
// indefinitely, taking the whole recovery loop down with it. Cap at 15s:
// `git diff --name-only` on a healthy repo finishes in <1s; anything past
// that is a sign of trouble, and an empty result lets the classifier fall
// back to its less-informed branches rather than wedge.
const GET_MODIFIED_FILES_TIMEOUT_MS = 15_000;

async function getModifiedFiles(workingDirectory, worktreeBranch, mergeBase) {
  if (!workingDirectory || !worktreeBranch || !mergeBase) return [];
  return new Promise((resolve) => {
    let stdout = '';
    let child;
    let settled = false;
    let timeoutHandle = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      resolve(value);
    };
    try {
      child = childProcess.spawn('git', ['diff', '--name-only', `${mergeBase}...${worktreeBranch}`], {
        cwd: workingDirectory,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch (_e) {
      finish([]);
      return;
    }
    timeoutHandle = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish([]);
    }, GET_MODIFIED_FILES_TIMEOUT_MS);
    timeoutHandle.unref?.();
    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.on('error', () => finish([]));
    child.on('close', (code) => {
      if (code !== 0) return finish([]);
      const paths = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      finish(paths);
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

// The reviewer is a yes/no JSON verdict task — it does not need a 235B
// MoE model. Empirically, qwen-3-235b returns null output for short
// structured prompts even with JSON mode (observed on StateTrace
// 2026-04-26: cerebras task `6ff68746-...` completed with output=null).
// Pin a smaller/faster model that handles JSON-mode well by default.
// Override via env for ops flexibility; empty string opts back into
// whatever model the routing template/provider chooses.
function readReviewerModelOverride() {
  const raw = process.env.TORQUE_VERIFY_REVIEWER_MODEL;
  if (raw === undefined) return undefined;
  const trimmed = String(raw).trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Models that show up in cerebras /v1/models but 404 on chat/completions
// for tier-1 keys. Observed live 2026-04-26: 4 verify_review tasks died
// with `Cerebras streaming API error (404): Model zai-glm-4.7 does not
// exist or you do not have access to it`. The reviewer prompt is JSON-mode,
// short, and any of {llama3.1-8b, qwen-3-235b} satisfies it — there's no
// reason to push the reviewer toward tier-restricted models, even if an
// operator picks one via env override or a routing template hands it down.
// llama3.1-8b is the safe default; substitute when an unreachable choice
// arrives so the reviewer never burns 30s on a doomed 404.
const REVIEWER_TIER_RESTRICTED_MODELS = new Set([
  'zai-glm-4.7',
  'gpt-oss-120b',
]);
const REVIEWER_FALLBACK_MODEL = 'llama3.1-8b';

function isReviewerModelReachable(model) {
  if (!model || typeof model !== 'string') return true;
  return !REVIEWER_TIER_RESTRICTED_MODELS.has(model.trim());
}

function normalizeReviewerProvider(provider) {
  if (typeof provider !== 'string') return null;
  const trimmed = provider.trim().toLowerCase();
  return trimmed || null;
}

function isReviewerProviderEnabled(provider) {
  const normalized = normalizeReviewerProvider(provider);
  if (!normalized) return false;

  try {
    const providerRoutingCore = require('../db/provider/routing-core');
    if (typeof providerRoutingCore.getProvider !== 'function') return false;
    const providerConfig = providerRoutingCore.getProvider(normalized);
    return Boolean(providerConfig && providerConfig.enabled);
  } catch (error) {
    logger.debug('verify-review: provider enabled lookup failed', {
      provider: normalized,
      error: error?.message || String(error),
    });
    return false;
  }
}

function resolveReviewerProvider(project) {
  const envOverride = readReviewerProviderOverride();
  if (envOverride !== undefined) {
    const normalizedOverride = normalizeReviewerProvider(envOverride);
    if (!normalizedOverride) return null;
    if (isReviewerProviderEnabled(normalizedOverride)) return normalizedOverride;
    logger.warn('verify-review: configured reviewer provider is disabled; deferring to routing', {
      provider: normalizedOverride,
      source: 'TORQUE_VERIFY_REVIEWER_PROVIDER',
    });
    return null;
  }

  const lanePolicy = specializePolicyForKind(
    getProviderLanePolicyFromProject(project || {}),
    'verify_review'
  );
  if (lanePolicy?.expected_provider) {
    return null;
  }

  const defaultProvider = 'cerebras';
  if (isReviewerProviderEnabled(defaultProvider)) return defaultProvider;
  logger.warn('verify-review: default reviewer provider is disabled; deferring to routing', {
    provider: defaultProvider,
  });
  return null;
}

function resolveReviewerModel(reviewerProvider) {
  const normalizedProvider = normalizeReviewerProvider(reviewerProvider);
  const envOverride = readReviewerModelOverride();
  // Empty string env value opts back into the routing template's choice
  // (envOverride === null) — preserve that escape hatch.
  if (envOverride === null) return null;
  // A model override without a provider override is usually a provider-specific
  // model name leaking into smart routing. Leave model selection to the chosen
  // provider unless this helper is also pinning the provider.
  if (!normalizedProvider) return null;
  if (!isReviewerModelReachable(envOverride)) {
    // Don't honor env overrides that are known to 404 for the typical
    // free-tier key. Operators on paid tiers who actually want
    // zai-glm-4.7/gpt-oss-120b can set it via a routing template
    // (where the per-task choice happens after this guard).
    return normalizedProvider === 'cerebras' ? REVIEWER_FALLBACK_MODEL : null;
  }
  if (envOverride !== undefined) return envOverride;
  // The default fallback model is Cerebras-specific. When provider
  // selection is deferred to a target project's lane policy, leave the
  // model unset so Codex/Claude/Ollama lanes cannot receive a Cerebras
  // model name such as llama3.1-8b.
  if (normalizedProvider !== 'cerebras') return null;
  // llama3.1-8b is the smallest cerebras model that's reliably available
  // on the free tier and handles JSON-mode short verdicts cleanly.
  // zai-glm-4.7 and gpt-oss-120b appear in /v1/models but 404 on chat
  // completions for tier-1 keys.
  return REVIEWER_FALLBACK_MODEL;
}

// Reinforces the JSON-shape contract when the first attempt produced
// unparseable output. Some models occasionally wrap the verdict in
// markdown fences or prose. Appending this on retry tightens the spec
// and usually produces clean JSON without burning a re-route.
const STRICT_JSON_SUFFIX = '\n\nIMPORTANT: Output JSON only — no markdown, no fences, no commentary outside the JSON object. Exactly: {"verdict":"go" or "no-go","critique":"..."}\n';

async function submitAndParseTiebreak({ prompt, workingDirectory, project, workItem, timeoutMs, reviewerProvider, reviewerModel }) {
  const { submitFactoryInternalTask } = require('./internal-task-submit');
  const { handleAwaitTask } = require('../handlers/workflow/await');
  const taskCore = require('../db/task-core');

  const timeoutMinutes = timeoutMinutesForMs(timeoutMs);
  const reviewHash = getVerifyReviewHash(prompt);
  let taskId;
  let taskStatus = null;
  const existingTask = findExistingVerifyReviewTask(taskCore, {
    project,
    workItem,
    reviewHash,
  });
  if (existingTask) {
    taskId = existingTask.id;
    taskStatus = String(existingTask.status || '').toLowerCase();
  }
  try {
    if (!taskId) {
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
        // prefer_free=true lets smart routing pick an enabled free provider
        // when this helper is not pinning a known-enabled reviewer provider.
        // Avoids paying Codex prices for what a fast free model handles in seconds.
        prefer_free: true,
        ...(reviewerProvider ? { provider: reviewerProvider } : {}),
        // Pin the reviewer model only when the reviewer provider is pinned
        // too; otherwise model selection belongs to smart routing.
        ...(reviewerModel ? { model: reviewerModel } : {}),
        extra_tags: [`factory:verify_review_hash=${reviewHash}`],
        // Structured-output hint: the cerebras adapter (and any future
        // adapter) treats response_format=json_object as a signal to
        // a) flip on the API's JSON mode, b) prefer the smaller/faster
        // structured model, and c) clamp temperature to 0. Cuts the
        // invalid_output retry rate to near zero on JSON-mode-capable
        // providers.
        extra_metadata: {
          response_format: 'json_object',
          max_tokens: 512,
          verify_review_hash: reviewHash,
        },
      });
      taskId = submitResult?.task_id || null;
      taskStatus = null;
    }
  } catch (err) {
    // Capture the underlying reason so the verifier's heuristic-only fallback
    // path is auditable. Without this, `llmStatus: "submit_failed"` ended up
    // in decision logs with no explanation of WHY (provider unhealthy, no
    // matching adapter, lane policy mismatch, validation error, etc.) — seen
    // live on torque-public work_item 596 where a stalled smart_submit_task
    // forced the verifier to classify `baseline_likely` based purely on
    // file-overlap, paused the project, and the operator had no signal to
    // act on.
    const submitError = err && err.message ? String(err.message).slice(0, 500) : 'unknown';
    logger.warn('verify-review: tiebreak submit threw', {
      project_id: project?.id || null,
      work_item_id: workItem?.id || null,
      submitError,
    });
    return buildLlmResult({ status: 'submit_failed', submitError });
  }
  if (!taskId) {
    logger.warn('verify-review: tiebreak submit returned no task_id', {
      project_id: project?.id || null,
      work_item_id: workItem?.id || null,
    });
    return buildLlmResult({ status: 'submit_failed', submitError: 'no_task_id_returned' });
  }

  let awaitResult = null;
  try {
    if (taskStatus !== 'completed') {
      awaitResult = await handleAwaitTask({
        task_id: taskId,
        timeout_minutes: timeoutMinutes,
        heartbeat_minutes: 0,
      });
    }
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

function getVerifyReviewHash(prompt) {
  return createHash('sha256')
    .update(String(prompt || ''))
    .digest('hex')
    .slice(0, 16);
}

function findExistingVerifyReviewTask(taskCore, { project, workItem, reviewHash }) {
  if (!taskCore || typeof taskCore.listTasks !== 'function' || !project?.id || !workItem?.id || !reviewHash) {
    return null;
  }

  const projectTag = `factory:project_id=${project.id}`;
  const workItemTag = `factory:work_item_id=${workItem.id}`;
  const hashTag = `factory:verify_review_hash=${reviewHash}`;
  let candidates = [];
  try {
    candidates = taskCore.listTasks({
      project: 'factory-plan',
      tag: workItemTag,
      statuses: ['pending', 'pending_approval', 'queued', 'running', 'waiting', 'completed'],
      orderBy: 'created_at',
      orderDir: 'desc',
      limit: 50,
      columns: ['id', 'status', 'tags', 'created_at', 'started_at'],
    });
  } catch (_e) {
    return null;
  }

  const matching = candidates.filter((candidate) => (
    Array.isArray(candidate?.tags)
    && candidate.tags.includes('factory:verify_review')
    && candidate.tags.includes(projectTag)
    && candidate.tags.includes(workItemTag)
    && candidate.tags.includes(hashTag)
  ));
  if (matching.length === 0) return null;

  return matching.find((candidate) => ACTIVE_VERIFY_REVIEW_STATUSES.has(String(candidate.status || '').toLowerCase()))
    || matching.find((candidate) => String(candidate.status || '').toLowerCase() === 'completed')
    || null;
}

// Statuses that warrant an in-process retry: the first attempt produced
// no usable verdict and the failure mode is something a stricter prompt
// might fix. `invalid_output` (bad JSON) and `empty_output` (cerebras
// returned a null output, observed live with qwen-3-235b on JSON-mode
// short prompts) both qualify. Other null-verdict statuses (timeout,
// submit_failed, await_failed, missing_task, not_completed) are
// terminal — no point retrying them in this loop.
const RETRYABLE_TIEBREAK_STATUSES = new Set(['invalid_output', 'empty_output']);

function shouldRetryTiebreakWithRouting(result, reviewerProvider) {
  if (!reviewerProvider || result?.status !== 'submit_failed') return false;
  const submitError = String(result?.submitError || '').toLowerCase();
  return submitError.includes('provider_error')
    || submitError.includes('provider is disabled')
    || submitError.includes('provider_unavailable')
    || submitError.includes('provider not found')
    || submitError.includes('adapter not available')
    || submitError.includes('not responding');
}

async function runLlmTiebreak({ failingTests, modifiedFiles, workItem, project, workingDirectory, verifyOutput, timeoutMs = LLM_TIMEOUT_MS }) {
  const prompt = buildTiebreakPrompt({ failingTests, modifiedFiles, workItem, verifyOutput });
  const reviewerProvider = resolveReviewerProvider(project);
  const reviewerModel = resolveReviewerModel(reviewerProvider);
  let args = { workingDirectory, project, workItem, timeoutMs, reviewerProvider, reviewerModel };

  let first = await module.exports.submitAndParseTiebreak({ ...args, prompt });
  if (shouldRetryTiebreakWithRouting(first, reviewerProvider)) {
    args = {
      workingDirectory,
      project,
      workItem,
      timeoutMs,
      reviewerProvider: null,
      reviewerModel: null,
    };
    first = await module.exports.submitAndParseTiebreak({ ...args, prompt });
  }
  if (!RETRYABLE_TIEBREAK_STATUSES.has(first.status)) return first;

  // Retry once with a stricter JSON-only instruction. Without this, a
  // single malformed/empty response sends the project to
  // verify_reviewed_ambiguous_paused with confidence=low — which then
  // needs auto-recovery + another reviewer task anyway. One in-process
  // retry costs the same time, often returns a verdict the first
  // attempt almost had, and avoids burning auto-recovery attempts on a
  // parse-error or null-output nuisance.
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

  // Build failure: non-zero exit with compiler-error signatures and no
  // failingTests parsed (because the verify command never reached the test
  // runner). Route to the auto-retry path with high confidence — build
  // failures are MORE certain than test ambiguity, not less. This is the
  // gap that let f9cf2275 ship past verify on 2026-04-23.
  const buildFail = detectBuildFailure(verifyOutput);
  if (buildFail.detected) {
    return {
      classification: 'build_failure',
      confidence: 'high',
      modifiedFiles: [],
      failingTests: [],
      intersection: [],
      environmentSignals: [],
      buildSignals: buildFail.signals,
      llmVerdict: null,
      llmCritique: null,
      suggestedRejectReason: 'verify_failed_build_error',
    };
  }

  const missingTaskTarget = module.exports.detectMissingTaskOwnedVerifyTarget(verifyOutput, workItem);
  if (missingTaskTarget.detected) {
    const modifiedFiles = await module.exports.getModifiedFiles(workingDirectory, worktreeBranch, mergeBase);
    return {
      classification: 'task_caused',
      confidence: 'high',
      modifiedFiles,
      failingTests: missingTaskTarget.module_path ? [missingTaskTarget.module_path] : [],
      intersection: [],
      environmentSignals: [],
      verifySignals: missingTaskTarget.signals || [],
      missingModuleName: missingTaskTarget.module_name || null,
      llmVerdict: null,
      llmCritique: null,
      suggestedRejectReason: null,
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
      const factoryDecisions = require('../db/factory/decisions');
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
        llmSubmitError: llm?.submitError || null,
        suggestedRejectReason: null,
      };
    }

    // Deterministic baseline-likely upgrade path: when the LLM verdict is
    // unavailable but the deterministic shape is strong (failing tests do
    // not touch any modified file, AND no modified file is shared
    // infrastructure that could break unrelated tests indirectly), classify
    // as `baseline_likely` instead of `ambiguous`. The loop-controller
    // routes this through the same handler as `baseline_broken` — reject
    // the work item, pause the project, then the baseline-probe re-runs
    // verify on main to confirm. If main is also broken, the project
    // stays paused (correct). If main passes, the project resumes and the
    // baseline-clear path requeues the blocked work item.
    const sharedInfraFiles = modifiedFilesTouchingSharedInfra(modifiedFiles);
    const sharedInfraTouched = sharedInfraFiles.length > 0;
    const deterministicBaselineLikely = (
      failingTests.length > 0
      && intersection.length === 0
      && modifiedFiles.length > 0
      && !sharedInfraTouched
    );
    if (deterministicBaselineLikely) {
      return {
        classification: 'baseline_likely',
        confidence: 'medium',
        modifiedFiles,
        failingTests,
        intersection,
        environmentSignals: [],
        llmVerdict: null,
        llmCritique: null,
        llmStatus: llm?.status || null,
        llmTaskId: llm?.taskId || null,
        llmSubmitError: llm?.submitError || null,
        sharedInfraTouched: false,
        sharedInfraFiles: [],
        suggestedRejectReason: 'verify_failed_baseline_likely_unrelated',
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
      llmSubmitError: llm?.submitError || null,
      sharedInfraTouched,
      sharedInfraFiles,
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
      llmSubmitError: llm?.submitError || null,
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
    llmSubmitError: llm?.submitError || null,
    suggestedRejectReason: null,
  };
}

module.exports = {
  LLM_TIMEOUT_MS,
  ENVIRONMENT_EXIT_CODES,
  ENVIRONMENT_STDERR_PATTERNS,
  SHARED_INFRASTRUCTURE_PATTERNS,
  normalizeVerifyOutput,
  detectEnvironmentFailure,
  detectBuildFailure,
  detectMissingTaskOwnedVerifyTarget,
  parseFailingTests,
  getModifiedFiles,
  runLlmTiebreak,
  submitAndParseTiebreak,
  shouldRetryTiebreakWithRouting,
  getVerifyReviewHash,
  findExistingVerifyReviewTask,
  reviewVerifyFailure,
  buildTiebreakPrompt,
  extractVerifyExcerpt,
  isSharedInfrastructureFile,
  modifiedFilesTouchingSharedInfra,
  STRICT_JSON_SUFFIX,
  // Exported for tests
  resolveReviewerModel,
  isReviewerModelReachable,
  REVIEWER_TIER_RESTRICTED_MODELS,
  REVIEWER_FALLBACK_MODEL,
};
