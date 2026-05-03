import { describe, it, expect } from 'vitest';
import path from 'node:path';

const {
  buildProviderStartupEnv,
  evaluateFactoryWorktreeHeavyValidationGuard,
} = require('../execution/task-startup');

describe('buildProviderStartupEnv — native codex PATH augmentation', () => {
  const baseArgs = {
    taskId: 'task-1',
    task: { workflow_id: 'wf-1', workflow_node_id: 'node-1' },
    taskMetadata: {},
    runDir: '/tmp/runs/task-1',
  };

  it('prepends the vendor path/ dir to PATH when nativeCodex is provided', () => {
    const env = { PATH: '/usr/local/bin:/usr/bin' };
    const vendorPath = '/fake/vendor/x86_64-pc-windows-msvc/path';
    const result = buildProviderStartupEnv({
      ...baseArgs,
      env,
      nvmNodePath: null,
      nativeCodex: {
        pathPrepend: vendorPath,
        envAdditions: { CODEX_MANAGED_BY_NPM: '1' },
      },
    });

    const parts = result.PATH.split(path.delimiter);
    expect(parts[0]).toBe(vendorPath);
    expect(result.PATH).toContain('/usr/local/bin');
    expect(result.CODEX_MANAGED_BY_NPM).toBe('1');
  });

  it('does not prepend the vendor path dir when it is already on PATH', () => {
    const vendorPath = '/fake/vendor/path';
    const env = { PATH: `/usr/local/bin${path.delimiter}${vendorPath}${path.delimiter}/usr/bin` };
    const result = buildProviderStartupEnv({
      ...baseArgs,
      env,
      nvmNodePath: null,
      nativeCodex: {
        pathPrepend: vendorPath,
        envAdditions: {},
      },
    });

    const firstHits = result.PATH.split(path.delimiter).filter(p => p === vendorPath);
    expect(firstHits.length).toBe(1); // no duplication
    expect(result.PATH.startsWith('/usr/local/bin')).toBe(true);
  });

  it('does not touch PATH when nativeCodex is null (fallback behavior)', () => {
    const env = { PATH: '/usr/bin:/bin' };
    const result = buildProviderStartupEnv({
      ...baseArgs,
      env,
      nvmNodePath: null,
      nativeCodex: null,
    });

    expect(result.PATH).toBe('/usr/bin:/bin');
    expect(result.CODEX_MANAGED_BY_NPM).toBeUndefined();
  });

  it('applies envAdditions even when pathPrepend is null', () => {
    const env = { PATH: '/bin' };
    const result = buildProviderStartupEnv({
      ...baseArgs,
      env,
      nvmNodePath: null,
      nativeCodex: {
        pathPrepend: null,
        envAdditions: { CODEX_MANAGED_BY_NPM: '1' },
      },
    });

    expect(result.PATH).toBe('/bin');
    expect(result.CODEX_MANAGED_BY_NPM).toBe('1');
  });

  it('combines nvmNodePath prepend and nativeCodex prepend correctly', () => {
    const nvmPath = '/home/user/.nvm/versions/node/v20/bin';
    const vendorPath = '/codex/vendor/path';
    const env = { PATH: '/usr/bin' };
    const result = buildProviderStartupEnv({
      ...baseArgs,
      env,
      nvmNodePath: nvmPath,
      nativeCodex: {
        pathPrepend: vendorPath,
        envAdditions: {},
      },
    });

    const parts = result.PATH.split(path.delimiter);
    // vendor goes FIRST (prepended last), then nvm, then the original PATH
    expect(parts[0]).toBe(vendorPath);
    expect(parts[1]).toBe(nvmPath);
    expect(parts[2]).toBe('/usr/bin');
  });
});

describe('evaluateFactoryWorktreeHeavyValidationGuard', () => {
  it('blocks heavy local .NET validation for codex tasks in factory worktrees', () => {
    const result = evaluateFactoryWorktreeHeavyValidationGuard({
      task_description: 'Update the evidence doc, then run dotnet test SpudgetBooks.sln --no-build.',
      working_directory: 'C:\\Users\\FactoryUser\\Projects\\SpudgetBooks\\.worktrees\\fea-1234',
    }, 'codex');

    expect(result).toMatchObject({
      blocked: true,
      detected_command: 'Update the evidence doc, then run dotnet test SpudgetBooks.sln --no-build.',
    });
    expect(result.message).toContain('torque-remote');
  });

  it('allows torque-remote validation commands in factory worktrees', () => {
    const result = evaluateFactoryWorktreeHeavyValidationGuard({
      task_description: 'Run torque-remote dotnet test tests/SpudgetBooks.App.Tests/SpudgetBooks.App.Tests.csproj before shipping.',
      working_directory: 'C:\\Users\\FactoryUser\\Projects\\SpudgetBooks\\.worktrees\\fea-1234',
    }, 'codex');

    expect(result).toBeNull();
  });

  it('ignores heavy validation commands outside factory worktrees', () => {
    const result = evaluateFactoryWorktreeHeavyValidationGuard({
      task_description: 'Run dotnet test SpudgetBooks.sln --no-build before shipping.',
      working_directory: 'C:\\Users\\FactoryUser\\Projects\\SpudgetBooks',
    }, 'codex');

    expect(result).toBeNull();
  });

  it('exempts verify_review tasks even when the description names dotnet test', () => {
    // Verify_review prompts contain the failed verify command as
    // context ("the verify_command was `dotnet test ...`"), not as an
    // instruction. The reviewer emits a JSON verdict, no shell.
    // Observed live 2026-04-25/26: 9 codex verify_review tasks failed
    // because the rule triggered on prompt text rather than execution.
    const result = evaluateFactoryWorktreeHeavyValidationGuard({
      task_description: 'You are a quality reviewer. Verification: dotnet test simtests/SimCore.DotNet.Tests.csproj -c Release returned exit code 1...',
      working_directory: 'C:\\Users\\FactoryUser\\Projects\\SimCore\\.worktrees\\fea-1234',
      metadata: { kind: 'verify_review', factory_internal: true },
    }, 'codex');

    expect(result).toBeNull();
  });

  it('exempts plan_generation tasks naming dotnet test in their context', () => {
    const result = evaluateFactoryWorktreeHeavyValidationGuard({
      task_description: 'Generate a plan for fixing the failing telemetry tests. Verify command: dotnet test ...',
      working_directory: 'C:\\Users\\FactoryUser\\Projects\\SimCore\\.worktrees\\fea-1234',
      metadata: { kind: 'plan_generation', factory_internal: true },
    }, 'codex');

    expect(result).toBeNull();
  });

  it('exempts diffusion compute tasks even when description includes heavy commands', () => {
    const result = evaluateFactoryWorktreeHeavyValidationGuard({
      task_description: 'Compute file_edits for: run dotnet test before shipping...',
      working_directory: 'C:\\Users\\FactoryUser\\Projects\\SimCore\\.worktrees\\fea-1234',
      metadata: { diffusion_role: 'compute' },
    }, 'codex');

    expect(result).toBeNull();
  });

  it('still blocks an EXECUTE task that names dotnet test even when factory_internal=true', () => {
    // factory_internal alone is not a free pass — the kind has to be one
    // of the structured-output kinds (or the diffusion compute role).
    // EXECUTE tasks in the factory pipeline are normal code-writing
    // tasks and SHOULD be steered to torque-remote.
    const result = evaluateFactoryWorktreeHeavyValidationGuard({
      task_description: 'Implement the feature. Verify with: dotnet test SpudgetBooks.sln --no-build.',
      working_directory: 'C:\\Users\\FactoryUser\\Projects\\SpudgetBooks\\.worktrees\\fea-1234',
      metadata: { kind: 'execute', factory_internal: true },
    }, 'codex');

    expect(result).toMatchObject({ blocked: true });
  });

  it('ignores heavy command names that only appear inside verify output diagnostics', () => {
    const result = evaluateFactoryWorktreeHeavyValidationGuard({
      task_description: [
        'You are retrying a failed verify task. Review this output and fix the failing behavior.',
        '',
        'Verify output (tail):',
        '```',
        'server/tests/factory-scorers-behavioral.test.js > fallback heuristic',
        'passes: counts dotnet test projects and C# test files in the fallback heuristic 4ms',
        '```',
      ].join('\n'),
      working_directory: 'C:\\Users\\FactoryUser\\Projects\\torque-public\\.worktrees\\fea-1234',
      metadata: { kind: 'execute', factory_internal: true },
    }, 'codex');

    expect(result).toBeNull();
  });

  it('parses metadata when stored as a JSON string (db round-trip shape)', () => {
    const result = evaluateFactoryWorktreeHeavyValidationGuard({
      task_description: 'You are a quality reviewer. Verification: dotnet test ...',
      working_directory: 'C:\\Users\\FactoryUser\\Projects\\SimCore\\.worktrees\\fea-1234',
      metadata: JSON.stringify({ kind: 'verify_review', factory_internal: true }),
    }, 'codex');

    expect(result).toBeNull();
  });
});
