/**
 * Advanced handlers — Task Debugger
 *
 * 6 handlers for breakpoints, stepping, state inspection, and debug status.
 * Extracted from advanced-handlers.js during Phase 7 handler decomposition.
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../../database');
const taskManager = require('../../task-manager');
const { VALID_BREAKPOINT_ACTIONS, VALID_PATTERN_TYPES, isSafeRegexPattern, ErrorCodes, makeError } = require('../shared');


/**
 * Set a breakpoint
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleSetBreakpoint(args) {
  const { task_id, pattern, pattern_type, action, max_hits } = args;

  // Input validation
  if (!pattern || typeof pattern !== 'string' || pattern.trim().length === 0) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'pattern must be a non-empty string');
  }
  if (!isSafeRegexPattern(pattern)) {
    return makeError(ErrorCodes.UNSAFE_REGEX, 'pattern must be a valid regular expression (max 200 chars, no nested quantifiers)');
  }
  if (pattern_type !== undefined && !VALID_PATTERN_TYPES.includes(pattern_type)) {
    return makeError(ErrorCodes.INVALID_PARAM, `pattern_type must be one of: ${VALID_PATTERN_TYPES.join(', ')}`);
  }
  if (action !== undefined && !VALID_BREAKPOINT_ACTIONS.includes(action)) {
    return makeError(ErrorCodes.INVALID_PARAM, `action must be one of: ${VALID_BREAKPOINT_ACTIONS.join(', ')}`);
  }
  if (max_hits !== undefined && (typeof max_hits !== 'number' || max_hits < 1)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'max_hits must be a positive number');
  }

  const breakpoint = db.createBreakpoint({
    id: uuidv4(),
    task_id: task_id || null,
    pattern,
    pattern_type: pattern_type || 'output',
    action: action || 'pause',
    max_hits
  });

  let output = `## Breakpoint Created\n\n`;
  output += `**ID:** ${breakpoint.id}\n`;
  output += `**Pattern:** \`${breakpoint.pattern}\`\n`;
  output += `**Type:** ${breakpoint.pattern_type}\n`;
  output += `**Action:** ${breakpoint.action}\n`;
  output += `**Task:** ${breakpoint.task_id || 'All tasks'}\n`;
  output += `**Max Hits:** ${breakpoint.max_hits || 'Unlimited'}\n`;

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * List breakpoints
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleListBreakpoints(args) {
  const options = {};
  if (args.task_id) options.task_id = args.task_id;
  if (args.enabled_only) options.enabled = true;

  const breakpoints = db.listBreakpoints(options);

  let output = `## Breakpoints\n\n`;

  if (breakpoints.length === 0) {
    output += `No breakpoints found.\n`;
  } else {
    output += `| ID | Pattern | Type | Action | Hits | Enabled |\n`;
    output += `|----|---------|------|--------|------|--------|\n`;

    for (const bp of breakpoints) {
      const pattern = bp.pattern.length > 20 ? bp.pattern.substring(0, 20) + '...' : bp.pattern;
      const hits = bp.max_hits ? `${bp.hit_count}/${bp.max_hits}` : bp.hit_count;
      output += `| ${bp.id.substring(0, 8)}... | \`${pattern}\` | ${bp.pattern_type} | ${bp.action} | ${hits} | ${bp.enabled ? 'Yes' : 'No'} |\n`;
    }

    output += `\n**Total:** ${breakpoints.length} breakpoints`;
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Clear a breakpoint
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleClearBreakpoint(args) {
  const breakpoint = db.getBreakpoint(args.breakpoint_id);

  if (!breakpoint) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Breakpoint not found: ${args.breakpoint_id}`);
  }

  db.deleteBreakpoint(args.breakpoint_id);

  return {
    content: [{ type: 'text', text: `Breakpoint deleted: ${breakpoint.pattern}` }]
  };
}


/**
 * Step task execution
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleStepExecution(args) {
  const { task_id, step_mode, step_count } = args;
  const resolvedStepMode = step_mode || 'continue';

  const session = db.getDebugSessionByTask(task_id);
  if (!session) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `No active debug session for task: ${task_id}`);
  }

  if (session.status !== 'paused') {
    return makeError(ErrorCodes.INVALID_STATUS_TRANSITION, `Task is not paused. Current status: ${session.status}`);
  }

  // Update session with step mode
  db.updateDebugSession(session.id, {
    status: 'stepping',
    step_mode: resolvedStepMode
  });

  // Resume task — rollback status on failure
  let resumed;
  try {
    resumed = taskManager.resumeTask(task_id);
  } catch (err) {
    db.updateDebugSession(session.id, { status: 'paused' });
    return makeError(ErrorCodes.OPERATION_FAILED, `Failed to resume task: ${err.message}`);
  }
  if (!resumed) {
    db.updateDebugSession(session.id, { status: 'paused' });
  }

  let output = `## Stepping Execution\n\n`;
  output += `**Task:** ${task_id}\n`;
  output += `**Mode:** ${resolvedStepMode}\n`;
  output += `**Resumed:** ${resumed ? 'Yes' : 'No'}\n`;

  if (resolvedStepMode === 'continue') {
    output += `\nTask will continue until the next breakpoint or completion.`;
  } else {
    output += `\nTask will step ${step_count || 1} ${resolvedStepMode === 'step_chunk' ? 'chunk(s)' : 'line(s)'}.`;
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Inspect captured state
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleInspectState(args) {
  if (!args.task_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required');
  }

  const state = db.getDebugState(args.task_id);

  if (!state) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `No debug state for task: ${args.task_id}`);
  }

  let output = `## Debug State: ${args.task_id.substring(0, 8)}...\n\n`;

  output += `### Session\n\n`;
  output += `**Status:** ${state.session.status}\n`;
  output += `**Step Mode:** ${state.session.step_mode || 'N/A'}\n`;
  output += `**Created:** ${new Date(state.session.created_at).toLocaleString()}\n`;

  if (state.session.current_breakpoint_id) {
    const bp = db.getBreakpoint(state.session.current_breakpoint_id);
    if (bp) {
      output += `**Paused at:** \`${bp.pattern}\`\n`;
    }
  }

  if (state.captures.length > 0) {
    output += `\n### Captures (${state.captures.length})\n\n`;

    const latest = state.captures[state.captures.length - 1];
    output += `**Latest Capture:**\n`;
    output += `- Progress: ${latest.progress_percent || 0}%\n`;
    output += `- Elapsed: ${latest.elapsed_seconds || 0}s\n`;

    if (args.include_output && latest.output_snapshot) {
      output += `\n### Output Snapshot\n\n`;
      output += '```\n';
      output += latest.output_snapshot.substring(0, 2000);
      if (latest.output_snapshot.length > 2000) {
        output += '\n... (truncated)';
      }
      output += '\n```\n';
    }

    if (latest.error_snapshot) {
      output += `\n### Error Snapshot\n\n`;
      output += '```\n';
      output += latest.error_snapshot.substring(0, 1000);
      output += '\n```\n';
    }
  }

  if (state.breakpoints.length > 0) {
    output += `\n### Active Breakpoints: ${state.breakpoints.filter(b => b.enabled).length}\n`;
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Get debug status
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleDebugStatus(args) {
  if (!args.task_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required');
  }

  const session = db.getDebugSessionByTask(args.task_id);
  const breakpoints = db.listBreakpoints({ task_id: args.task_id });

  let output = `## Debug Status: ${args.task_id.substring(0, 8)}...\n\n`;

  if (session) {
    output += `### Active Session\n\n`;
    output += `**Status:** ${session.status}\n`;
    output += `**Step Mode:** ${session.step_mode || 'N/A'}\n`;

    if (session.current_breakpoint_id) {
      output += `**Current Breakpoint:** ${session.current_breakpoint_id.substring(0, 8)}...\n`;
    }

    const captures = db.getDebugCaptures(session.id);
    output += `**Captures:** ${captures.length}\n`;
  } else {
    output += `No active debug session.\n`;
  }

  output += `\n### Breakpoints\n\n`;
  const enabledBps = breakpoints.filter(b => b.enabled);
  output += `**Total:** ${breakpoints.length}\n`;
  output += `**Enabled:** ${enabledBps.length}\n`;

  if (enabledBps.length > 0) {
    output += `\n| Pattern | Type | Hits |\n`;
    output += `|---------|------|------|\n`;

    for (const bp of enabledBps.slice(0, 5)) {
      const pattern = bp.pattern.length > 25 ? bp.pattern.substring(0, 25) + '...' : bp.pattern;
      output += `| \`${pattern}\` | ${bp.pattern_type} | ${bp.hit_count} |\n`;
    }

    if (enabledBps.length > 5) {
      output += `\n*...and ${enabledBps.length - 5} more*`;
    }
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


module.exports = {
  handleSetBreakpoint,
  handleListBreakpoints,
  handleClearBreakpoint,
  handleStepExecution,
  handleInspectState,
  handleDebugStatus,
};
