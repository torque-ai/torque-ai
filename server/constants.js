/**
 * Shared constants for TORQUE
 *
 * Consolidates extension sets, timeout values, artifact patterns, and base LLM rules
 * that were previously duplicated across task-manager.js, tools.js, and database.js.
 */

// --- Extension Sets ---

const CODE_EXTENSIONS = new Set([
  '.js', '.ts', '.jsx', '.tsx', '.py', '.cs', '.java', '.go', '.rs', '.rb', '.php', '.cpp', '.c', '.h', '.hpp'
]);

const SOURCE_EXTENSIONS = new Set([
  '.js', '.ts', '.jsx', '.tsx', '.py', '.cs', '.go', '.rs'
]);

const UI_EXTENSIONS = new Set([
  '.jsx', '.tsx', '.html', '.vue', '.svelte', '.xaml'
]);

const CONFIG_EXTENSIONS = new Set([
  '.json', '.yaml', '.yml', '.xml', '.toml', '.ini', '.env'
]);

// Array form for existing APIs that expect arrays
const BASELINE_EXTENSIONS = ['.cs', '.xaml', '.ts', '.tsx', '.js', '.jsx', '.py'];

const SYNTAX_CHECK_EXTENSIONS = new Set(['.js', '.ts', '.tsx', '.cs', '.java']);

const FILE_INDEX_EXTENSIONS = new Set([
  ...CODE_EXTENSIONS, ...UI_EXTENSIONS, ...CONFIG_EXTENSIONS,
  '.md', '.sql', '.sh', '.ps1', '.csproj', '.sln', '.scss', '.css'
]);

// --- LLM Artifact Patterns ---

const LLM_ARTIFACT_PATTERNS = [
  /<<<__newText__>>>/,
  /<<<__oldText__>>>/,
  /<<<__endText__>>>/,
];

// --- Base LLM Rules (shared across provider prompts) ---

const BASE_LLM_RULES = `### CRITICAL RULES:
1. NEVER create stub files or placeholder implementations
2. NEVER create empty classes/interfaces with just "// TODO" or "throw NotImplementedException"
3. NEVER create a new file if a similar file already exists - modify the existing one
4. ALWAYS include complete, working implementations
5. NEVER overwrite large files with minimal content
6. If you can't complete something fully, explain why instead of creating stubs
7. File names MUST be valid filesystem paths. NEVER use sentences or descriptions as file names
8. Only create or edit files that have proper extensions
9. NEVER create files whose name starts with "1st", "2nd", "Sure", "For ", "TODO", "Here is", or similar text`;

// --- Timeout Constants ---

const TASK_TIMEOUTS = {
  GIT_STATUS: 5000,
  GIT_DIFF: 10000,
  GIT_ADD: 15000,
  GIT_ADD_ALL: 30000,
  GIT_PUSH: 30000,
  GIT_COMMIT: 60000,
  GIT_RESET: 5000,
  PROCESS_QUERY: 5000,
  SYNTAX_CHECK: 5000,
  TYPESCRIPT_CHECK: 15000,
  TEST_RUN: 60000,
  VERIFY_COMMAND: 120000,
  BUILD_TIMEOUT: 300000,
  PROVIDER_CHECK: 10000,
  STARTUP: 60000,
  FORCE_KILL_DELAY: 5000,
  DEFAULT_TASK_MINUTES: 30,
  OLLAMA_API: 30000,
  HTTP_REQUEST: 30000,
  HEALTH_CHECK: 5000,
  FILE_WRITE: 10000,
  PROCESS_SPAWN: 15000,
  SNAPSCOPE_CAPTURE: 300000,
};

// Values are in MINUTES (not milliseconds). Convert before use: timeout * 60 * 1000
const PROVIDER_DEFAULT_TIMEOUTS = {
  'codex': 30,
  'claude-cli': 30,
  'aider-ollama': 30,
  'hashline-ollama': 10,
  'ollama': 10,
  'anthropic': 15,
  'deepinfra': 20,
  'cerebras': 10,
  'google-ai': 15,
  'groq': 10,
  'ollama-cloud': 15,
  'openrouter': 15,
  'hyperbolic': 20,
};

// ─── Provider Defaults ─────────────────────────────────────────────────
const PROVIDER_DEFAULTS = {
  STARTUP_TIMEOUT_MS: 60000,
  MAX_TIMEOUT_MINUTES: 480,
  PROGRESS_UPDATE_INTERVAL_MS: 5000,
  LITELLM_REQUEST_TIMEOUT_SECONDS: 120,
  OLLAMA_DEFAULT_CONTEXT: 8192,
  OLLAMA_MAX_CONTEXT: 32768,
  SMALL_FILE_LINE_THRESHOLD: 300,
  SMALL_FILE_OUTPUT_TOKENS: 4096,
  BATCH_LINE_LIMIT: 150,
  MOD_SAFE_LINE_LIMIT: 250,
  OLLAMA_CONTEXT_LINE_LIMIT: 1500, // EXP2: files >1500 lines exceed 32K token context window
  SMTP_SECURE_PORT: 465,
  HTTP_SUCCESS_STATUS: 200,
  AIDER_FILE_SIZE_THRESHOLD: 150,
};

const MODEL_TIER_THRESHOLDS = {
  SMALL_MAX_B: 8,
  MEDIUM_MAX_B: 20,
  // Large: >20B
};

// --- Error-Feedback Loop Constants ---

const ERROR_FEEDBACK_MAX_TURNS = 1;
const ERROR_FEEDBACK_TIMEOUT_MS = 30000;  // 30s per feedback turn

// --- tsserver Constants ---

const TSSERVER_REQUEST_TIMEOUT_MS = 8000;
const TSSERVER_SESSION_IDLE_TTL_MS = 1800000; // 30 minutes
const TSSERVER_MAX_RESTARTS = 5;
const TSSERVER_RESTART_BASE_DELAY_MS = 1000;

// --- Queue / Lifecycle Constants ---

/** Debounce delay (ms) before re-triggering processQueue after task state changes */
const QUEUE_RETRY_DEBOUNCE_MS = 50;

/** Debounce delay (ms) for stall recovery re-queue (slightly longer to avoid races) */
const STALL_REQUEUE_DEBOUNCE_MS = 100;

/** Default TTL for queued tasks in minutes (0 = no expiry) */
const QUEUE_TASK_TTL_MINUTES = 0;

/** Heartbeat interval (ms) for multi-session instance registration */
const INSTANCE_HEARTBEAT_INTERVAL_MS = 10000;

// --- Completion Grace Periods ---

/** Grace period (ms) before force-killing a process after completion is detected */
const COMPLETION_GRACE_MS = 15000;
/** Extended grace period (ms) for Codex provider (needs more time for natural exit) */
const COMPLETION_GRACE_CODEX_MS = 30000;

// --- Provider Fallback Defaults ---

/** Last-resort fallback model when no tier/host model is available */
const DEFAULT_FALLBACK_MODEL = 'qwen2.5-coder:32b';

// --- Streaming Output Cap ---

/** Max characters to accumulate in fullOutput during streaming (10 MB) */
const MAX_STREAMING_OUTPUT = 10 * 1024 * 1024;

/** Max size for task metadata JSON (256 KB) — RB-032 */
const MAX_METADATA_SIZE = 256 * 1024;

/** Max incoming WebSocket messages per connection per window — RB-055 */
const WS_MSG_RATE_LIMIT = 30;
/** WebSocket rate limit window duration (ms) */
const WS_MSG_RATE_WINDOW_MS = 10000;

// --- Rate Limiting ---

/** Max requests per rate limit window */
const RATE_LIMIT_MAX = 1000;
/** Rate limit window duration (ms) */
const RATE_LIMIT_WINDOW_MS = 60000;
/** Rate limit cleanup interval (ms) */
const RATE_LIMIT_CLEANUP_MS = 300000;

/** File size is considered truncated when percentage change is below this value */
const FILE_SIZE_TRUNCATION_THRESHOLD = -50;

/** File size is considered significantly shrunk when percentage change is below this value */
const FILE_SIZE_SHRINK_THRESHOLD = -25;

module.exports = {
  CODE_EXTENSIONS,
  SOURCE_EXTENSIONS,
  UI_EXTENSIONS,
  CONFIG_EXTENSIONS,
  BASELINE_EXTENSIONS,
  SYNTAX_CHECK_EXTENSIONS,
  FILE_INDEX_EXTENSIONS,
  LLM_ARTIFACT_PATTERNS,
  BASE_LLM_RULES,
  TASK_TIMEOUTS,
  PROVIDER_DEFAULT_TIMEOUTS,
  PROVIDER_DEFAULTS,
  MODEL_TIER_THRESHOLDS,
  TSSERVER_REQUEST_TIMEOUT_MS,
  TSSERVER_SESSION_IDLE_TTL_MS,
  TSSERVER_MAX_RESTARTS,
  TSSERVER_RESTART_BASE_DELAY_MS,
  QUEUE_RETRY_DEBOUNCE_MS,
  STALL_REQUEUE_DEBOUNCE_MS,
  QUEUE_TASK_TTL_MINUTES,
  INSTANCE_HEARTBEAT_INTERVAL_MS,
  ERROR_FEEDBACK_MAX_TURNS,
  ERROR_FEEDBACK_TIMEOUT_MS,
  COMPLETION_GRACE_MS,
  COMPLETION_GRACE_CODEX_MS,
  DEFAULT_FALLBACK_MODEL,
  MAX_STREAMING_OUTPUT,
  MAX_METADATA_SIZE,
  WS_MSG_RATE_LIMIT,
  WS_MSG_RATE_WINDOW_MS,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_CLEANUP_MS,
  FILE_SIZE_TRUNCATION_THRESHOLD,
  FILE_SIZE_SHRINK_THRESHOLD,
};
