/**
 * MCP Handlers for tsserver tools
 */

'use strict';

const tsserverClient = require('../utils/tsserver-client');
const serverConfig = require('../config');
const { ErrorCodes, makeError } = require('./shared');

/**
 * Show status of all tsserver sessions.
 */
function handleTsserverStatus(_args) {
  const enabled = serverConfig.isOptIn('tsserver_enabled');
  const sessions = tsserverClient.getSessionStatus();

  if (!enabled) {
    return {
      content: [{
        type: 'text',
        text: '## tsserver Status\n\n**Disabled.** Set `tsserver_enabled` to `1` to enable.\n'
      }]
    };
  }

  if (sessions.length === 0) {
    return {
      content: [{
        type: 'text',
        text: '## tsserver Status\n\n**Enabled** but no active sessions. Sessions are created lazily on first TS query.\n'
      }]
    };
  }

  let output = '## tsserver Sessions\n\n';
  output += '| Directory | Alive | Open Files | Cached Diag Files | Pending | Restarts | Idle |\n';
  output += '|-----------|-------|------------|-------------------|---------|----------|------|\n';

  for (const s of sessions) {
    const alive = s.alive ? 'Yes' : (s.dead ? 'Dead' : 'No');
    output += `| ${s.workingDir} | ${alive} | ${s.openFiles} | ${s.cachedDiagFiles} | ${s.pendingRequests} | ${s.restartCount} | ${s.idleSeconds}s |\n`;
  }

  return { content: [{ type: 'text', text: output }] };
}

/**
 * Get diagnostics for files.
 */
async function handleTsserverDiagnostics(args) {
  try {
  
  const { working_directory, file_paths, timeout_ms } = args;
  

  if (!working_directory || !file_paths || file_paths.length === 0) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory and file_paths are required');
  }

  const enabled = serverConfig.isOptIn('tsserver_enabled');
  if (!enabled) {
    return makeError(ErrorCodes.INVALID_STATUS_TRANSITION, 'tsserver is disabled. Set `tsserver_enabled` to `1` to enable.');
  }

  try {
    const results = await tsserverClient.getDiagnostics(working_directory, file_paths, timeout_ms);

    let output = '## TypeScript Diagnostics\n\n';
    let totalErrors = 0;

    for (const { file, diagnostics } of results) {
      if (diagnostics.length === 0) {
        output += `**${file}** — No errors\n\n`;
        continue;
      }

      output += `**${file}** — ${diagnostics.length} diagnostic(s)\n\n`;
      for (const d of diagnostics) {
        const loc = d.start ? `L${d.start.line}:${d.start.offset}` : '?';
        const category = d.category || 'error';
        output += `- \`${loc}\` [${category}] TS${d.code || '?'}: ${d.text || d.message || '(no message)'}\n`;
        totalErrors++;
      }
      output += '\n';
    }

    output += `**Total:** ${totalErrors} diagnostic(s) across ${results.length} file(s)\n`;

    return { content: [{ type: 'text', text: output }] };
  } catch (e) {
    return makeError(ErrorCodes.OPERATION_FAILED, `Error getting diagnostics: ${e.message}`);
  }
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }}

/**
 * Get type info at a position.
 */
async function handleTsserverQuickinfo(args) {
  try {
  
  const { working_directory, file_path, line, offset } = args;
  

  if (!working_directory || !file_path || !line || !offset) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory, file_path, line, and offset are required');
  }

  const enabled = serverConfig.isOptIn('tsserver_enabled');
  if (!enabled) {
    return makeError(ErrorCodes.INVALID_STATUS_TRANSITION, 'tsserver is disabled. Set `tsserver_enabled` to `1` to enable.');
  }

  try {
    const info = await tsserverClient.getQuickInfo(working_directory, file_path, line, offset);

    if (!info) {
      return { content: [{ type: 'text', text: `No type info at ${file_path}:${line}:${offset}` }] };
    }

    let output = `## Quick Info at ${file_path}:${line}:${offset}\n\n`;
    output += `**Type:** \`${info.displayString}\`\n`;
    if (info.documentation) {
      output += `\n**Documentation:** ${info.documentation}\n`;
    }

    return { content: [{ type: 'text', text: output }] };
  } catch (e) {
    return makeError(ErrorCodes.OPERATION_FAILED, `Error: ${e.message}`);
  }
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }}

/**
 * Go-to-definition.
 */
async function handleTsserverDefinition(args) {
  try {
  
  const { working_directory, file_path, line, offset } = args;
  

  if (!working_directory || !file_path || !line || !offset) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory, file_path, line, and offset are required');
  }

  const enabled = serverConfig.isOptIn('tsserver_enabled');
  if (!enabled) {
    return makeError(ErrorCodes.INVALID_STATUS_TRANSITION, 'tsserver is disabled. Set `tsserver_enabled` to `1` to enable.');
  }

  try {
    const defs = await tsserverClient.getDefinition(working_directory, file_path, line, offset);

    if (defs.length === 0) {
      return { content: [{ type: 'text', text: `No definition found for symbol at ${file_path}:${line}:${offset}` }] };
    }

    let output = `## Definition(s) for ${file_path}:${line}:${offset}\n\n`;
    for (const d of defs) {
      const startLine = d.start?.line || '?';
      const startOffset = d.start?.offset || '?';
      output += `- **${d.file}** L${startLine}:${startOffset}\n`;
    }

    return { content: [{ type: 'text', text: output }] };
  } catch (e) {
    return makeError(ErrorCodes.OPERATION_FAILED, `Error: ${e.message}`);
  }
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }}

module.exports = {
  handleTsserverStatus,
  handleTsserverDiagnostics,
  handleTsserverQuickinfo,
  handleTsserverDefinition,
};
