'use strict'

const Database = require('better-sqlite3')
const store = require('../db/audit-store.js')

let db

beforeAll(() => {
  db = new Database(':memory:')

  db.exec(`
    CREATE TABLE audit_runs (
      id TEXT PRIMARY KEY NOT NULL,
      project_path TEXT NOT NULL,
      categories TEXT NOT NULL,
      provider TEXT,
      workflow_id TEXT,
      status TEXT DEFAULT 'pending',
      total_files INTEGER DEFAULT 0,
      files_scanned INTEGER DEFAULT 0,
      files_skipped INTEGER DEFAULT 0,
      total_findings INTEGER DEFAULT 0,
      parse_failures INTEGER DEFAULT 0,
      error TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE audit_findings (
      id TEXT PRIMARY KEY NOT NULL,
      audit_run_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      line_start INTEGER,
      line_end INTEGER,
      category TEXT,
      subcategory TEXT,
      severity INTEGER,
      confidence INTEGER,
      title TEXT,
      description TEXT,
      suggestion TEXT,
      snippet TEXT,
      snippet_hash TEXT,
      provider TEXT,
      model TEXT,
      task_id TEXT,
      verified INTEGER DEFAULT 0,
      false_positive INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(audit_run_id) REFERENCES audit_runs(id)
    );
  `)

  store.setDb(db)
})

afterAll(() => {
  db.close()
})

describe('audit-store', () => {
  it('createAuditRun creates run and getAuditRun retrieves it', () => {
    const runId = store.createAuditRun({
      project_path: '/tmp/project-alpha',
      categories: ['security', 'lint'],
      provider: 'mock-provider',
      workflow_id: 'wf-alpha'
    })

    const run = store.getAuditRun(runId)

    expect(run.id).toBe(runId)
    expect(run.project_path).toBe('/tmp/project-alpha')
    expect(run.categories).toBe(JSON.stringify(['security', 'lint']))
    expect(run.provider).toBe('mock-provider')
    expect(run.workflow_id).toBe('wf-alpha')
    expect(run.status).toBe('pending')
  })

  it('updateAuditRun updates status and counts', () => {
    const runId = store.createAuditRun({
      project_path: '/tmp/project-update',
      categories: ['security'],
      provider: 'mock-provider',
      workflow_id: 'wf-update'
    })

    const changed = store.updateAuditRun(runId, {
      status: 'running',
      total_files: 12,
      files_scanned: 7,
      total_findings: 3
    })
    const run = store.getAuditRun(runId)

    expect(changed).toBe(1)
    expect(run.status).toBe('running')
    expect(run.total_files).toBe(12)
    expect(run.files_scanned).toBe(7)
    expect(run.total_findings).toBe(3)
  })

  it('listAuditRuns filters by project_path and respects limit', () => {
    store.createAuditRun({
      project_path: '/tmp/project-list',
      categories: ['security'],
      provider: 'mock-provider',
      workflow_id: 'wf-list-a'
    })
    store.createAuditRun({
      project_path: '/tmp/project-list',
      categories: ['security'],
      provider: 'mock-provider',
      workflow_id: 'wf-list-b'
    })
    store.createAuditRun({
      project_path: '/tmp/project-list-b',
      categories: ['security'],
      provider: 'mock-provider',
      workflow_id: 'wf-list-c'
    })

    const filtered = store.listAuditRuns({ project_path: '/tmp/project-list', limit: 1 })

    expect(filtered).toHaveLength(1)
    expect(filtered[0].project_path).toBe('/tmp/project-list')
  })

  it('insertFindings inserts multiple findings and getFindings filters and paginates', () => {
    const runId = store.createAuditRun({
      project_path: '/tmp/project-findings',
      categories: ['quality'],
      provider: 'mock-provider',
      workflow_id: 'wf-findings'
    })

    const insertedFindingIds = store.insertFindings([
      {
        audit_run_id: runId,
        file_path: '/src/app/index.js',
        line_start: 1,
        line_end: 8,
        category: 'quality',
        subcategory: 'style',
        severity: 2,
        confidence: 90,
        title: 'Spacing issue',
        description: 'Unexpected spacing',
        suggestion: 'Run formatter',
        snippet: 'code sample',
        snippet_hash: 'hash1',
        provider: 'mock-provider',
        model: 'mock-model',
        task_id: 'task-quality'
      },
      {
        audit_run_id: runId,
        file_path: '/src/lib/auth.js',
        line_start: 2,
        line_end: 14,
        category: 'security',
        subcategory: 'auth',
        severity: 1,
        confidence: 88,
        title: 'Weak auth',
        description: 'Potential insecure auth path',
        suggestion: 'Use token validation',
        snippet: 'auth snippet',
        snippet_hash: 'hash2',
        provider: 'mock-provider',
        model: 'mock-model',
        task_id: 'task-security'
      }
    ])

    const allFindings = store.getFindings({ audit_run_id: runId })
    expect(insertedFindingIds).toHaveLength(2)
    expect(allFindings.total).toBe(2)
    expect(allFindings.findings).toHaveLength(2)

    const securityFindings = store.getFindings({ audit_run_id: runId, category: 'security' })
    expect(securityFindings.total).toBe(1)
    expect(securityFindings.findings[0].category).toBe('security')

    const severityFindings = store.getFindings({ audit_run_id: runId, severity: 1 })
    expect(severityFindings.total).toBe(1)
    expect(severityFindings.findings[0].severity).toBe(1)

    const pageOne = store.getFindings({ audit_run_id: runId, limit: 1, offset: 0 })
    const pageTwo = store.getFindings({ audit_run_id: runId, limit: 1, offset: 1 })
    expect(pageOne.total).toBe(2)
    expect(pageTwo.total).toBe(2)
    expect(pageOne.findings).toHaveLength(1)
    expect(pageTwo.findings).toHaveLength(1)
    expect(pageOne.findings[0].id).not.toBe(pageTwo.findings[0].id)
  })

  it('updateFinding marks verified and false_positive flags', () => {
    const runId = store.createAuditRun({
      project_path: '/tmp/project-update-finding',
      categories: ['security'],
      provider: 'mock-provider',
      workflow_id: 'wf-finding-update'
    })
    const [findingId] = store.insertFindings([
      {
        audit_run_id: runId,
        file_path: '/src/update.js',
        line_start: 10,
        line_end: 20,
        category: 'security',
        subcategory: 'access',
        severity: 4,
        confidence: 79,
        title: 'Critical check',
        description: 'Needs update',
        suggestion: 'Patch now',
        snippet: 'v1',
        snippet_hash: 'hash3',
        provider: 'mock-provider',
        model: 'mock-model',
        task_id: 'task-update'
      }
    ])

    const updatedFinding = store.updateFinding(findingId, {
      verified: true,
      false_positive: true
    })

    expect(updatedFinding).not.toBeNull()
    expect(updatedFinding.id).toBe(findingId)
    expect(updatedFinding.verified).toBe(1)
    expect(updatedFinding.false_positive).toBe(1)
  })

  it('getFindings escapes LIKE metacharacters in file_path filters', () => {
    const runId = store.createAuditRun({
      project_path: '/tmp/project-like-filter',
      categories: ['quality'],
      provider: 'mock-provider',
      workflow_id: 'wf-like-filter'
    })
    const literalMarker = `literal-${Date.now()}`
    const [literalFindingId] = store.insertFindings([
      {
        audit_run_id: runId,
        file_path: `/src/${literalMarker}-%_.js`,
        line_start: 1,
        line_end: 1,
        category: 'quality',
        severity: 2,
        confidence: 80,
        title: 'Literal marker finding'
      },
      {
        audit_run_id: runId,
        file_path: `/src/${literalMarker}-ab.js`,
        line_start: 2,
        line_end: 2,
        category: 'quality',
        severity: 2,
        confidence: 80,
        title: 'Wildcard false positive candidate'
      }
    ])

    const results = store.getFindings({
      audit_run_id: runId,
      file_path: `${literalMarker}-%_`
    })

    expect(results.total).toBe(1)
    expect(results.findings).toHaveLength(1)
    expect(results.findings[0].id).toBe(literalFindingId)
  })

  it('getAuditSummary returns aggregated counts', () => {
    const runId = store.createAuditRun({
      project_path: '/tmp/project-summary',
      categories: ['quality', 'security'],
      provider: 'mock-provider',
      workflow_id: 'wf-summary'
    })

    const findingIds = store.insertFindings([
      {
        audit_run_id: runId,
        file_path: '/src/summary/a.js',
        line_start: 1,
        line_end: 3,
        category: 'security',
        subcategory: 'xss',
        severity: 1,
        confidence: 95,
        title: 'XSS vector',
        description: 'Potential XSS',
        suggestion: 'Sanitize output',
        snippet: 'xss',
        snippet_hash: 'hash4',
        provider: 'mock-provider',
        model: 'mock-model',
        task_id: 'task-summary-1'
      },
      {
        audit_run_id: runId,
        file_path: '/src/summary/a.js',
        line_start: 10,
        line_end: 20,
        category: 'security',
        subcategory: 'auth',
        severity: 2,
        confidence: 85,
        title: 'Auth issue',
        description: 'Weak token',
        suggestion: 'Regenerate',
        snippet: 'token',
        snippet_hash: 'hash5',
        provider: 'mock-provider',
        model: 'mock-model',
        task_id: 'task-summary-2'
      },
      {
        audit_run_id: runId,
        file_path: '/src/summary/b.js',
        line_start: 40,
        line_end: 48,
        category: 'quality',
        subcategory: 'complexity',
        severity: 1,
        confidence: 85,
        title: 'Complex routine',
        description: 'Refactor',
        suggestion: 'Split function',
        snippet: 'complex',
        snippet_hash: 'hash6',
        provider: 'mock-provider',
        model: 'mock-model',
        task_id: 'task-summary-3'
      }
    ])

    store.updateFinding(findingIds[0], { verified: true })

    const summary = store.getAuditSummary(runId)
    expect(summary.total).toBe(3)
    expect(summary.verified).toBe(1)
    expect(summary.unverified).toBe(2)
    expect(summary.by_category).toEqual({ security: 2, quality: 1 })
    expect(summary.by_severity).toEqual({ 1: 2, 2: 1 })
    expect(summary.by_confidence).toEqual({ 95: 1, 85: 2 })
    expect(summary.file_hotspots).toHaveLength(2)
    expect(summary.file_hotspots[0]).toEqual({ file_path: '/src/summary/a.js', count: 2 })
  })

  it('getFalsePositives returns past false positives for a project', () => {
    const projectPath = '/tmp/project-false-positives'
    const runOne = store.createAuditRun({
      project_path: projectPath,
      categories: ['security'],
      provider: 'mock-provider',
      workflow_id: 'wf-fp-1'
    })
    const runTwo = store.createAuditRun({
      project_path: '/tmp/project-other',
      categories: ['security'],
      provider: 'mock-provider',
      workflow_id: 'wf-fp-2'
    })

    const idsRunOne = store.insertFindings([
      {
        audit_run_id: runOne,
        file_path: '/src/fp/a.js',
        line_start: 4,
        line_end: 8,
        category: 'security',
        subcategory: 'headers',
        severity: 2,
        confidence: 77,
        title: 'Header',
        description: 'Insecure header',
        suggestion: 'Add header',
        snippet: 'header',
        snippet_hash: 'hash7',
        provider: 'mock-provider',
        model: 'mock-model',
        task_id: 'task-fp-1'
      },
      {
        audit_run_id: runOne,
        file_path: '/src/fp/b.js',
        line_start: 1,
        line_end: 5,
        category: 'security',
        subcategory: 'headers',
        severity: 3,
        confidence: 77,
        title: 'Header',
        description: 'Another issue',
        suggestion: 'Add header',
        snippet: 'header',
        snippet_hash: 'hash8',
        provider: 'mock-provider',
        model: 'mock-model',
        task_id: 'task-fp-2'
      }
    ])

    store.insertFindings([
      {
        audit_run_id: runTwo,
        file_path: '/src/fp/c.js',
        line_start: 2,
        line_end: 7,
        category: 'security',
        subcategory: 'headers',
        severity: 1,
        confidence: 60,
        title: 'Header',
        description: 'Noisy finding',
        suggestion: 'Ignore',
        snippet: 'header',
        snippet_hash: 'hash9',
        provider: 'mock-provider',
        model: 'mock-model',
        task_id: 'task-fp-3'
      }
    ])

    store.updateFinding(idsRunOne[0], { false_positive: true })
    store.updateFinding(idsRunOne[1], { false_positive: false })

    const falsePositives = store.getFalsePositives(projectPath)

    expect(falsePositives).toHaveLength(1)
    expect(falsePositives[0].audit_run_id).toBe(runOne)
    expect(falsePositives[0].false_positive).toBe(1)
    expect(falsePositives[0].file_path).toBe('/src/fp/a.js')
  })
})
