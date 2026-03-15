'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  handleAuditCodebase,
  handleListAuditRuns,
  handleGetAuditFindings,
  handleUpdateAuditFinding,
  handleGetAuditRunSummary,
  init: initHandlers,
} = require('../handlers/audit-handlers');

const { init: initOrchestrator } = require('../audit/orchestrator');
const { processTaskResult } = require('../audit/aggregator');
const auditStore = require('../db/audit-store');

// --- In-memory SQLite setup ---
const Database = require('better-sqlite3');
const { createTables } = require('../db/schema-tables');

let rawDb;

function initTestDb() {
  rawDb = new Database(':memory:');
  rawDb.pragma('journal_mode = WAL');
  createTables(rawDb, { info() {}, warn() {}, error() {} });
  auditStore.setDb(rawDb);
}

function teardownDb() {
  if (rawDb) {
    rawDb.close();
    rawDb = null;
  }
}

// --- Temp project helpers ---

function createTempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-e2e-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src', 'app.js'),
    [
      'const express = require("express");',
      'const app = express();',
      '',
      'app.get("/users", (req, res) => {',
      '  const id = req.query.id;',
      '  const query = "SELECT * FROM users WHERE id = " + id;',
      '  db.query(query).then(rows => res.json(rows));',
      '});',
      '',
      'app.listen(3000);',
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'utils.js'),
    [
      'function add(a, b) { return a + b; }',
      'function multiply(a, b) { return a * b; }',
      'module.exports = { add, multiply };',
    ].join('\n'),
    'utf8'
  );
  return dir;
}

// --- Tests ---

describe('audit end-to-end', () => {
  let projectDir;
  let capturedWorkflowTasks;

  beforeEach(() => {
    initTestDb();

    projectDir = createTempProject();
    capturedWorkflowTasks = [];

    const mockCreateWorkflow = vi.fn((args) => {
      if (Array.isArray(args.tasks)) {
        capturedWorkflowTasks.push(...args.tasks);
      }
      return {
        content: [{ type: 'text', text: '## Workflow Created\n\n**ID:** e2e00001-0000-0000-0000-000000000001\n**Name:** audit\n**Tasks:** ' + (args.tasks ? args.tasks.length : 0) }],
      };
    });

    const mockScanProject = vi.fn(() =>
      Promise.resolve({
        content: [{ type: 'text', text: 'Project: 2 JS files, CommonJS, Express' }],
      })
    );

    initOrchestrator({
      auditStore,
      createWorkflow: mockCreateWorkflow,
      runWorkflow: vi.fn(),
      scanProject: mockScanProject,
    });

    initHandlers({
      auditStore,
      orchestrator: require('../audit/orchestrator'),
    });
  });

  afterEach(() => {
    teardownDb();
    if (projectDir && fs.existsSync(projectDir)) {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('dry_run returns inventory plan without creating DB records', async () => {
    const result = await handleAuditCodebase({
      path: projectDir,
      dry_run: true,
      source_dirs: ['src'],
    });

    expect(result.content).toBeDefined();
    expect(result.content[0].text).toContain('Dry Run');
    expect(result.content[0].text).toContain('2'); // total files

    // No audit run should exist in the DB
    const runs = auditStore.listAuditRuns({});
    expect(runs).toHaveLength(0);
  });

  it('full pipeline: audit start, aggregate, query, update, summary', async () => {
    // --- Step 1: Start audit ---
    const startResult = await handleAuditCodebase({
      path: projectDir,
      categories: ['security'],
      source_dirs: ['src'],
    });

    expect(startResult.content[0].text).toContain('Audit Started');
    expect(startResult.content[0].text).toContain('e2e00001-0000-0000-0000-000000000001');

    // Extract audit_run_id from the handler's text output
    const runIdMatch = startResult.content[0].text.match(/Run ID:\*\* ([a-f0-9-]+)/);
    expect(runIdMatch).toBeTruthy();
    const auditRunId = runIdMatch[1];

    // Verify DB state
    const run = auditStore.getAuditRun(auditRunId);
    expect(run).toBeTruthy();
    expect(run.status).toBe('running');
    expect(run.workflow_id).toBe('e2e00001-0000-0000-0000-000000000001');

    // Verify at least 1 workflow task was passed inline
    expect(capturedWorkflowTasks.length).toBeGreaterThanOrEqual(1);
    expect(capturedWorkflowTasks[0].node_id).toMatch(/^audit-unit-/);
    expect(capturedWorkflowTasks[0].tags).toContain('audit:' + auditRunId);

    // --- Step 2: Simulate LLM task completion (aggregator) ---
    const mockLlmOutput = JSON.stringify([
      {
        file_path: 'src/app.js',
        line_start: 6,
        line_end: 6,
        category: 'security',
        subcategory: 'injection.sql',
        severity: 'high',
        confidence: 'high',
        title: 'SQL Injection via string concatenation',
        description: 'User input is directly concatenated into SQL query without parameterization.',
        suggestion: 'Use parameterized queries instead of string concatenation.',
        snippet: 'const query = "SELECT * FROM users WHERE id = " + id;',
      },
      {
        file_path: 'src/app.js',
        line_start: 1,
        line_end: 1,
        category: 'security',
        subcategory: 'auth',
        severity: 'medium',
        confidence: 'medium',
        title: 'No authentication middleware',
        description: 'Route handler does not use authentication middleware.',
        suggestion: 'Add authentication middleware before route handlers.',
        snippet: 'app.get("/users", (req, res) => {',
      },
    ]);

    await processTaskResult(
      {
        taskId: 'e2e-task-001',
        output: mockLlmOutput,
        provider: 'codex',
        model: 'gpt-5.3-codex-spark',
        auditRunId,
        filePaths: ['src/app.js'],
      },
      auditStore
    );

    // --- Step 3: Query findings via handler ---
    const findingsResult = await handleGetAuditFindings({ audit_run_id: auditRunId });
    expect(findingsResult.content[0].text).toContain('SQL Injection');
    expect(findingsResult.content[0].text).toContain('No authentication middleware');

    // --- Step 4: Update a finding (mark as verified) ---
    const dbFindings = auditStore.getFindings({ audit_run_id: auditRunId });
    expect(dbFindings.findings.length).toBe(2);

    const sqlInjectionFinding = dbFindings.findings.find(
      (f) => f.subcategory === 'injection.sql'
    );
    expect(sqlInjectionFinding).toBeTruthy();

    const updateResult = await handleUpdateAuditFinding({
      finding_id: sqlInjectionFinding.id,
      verified: true,
    });
    expect(updateResult.content[0].text).toContain('updated');
    expect(updateResult.content[0].text).toContain('verified=true');

    // --- Step 5: Mark the other finding as false positive ---
    const authFinding = dbFindings.findings.find((f) => f.subcategory === 'auth');
    expect(authFinding).toBeTruthy();

    const fpResult = await handleUpdateAuditFinding({
      finding_id: authFinding.id,
      false_positive: true,
    });
    expect(fpResult.content[0].text).toContain('false_positive=true');

    // --- Step 6: Get audit summary ---
    const summaryResult = await handleGetAuditRunSummary({ audit_run_id: auditRunId });
    const summaryText = summaryResult.content[0].text;
    expect(summaryText).toContain('Audit Summary');
    expect(summaryText).toContain(auditRunId);

    // --- Step 7: List audit runs ---
    const listResult = await handleListAuditRuns({});
    expect(listResult.content[0].text).toContain(auditRunId.slice(0, 8));
  });

  it('aggregator handles unparseable output gracefully', async () => {
    const startResult = await handleAuditCodebase({
      path: projectDir,
      categories: ['security'],
      source_dirs: ['src'],
    });

    const runIdMatch = startResult.content[0].text.match(/Run ID:\*\* ([a-f0-9-]+)/);
    const auditRunId = runIdMatch[1];

    // Simulate LLM returning garbage
    await processTaskResult(
      {
        taskId: 'e2e-task-bad',
        output: 'This is not JSON at all, the LLM hallucinated.',
        provider: 'ollama',
        model: 'qwen2.5-coder:32b',
        auditRunId,
        filePaths: ['src/app.js'],
      },
      auditStore
    );

    // Should have incremented parse_failures but not crashed
    const run = auditStore.getAuditRun(auditRunId);
    expect(run.parse_failures).toBeGreaterThanOrEqual(1);

    // No findings should have been inserted from bad output
    const findings = auditStore.getFindings({ audit_run_id: auditRunId });
    expect(findings.findings).toHaveLength(0);
  });

  it('false positive learning: re-audit downgrades matching snippet confidence', async () => {
    // --- First audit: create a finding and mark it false positive ---
    const startResult1 = await handleAuditCodebase({
      path: projectDir,
      categories: ['security'],
      source_dirs: ['src'],
    });
    const runId1 = startResult1.content[0].text.match(/Run ID:\*\* ([a-f0-9-]+)/)[1];

    const snippet = 'const query = "SELECT * FROM users WHERE id = " + id;';
    await processTaskResult(
      {
        taskId: 'e2e-fp-task-1',
        output: JSON.stringify([
          {
            file_path: 'src/app.js',
            line_start: 6,
            line_end: 6,
            category: 'security',
            subcategory: 'injection.sql',
            severity: 'high',
            confidence: 'high',
            title: 'SQL Injection',
            description: 'Vulnerable',
            snippet,
          },
        ]),
        provider: 'codex',
        model: 'test',
        auditRunId: runId1,
        filePaths: ['src/app.js'],
      },
      auditStore
    );

    // Mark finding as false positive
    const findings1 = auditStore.getFindings({ audit_run_id: runId1 });
    expect(findings1.findings.length).toBe(1);
    auditStore.updateFinding(findings1.findings[0].id, { false_positive: true });

    // --- Second audit: same snippet should get confidence downgrade ---
    const startResult2 = await handleAuditCodebase({
      path: projectDir,
      categories: ['security'],
      source_dirs: ['src'],
    });
    const runId2 = startResult2.content[0].text.match(/Run ID:\*\* ([a-f0-9-]+)/)[1];

    await processTaskResult(
      {
        taskId: 'e2e-fp-task-2',
        output: JSON.stringify([
          {
            file_path: 'src/app.js',
            line_start: 6,
            line_end: 6,
            category: 'security',
            subcategory: 'injection.sql',
            severity: 'high',
            confidence: 'high',
            title: 'SQL Injection',
            description: 'Still flagged',
            snippet,
          },
        ]),
        provider: 'codex',
        model: 'test',
        auditRunId: runId2,
        filePaths: ['src/app.js'],
      },
      auditStore
    );

    // The second finding should have confidence downgraded to 'low'
    const findings2 = auditStore.getFindings({ audit_run_id: runId2 });
    expect(findings2.findings.length).toBe(1);
    expect(findings2.findings[0].confidence).toBe('low');
  });
});
