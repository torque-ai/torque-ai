'use strict';

/**
 * Live functional test of all competitive features.
 * Run: node server/scripts/test-all-features.js
 */

const path = require('path');
process.chdir(path.join(__dirname, '..'));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('  PASS:', name);
    passed++;
  } catch (e) {
    console.log('  FAIL:', name, '-', e.message);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

console.log('=== 1. AGENT DISCOVERY ===');
const { discoverAgents } = require('../utils/agent-discovery');
const agents = discoverAgents();
test('returns installed array', () => assert(Array.isArray(agents.installed)));
test('returns missing array', () => assert(Array.isArray(agents.missing)));
test('returns suggestions array', () => assert(Array.isArray(agents.suggestions)));
console.log('   Installed:', agents.installed.map(a => a.name).join(', ') || 'none');
console.log();

console.log('=== 2. PROJECT TEMPLATES ===');
const { detectProjectType, listTemplates } = require('../templates/registry');
const templates = listTemplates();
test('has 10+ templates', () => assert(templates.length >= 10));
const detected = detectProjectType(path.join(__dirname, '..'));
test('detects this project type', () => assert(detected !== null));
console.log('   Detected:', detected ? detected.id : 'none');
console.log();

console.log('=== 3. TASK POLISH ===');
const { polishTaskDescription, isRoughDescription } = require('../utils/task-polish');
const polished = polishTaskDescription('fix the login bug');
test('returns title', () => assert(polished.title.length > 0));
test('returns criteria', () => assert(polished.acceptanceCriteria.length > 0));
test('isRough detects short text', () => assert(isRoughDescription('fix bug') === true));
console.log();

console.log('=== 4. BRANCH NAMES ===');
const { generateBranchName } = require('../utils/git-worktree');
const branch1 = generateBranchName('Fix the type error in EventSystem');
test('generates kebab-case', () => assert(branch1.startsWith('task-') && !branch1.includes(' ')));
test('handles empty', () => assert(generateBranchName('') === 'task-unnamed'));
test('max 50 chars', () => assert(branch1.length <= 50));
console.log('   Branch:', branch1);
console.log();

console.log('=== 5. CIRCUIT BREAKER ===');
const cb = require('../execution/circuit-breaker');
cb._reset();
cb.recordFailure('test-prov', 'ECONNREFUSED');
cb.recordFailure('test-prov', 'ECONNREFUSED');
test('2 failures stays CLOSED', () => assert(cb.getState('test-prov').state === 'CLOSED'));
cb.recordFailure('test-prov', 'ECONNREFUSED');
test('3 failures trips OPEN', () => assert(cb.getState('test-prov').state === 'OPEN'));
test('blocks when OPEN', () => assert(cb.allowRequest('test-prov') === false));
cb._reset();
console.log();

console.log('=== 6. RESUME CONTEXT ===');
const { buildResumeContext, formatResumeContextForPrompt } = require('../utils/resume-context');
const ctx = buildResumeContext('Wrote src/foo.ts\nSome error output', 'TypeError: bad', { description: 'Fix errors', durationMs: 5000, provider: 'codex' });
test('extracts files', () => assert(ctx.filesModified.length > 0));
test('extracts error', () => assert(ctx.errorDetails.length > 0));
test('formats markdown', () => assert(formatResumeContextForPrompt(ctx).includes('Previous Attempt')));
console.log();

console.log('=== 7. COMMIT MUTEX ===');
const mutex = require('../utils/commit-mutex');
mutex._reset();
test('starts unlocked', () => assert(!mutex.isLocked()));
test('waitingCount 0', () => assert(mutex.waitingCount() === 0));
console.log();

console.log('=== 8. PROVIDER SCORING ===');
const Database = require('better-sqlite3');
const db = new Database(':memory:');
const scoring = require('../db/provider-scoring');
scoring.init(db);
for (let i = 0; i < 6; i++) scoring.recordTaskCompletion({ provider: 'test-codex', success: i < 5, durationMs: 3000, costUsd: 0.02, qualityScore: 0.8 });
const score = scoring.getProviderScore('test-codex');
test('records 6 tasks', () => assert(score.total_tasks === 6));
test('reliability 5/6', () => assert(Math.abs(score.reliability_score - 5/6) < 0.01));
test('trusted at 5+', () => assert(score.trusted === 1));
test('composite > 0', () => assert(score.composite_score > 0));
console.log('   Composite:', score.composite_score.toFixed(3));
console.log();

console.log('=== 9. BUDGET WATCHER ===');
const bw = require('../db/budget-watcher');
bw.init(db);
db.exec("CREATE TABLE IF NOT EXISTS cost_budgets (id TEXT PRIMARY KEY, name TEXT, provider TEXT, budget_usd REAL, period TEXT DEFAULT 'monthly', current_spend REAL DEFAULT 0, alert_threshold_percent INTEGER DEFAULT 80, enabled INTEGER DEFAULT 1, metadata TEXT)");
db.exec("CREATE TABLE IF NOT EXISTS cost_tracking (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT, cost_usd REAL, tracked_at TEXT)");
db.exec("INSERT INTO cost_budgets VALUES ('b1','TestBudget','test-codex',10.0,'monthly',0,80,1,null)");
db.exec("INSERT INTO cost_tracking VALUES (null,'test-codex',9.5,datetime('now'))");
const check = bw.checkBudgetThresholds('test-codex');
test('detects 95% spend', () => assert(check && check.spendPercent >= 90));
test('returns downgrade', () => assert(check.thresholdBreached === 'downgrade'));
console.log('   Spend:', check.spendPercent + '%');
console.log();

console.log('=== 10. PROCESS ACTIVITY ===');
const { getProcessTreeCpu, clearActivityCache } = require('../utils/process-activity');
const activity = getProcessTreeCpu(process.pid);
test('returns processCount >= 1', () => assert(activity.processCount >= 1));
test('returns CPU number', () => assert(typeof activity.totalCpuPercent === 'number'));
clearActivityCache();
console.log('   CPU:', activity.totalCpuPercent.toFixed(1) + '%');
console.log();

console.log('=== 11. OUTPUT BUFFER ===');
const OutputBuffer = require('../execution/output-buffer');
let flushed = [];
const buf = new OutputBuffer({ flushCallback: (lines) => { flushed = lines; }, maxLines: 3 });
buf.append('a'); buf.append('b'); buf.append('c');
test('flushes at maxLines', () => assert(flushed.length === 3));
buf.destroy();
console.log();

console.log('=== 12. POLICY EFFECTS ===');
const { applyRewriteDescription, applyCompressOutput } = require('../policy-engine/active-effects');
test('prepends', () => assert(applyRewriteDescription('task', { prepend: 'PREFIX' }).startsWith('PREFIX')));
test('appends', () => assert(applyRewriteDescription('task', { append: 'SUFFIX' }).endsWith('SUFFIX')));
const big = Array.from({length: 200}, (_, i) => 'L' + i).join('\n');
const comp = applyCompressOutput(big, { max_lines: 10, keep: 'last' });
test('compresses to 11 lines', () => assert(comp.split('\n').length === 11));
test('adds header', () => assert(comp.startsWith('[Output truncated]')));
console.log();

console.log('=== 13. SYMBOL INDEXER ===');
const indexer = require('../utils/symbol-indexer');
test('supports 7+ languages', () => assert(Object.keys(indexer.LANGUAGE_MAP).length >= 7));
const files = indexer.walkProjectFiles(path.join(__dirname, '..', 'utils'));
test('finds files', () => assert(files.length > 5));
test('hash deterministic', () => assert(indexer.hashContent('x') === indexer.hashContent('x')));
console.log('   Files in utils/:', files.length);
console.log();

console.log('=== 14. SSE TICKETS ===');
const tickets = require('../auth/sse-tickets');
const ticket = tickets.generateTicket('test-key');
test('sse_tk_ prefix', () => assert(ticket.ticket.startsWith('sse_tk_')));
test('has expires_at', () => assert(ticket.expiresAt));
const v = tickets.validateTicket(ticket.ticket);
test('validates fresh', () => assert(v.valid === true));
test('returns apiKeyId', () => assert(v.apiKeyId === 'test-key'));
test('rejects reuse', () => assert(tickets.validateTicket(ticket.ticket).valid === false));
console.log();

db.close();

console.log('============================================');
console.log('  RESULTS: ' + passed + ' passed, ' + failed + ' failed');
console.log('============================================');

process.exit(failed > 0 ? 1 : 0);
