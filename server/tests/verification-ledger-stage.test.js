describe('verification-ledger-stage', () => {
  let stage;
  let mockLedger;
  let mockProjectConfig;

  beforeEach(() => {
    vi.resetModules();

    mockLedger = {
      insertChecks: vi.fn(),
    };

    mockProjectConfig = {
      getProjectConfig: vi.fn().mockReturnValue({ verification_ledger: true }),
    };

    const { createVerificationLedgerStage } = require('../execution/verification-ledger-stage');
    stage = createVerificationLedgerStage({ verificationLedger: mockLedger, projectConfigCore: mockProjectConfig });
  });

  it('converts validationStages into ledger checks', async () => {
    const ctx = {
      taskId: 'task-1',
      task: { workflow_id: 'wf-1', working_directory: '/project', metadata: '{}' },
      status: 'completed',
      code: 0,
      validationStages: {
        safeguard_checks: { outcome: 'no_change', duration_ms: 50 },
        auto_verify_retry: { outcome: 'no_change', duration_ms: 1200 },
      },
      filesModified: ['src/app.js'],
    };

    await stage(ctx);

    expect(mockLedger.insertChecks).toHaveBeenCalledTimes(1);
    const checks = mockLedger.insertChecks.mock.calls[0][0];
    expect(checks).toHaveLength(2);
    expect(checks.every(c => c.task_id === 'task-1')).toBe(true);
    expect(checks.every(c => c.phase === 'after')).toBe(true);
    expect(checks[0]).toMatchObject({ check_name: 'safeguard_checks', passed: 1 });
    expect(checks[1]).toMatchObject({ check_name: 'auto_verify_retry', passed: 1 });
  });

  it('maps error outcomes to passed=0', async () => {
    const ctx = {
      taskId: 'task-1',
      task: { working_directory: '/project', metadata: '{}' },
      status: 'failed',
      code: 1,
      validationStages: {
        safeguard_checks: { outcome: 'error', error: 'File truncation detected', duration_ms: 30 },
      },
      filesModified: [],
    };

    await stage(ctx);

    const checks = mockLedger.insertChecks.mock.calls[0][0];
    const safeguard = checks.find(c => c.check_name === 'safeguard_checks');
    expect(safeguard.passed).toBe(0);
    expect(safeguard.output_snippet).toContain('File truncation');
  });

  it('no-ops when verification_ledger is disabled in project config', async () => {
    mockProjectConfig.getProjectConfig.mockReturnValue({ verification_ledger: false });

    const ctx = {
      taskId: 'task-1',
      task: { working_directory: '/project', metadata: '{}' },
      status: 'completed',
      code: 0,
      validationStages: { safeguard_checks: { outcome: 'no_change' } },
      filesModified: [],
    };

    await stage(ctx);

    expect(mockLedger.insertChecks).not.toHaveBeenCalled();
  });

  it('no-ops when per-task metadata disables ledger', async () => {
    const ctx = {
      taskId: 'task-1',
      task: { working_directory: '/project', metadata: JSON.stringify({ verification_ledger: false }) },
      status: 'completed',
      code: 0,
      validationStages: { safeguard_checks: { outcome: 'no_change' } },
      filesModified: [],
    };

    await stage(ctx);

    expect(mockLedger.insertChecks).not.toHaveBeenCalled();
  });

  it('records verify_command result from metadata when available', async () => {
    const ctx = {
      taskId: 'task-1',
      task: {
        working_directory: '/project',
        metadata: JSON.stringify({
          finalization: {
            verify_command_result: {
              command: 'npx tsc --noEmit',
              exit_code: 0,
              output: 'Build succeeded',
              duration: 2500,
            },
          },
        }),
      },
      status: 'completed',
      code: 0,
      validationStages: {},
      filesModified: [],
    };

    await stage(ctx);

    const checks = mockLedger.insertChecks.mock.calls[0][0];
    const verify = checks.find(c => c.check_name === 'verify_command');
    expect(verify).toBeTruthy();
    expect(verify.command).toBe('npx tsc --noEmit');
    expect(verify.exit_code).toBe(0);
    expect(verify.output).toBe('Build succeeded');
    expect(verify.duration).toBe(2500);
    expect(verify.passed).toBe(1);
  });

  it('never mutates ctx.status or ctx.earlyExit', async () => {
    const ctx = {
      taskId: 'task-1',
      task: { working_directory: '/project', metadata: '{}' },
      status: 'completed',
      code: 0,
      earlyExit: false,
      validationStages: { safeguard_checks: { outcome: 'error' } },
      filesModified: [],
    };

    await stage(ctx);

    expect(ctx.status).toBe('completed');
    expect(ctx.earlyExit).toBe(false);
  });
});
