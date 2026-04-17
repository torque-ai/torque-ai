'use strict';

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'Bash']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS']);

async function evaluatePermission({
  toolName,
  args,
  settings = {},
  mode = 'auto',
  hooks = [],
  canUseTool = null,
}) {
  let effectiveArgs = args;

  for (const hook of Array.isArray(hooks) ? hooks : []) {
    const result = await hook({ toolName, args: effectiveArgs, mode });
    if (!result) continue;

    if (result.decision === 'deny') {
      return {
        decision: 'deny',
        reason: result.reason || 'hook denied',
        source: 'hook',
      };
    }

    if (result.decision === 'modify') {
      effectiveArgs = result.args;
      continue;
    }

    if (result.decision === 'allow') {
      return {
        decision: 'allow',
        reason: result.reason || 'hook allowed',
        source: 'hook',
        modified_args: effectiveArgs,
      };
    }
  }

  const disallowedTools = Array.isArray(settings.disallowed_tools) ? settings.disallowed_tools : [];
  if (disallowedTools.includes(toolName)) {
    return {
      decision: 'deny',
      reason: 'settings.disallowed_tools',
      source: 'settings',
    };
  }

  const allowedTools = Array.isArray(settings.allowed_tools) ? settings.allowed_tools : [];
  if (allowedTools.includes(toolName)) {
    return {
      decision: 'allow',
      reason: 'settings.allowed_tools',
      source: 'settings',
      modified_args: effectiveArgs,
    };
  }

  if (mode === 'bypassPermissions') {
    return {
      decision: 'allow',
      reason: 'mode=bypassPermissions',
      source: 'mode',
      modified_args: effectiveArgs,
    };
  }

  if (mode === 'plan') {
    if (READ_TOOLS.has(toolName)) {
      return {
        decision: 'allow',
        reason: 'mode=plan (read-only)',
        source: 'mode',
        modified_args: effectiveArgs,
      };
    }

    if (WRITE_TOOLS.has(toolName)) {
      return {
        decision: 'deny',
        reason: 'mode=plan blocks writes',
        source: 'mode',
      };
    }
  }

  if (mode === 'acceptEdits' && WRITE_TOOLS.has(toolName)) {
    return {
      decision: 'allow',
      reason: 'mode=acceptEdits',
      source: 'mode',
      modified_args: effectiveArgs,
    };
  }

  if (typeof canUseTool === 'function') {
    const result = await canUseTool({ toolName, args: effectiveArgs });
    if (result?.decision) {
      return {
        ...result,
        source: 'callback',
        modified_args: result.modified_args || effectiveArgs,
      };
    }
  }

  return {
    decision: 'deny',
    reason: 'no rule matched (default deny)',
    source: 'default',
  };
}

module.exports = { evaluatePermission };
