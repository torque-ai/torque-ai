'use strict';

const { validateCommand } = require('../../execution/command-policy');

const EVIDENCE_TYPE = 'command_profile_valid';

function pickFirstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

function isPresentString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasCommandValue(command) {
  if (isPresentString(command)) {
    return true;
  }

  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    return false;
  }

  return isPresentString(command.cmd) || isPresentString(command.command);
}

function resolveCommandContext(context = {}) {
  const task = context.task && typeof context.task === 'object' ? context.task : {};

  return {
    command: pickFirstDefined(
      context.command,
      context.cmd,
      task.command,
      task.cmd,
    ),
    args: pickFirstDefined(
      context.args,
      context.command_args,
      context.commandArgs,
      task.args,
      task.command_args,
      task.commandArgs,
    ),
    profile: pickFirstDefined(
      context.profile,
      context.command_profile,
      context.commandProfile,
      task.profile,
      task.command_profile,
      task.commandProfile,
    ),
    dangerous: pickFirstDefined(context.dangerous, task.dangerous),
    source: pickFirstDefined(context.source, task.source, 'policy-engine.command-adapter'),
    caller: pickFirstDefined(context.caller, task.caller, 'collectCommandPolicyEvidence'),
  };
}

function unavailableEvidence(reason) {
  return {
    type: EVIDENCE_TYPE,
    available: false,
    satisfied: null,
    value: { reason },
  };
}

function collectCommandPolicyEvidence(context = {}) {
  const request = resolveCommandContext(context);

  if (!hasCommandValue(request.command)) {
    return unavailableEvidence('command is unavailable');
  }

  if (!isPresentString(request.profile)) {
    return unavailableEvidence('command profile is unavailable');
  }

  const validation = validateCommand(
    request.command,
    request.args,
    String(request.profile).trim(),
    {
      dangerous: request.dangerous === true,
      source: request.source,
      caller: request.caller,
    },
  );

  return {
    type: EVIDENCE_TYPE,
    available: true,
    satisfied: validation.allowed,
    value: { reason: validation.reason },
  };
}

module.exports = {
  collectCommandPolicyEvidence,
};
