'use strict';

const {
  init,
  handleAuditCodebase,
  handleListAuditRuns,
  handleGetAuditFindings,
  handleUpdateAuditFinding,
  handleGetAuditRunSummary,
} = require('../handlers/audit-handlers');

describe('audit handlers', () => {
  let mockStore;
  let mockOrchestrator;

  beforeEach(() => {
    mockStore = {
      listAuditRuns: vi.fn(() => []),
      getFindings: vi.fn(() => ({ findings: [], total: 0 })),
      updateFinding: vi.fn(() => 1),
      getAuditSummary: vi.fn(() => ({
        run_id: 'run-1',
        status: 'completed',
        total_files: 5,
        total_findings: 3,
        parse_failures: 0,
        by_severity: { high: 1, medium: 2 },
        by_category: { security: 2, performance: 1 },
      })),
    };

    mockOrchestrator = {
      runAudit: vi.fn(() => Promise.resolve({
        audit_run_id: 'run-1',
        workflow_id: 'wf-1',
        total_files: 5,
        task_count: 2,
        categories: ['security'],
        estimated_duration: 7,
        status: 'running',
      })),
    };

    init({ auditStore: mockStore, orchestrator: mockOrchestrator });
  });

  it('handleAuditCodebase returns error when path is missing', async () => {
    const result = await handleAuditCodebase({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('path is required');
  });

  it('handleAuditCodebase calls orchestrator.runAudit and returns markdown', async () => {
    const result = await handleAuditCodebase({ path: '/tmp/project' });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('run-1');
    expect(result.content[0].text).toContain('Audit Started');
    expect(mockOrchestrator.runAudit).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/tmp/project' }),
    );
  });

  it('handleAuditCodebase handles dry_run response', async () => {
    mockOrchestrator.runAudit.mockResolvedValue({
      dry_run: true,
      total_files: 10,
      task_count: 3,
      files_by_tier: { small: 7, medium: 2, large: 1 },
      categories: ['security', 'performance'],
      estimated_duration: 12,
    });

    const result = await handleAuditCodebase({ path: '/tmp/project', dry_run: true });
    expect(result.content[0].text).toContain('Audit Dry Run');
    expect(result.content[0].text).toContain('10');
  });

  it('handleAuditCodebase returns error when orchestrator returns error', async () => {
    mockOrchestrator.runAudit.mockResolvedValue({ error: 'No files found' });
    const result = await handleAuditCodebase({ path: '/tmp/empty' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No files found');
  });

  it('handleListAuditRuns returns formatted table', async () => {
    mockStore.listAuditRuns.mockReturnValue([
      { id: 'abc12345-full-id', status: 'completed', total_files: 10, total_findings: 5, created_at: '2026-03-13T12:00:00Z' },
    ]);

    const result = await handleListAuditRuns({});
    expect(result.content[0].text).toContain('abc12345');
    expect(result.content[0].text).toContain('completed');
  });

  it('handleListAuditRuns returns message when no runs exist', async () => {
    const result = await handleListAuditRuns({});
    expect(result.content[0].text).toContain('No audit runs found');
  });

  it('handleGetAuditFindings returns error when audit_run_id missing', async () => {
    const result = await handleGetAuditFindings({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('audit_run_id is required');
  });

  it('handleGetAuditFindings passes filters to store', async () => {
    mockStore.getFindings.mockReturnValue({
      findings: [
        { title: 'SQL Injection', category: 'security', subcategory: 'injection.sql', severity: 'high', confidence: 'high', file_path: 'src/db.js', line_start: 10, line_end: 15, description: 'Unsafe query', suggestion: 'Use parameterized queries' },
      ],
      total: 1,
    });

    const result = await handleGetAuditFindings({ audit_run_id: 'run-1', category: 'security' });
    expect(result.content[0].text).toContain('SQL Injection');
    expect(mockStore.getFindings).toHaveBeenCalledWith(
      expect.objectContaining({ audit_run_id: 'run-1', category: 'security' }),
    );
  });

  it('handleUpdateAuditFinding returns error when finding_id missing', async () => {
    const result = await handleUpdateAuditFinding({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('finding_id is required');
  });

  it('handleUpdateAuditFinding updates and confirms', async () => {
    const result = await handleUpdateAuditFinding({ finding_id: 'f-1', verified: true });
    expect(result.content[0].text).toContain('f-1');
    expect(result.content[0].text).toContain('verified=true');
    expect(mockStore.updateFinding).toHaveBeenCalledWith('f-1', { verified: true });
  });

  it('handleUpdateAuditFinding returns not found when store returns 0', async () => {
    mockStore.updateFinding.mockReturnValue(0);
    const result = await handleUpdateAuditFinding({ finding_id: 'missing', verified: true });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('handleGetAuditRunSummary returns error when audit_run_id missing', async () => {
    const result = await handleGetAuditRunSummary({});
    expect(result.isError).toBe(true);
  });

  it('handleGetAuditRunSummary returns formatted summary', async () => {
    const result = await handleGetAuditRunSummary({ audit_run_id: 'run-1' });
    expect(result.content[0].text).toContain('Audit Summary');
    expect(result.content[0].text).toContain('run-1');
    expect(result.content[0].text).toContain('high: 1');
    expect(result.content[0].text).toContain('security: 2');
  });

  it('handleGetAuditRunSummary returns not found for missing run', async () => {
    mockStore.getAuditSummary.mockReturnValue(null);
    const result = await handleGetAuditRunSummary({ audit_run_id: 'missing' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });
});
