'use strict';

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const SUBJECT_MODULE = '../policy-engine/adapters/command';
const COMMAND_POLICY_MODULE = '../execution/command-policy';
const subjectPath = require.resolve(SUBJECT_MODULE);
const commandPolicyPath = require.resolve(COMMAND_POLICY_MODULE);

function loadSubject(validationResult) {
  const validateImpl = typeof validationResult === 'function'
    ? validationResult
    : () => validationResult || { allowed: true };
  const validateCommand = vi.fn(validateImpl);

  delete require.cache[subjectPath];
  delete require.cache[commandPolicyPath];
  installMock(COMMAND_POLICY_MODULE, { validateCommand });

  return {
    validateCommand,
    ...require(SUBJECT_MODULE),
  };
}

function unavailable(reason) {
  return {
    type: 'command_profile_valid',
    available: false,
    satisfied: null,
    value: { reason },
  };
}

afterEach(() => {
  delete require.cache[subjectPath];
  delete require.cache[commandPolicyPath];
  vi.clearAllMocks();
});

describe('policy-engine/adapters/command', () => {
  [
    ['missing command', { profile: 'safe_verify' }],
    ['blank string command', { command: '   ', profile: 'safe_verify' }],
    ['array command', { command: ['npm', 'test'], profile: 'safe_verify' }],
    ['object without command keys', { command: { value: 'npm' }, profile: 'safe_verify' }],
    ['object with blank cmd', { command: { cmd: '   ' }, profile: 'safe_verify' }],
  ].forEach(([label, context]) => {
    it(`returns unavailable evidence for ${label}`, () => {
      const { collectCommandPolicyEvidence, validateCommand } = loadSubject();

      expect(collectCommandPolicyEvidence(context)).toEqual(
        unavailable('command is unavailable'),
      );
      expect(validateCommand).not.toHaveBeenCalled();
    });
  });

  it('does not fall back to task.command when the first defined command is blank', () => {
    const { collectCommandPolicyEvidence, validateCommand } = loadSubject();

    const evidence = collectCommandPolicyEvidence({
      command: '   ',
      task: {
        command: 'npm',
        profile: 'build',
      },
      profile: 'safe_verify',
    });

    expect(evidence).toEqual(unavailable('command is unavailable'));
    expect(validateCommand).not.toHaveBeenCalled();
  });

  it('returns unavailable evidence when the profile is missing', () => {
    const { collectCommandPolicyEvidence, validateCommand } = loadSubject();

    expect(collectCommandPolicyEvidence({ command: 'npm' })).toEqual(
      unavailable('command profile is unavailable'),
    );
    expect(validateCommand).not.toHaveBeenCalled();
  });

  it('does not fall back to task.profile when the first defined profile is blank', () => {
    const { collectCommandPolicyEvidence, validateCommand } = loadSubject();

    const evidence = collectCommandPolicyEvidence({
      command: 'npm',
      profile: '   ',
      task: {
        profile: 'build',
      },
    });

    expect(evidence).toEqual(unavailable('command profile is unavailable'));
    expect(validateCommand).not.toHaveBeenCalled();
  });

  it('passes direct string commands to validateCommand with default metadata and missing args', () => {
    const { collectCommandPolicyEvidence, validateCommand } = loadSubject({
      allowed: true,
    });

    const evidence = collectCommandPolicyEvidence({
      command: 'npx',
      profile: '  safe_verify  ',
    });

    expect(validateCommand).toHaveBeenCalledOnce();
    expect(validateCommand).toHaveBeenCalledWith(
      'npx',
      undefined,
      'safe_verify',
      {
        dangerous: false,
        source: 'policy-engine.command-adapter',
        caller: 'collectCommandPolicyEvidence',
      },
    );
    expect(evidence).toEqual({
      type: 'command_profile_valid',
      available: true,
      satisfied: true,
      value: { reason: undefined },
    });
  });

  it('uses top-level aliases and explicit metadata when validating commands', () => {
    const { collectCommandPolicyEvidence, validateCommand } = loadSubject({
      allowed: false,
      reason: 'blocked by test policy',
    });

    const evidence = collectCommandPolicyEvidence({
      cmd: 'git',
      commandArgs: ['status', '--short'],
      command_profile: ' build ',
      dangerous: true,
      source: 'policy-test',
      caller: 'top-level-alias',
    });

    expect(validateCommand).toHaveBeenCalledOnce();
    expect(validateCommand).toHaveBeenCalledWith(
      'git',
      ['status', '--short'],
      'build',
      {
        dangerous: true,
        source: 'policy-test',
        caller: 'top-level-alias',
      },
    );
    expect(evidence).toEqual({
      type: 'command_profile_valid',
      available: true,
      satisfied: false,
      value: { reason: 'blocked by test policy' },
    });
  });

  it('uses nested task command objects and task aliases when top-level fields are absent', () => {
    const command = { command: 'node' };
    const { collectCommandPolicyEvidence, validateCommand } = loadSubject({
      allowed: false,
      reason: 'task command rejected',
    });

    const evidence = collectCommandPolicyEvidence({
      task: {
        command,
        command_args: ['--check', 'server/index.js'],
        commandProfile: ' safe_verify ',
        dangerous: 'yes',
        source: 'queue-worker',
        caller: 'task-runner',
      },
    });

    expect(validateCommand).toHaveBeenCalledOnce();
    expect(validateCommand).toHaveBeenCalledWith(
      command,
      ['--check', 'server/index.js'],
      'safe_verify',
      {
        dangerous: false,
        source: 'queue-worker',
        caller: 'task-runner',
      },
    );
    expect(evidence).toEqual({
      type: 'command_profile_valid',
      available: true,
      satisfied: false,
      value: { reason: 'task command rejected' },
    });
  });
});
