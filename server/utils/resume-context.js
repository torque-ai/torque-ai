'use strict';

const MAX_PROGRESS_LENGTH = 500;
const MAX_ERROR_LENGTH = 1000;
const MAX_APPROACH_LENGTH = 500;
const MAX_COMMANDS = 20;

const FILE_ACTION_PATTERN = /(?:Wrote|Created|Modified|Updated|Edited)\s+(?:\[|)([\w/.\-]+\.\w+)/;
const MARKDOWN_LINK_PATTERN = /-\s*\[([\w/.\-]+\.\w+)\]/;
const ERROR_BOUNDARY_PATTERN = /(?:^|\r?\n)\s*(?:Error|ERROR|Failed|FAILED|Exception|Traceback|Command failed)\b/m;

function toText(value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

function firstChars(text, maxLength) {
  return toText(text).slice(0, maxLength);
}

function lastChars(text, maxLength) {
  const normalized = toText(text);
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(normalized.length - maxLength);
}

function addUnique(list, value) {
  if (!value || list.includes(value)) return;
  list.push(value);
}

function normalizePath(rawPath) {
  return toText(rawPath).trim().replace(/\]$/, '');
}

function extractTaskOutputBeforeError(taskOutput) {
  const normalized = toText(taskOutput);
  if (!normalized) return '';

  const match = ERROR_BOUNDARY_PATTERN.exec(normalized);
  return match ? normalized.slice(0, match.index) : normalized;
}

function extractFilesModified(taskOutput) {
  const filesModified = [];
  const lines = toText(taskOutput).split(/\r?\n/);

  for (const line of lines) {
    const actionMatch = line.match(FILE_ACTION_PATTERN);
    if (actionMatch && actionMatch[1]) {
      addUnique(filesModified, normalizePath(actionMatch[1]));
    }

    const linkMatch = line.match(MARKDOWN_LINK_PATTERN);
    if (linkMatch && linkMatch[1]) {
      addUnique(filesModified, normalizePath(linkMatch[1]));
    }
  }

  return filesModified;
}

function extractCommands(taskOutput) {
  const commandsRun = [];
  const lines = toText(taskOutput).split(/\r?\n/);

  for (const line of lines) {
    if (commandsRun.length >= MAX_COMMANDS) {
      break;
    }

    const trimmed = line.trim();
    if (!trimmed) continue;

    let command = '';
    if (trimmed.startsWith('$ ')) {
      command = trimmed.slice(2).trim();
    } else if (/^(?:npx|git|npm run|node)\s/.test(trimmed)) {
      command = trimmed;
    }

    addUnique(commandsRun, command);
  }

  return commandsRun;
}

function buildResumeContext(taskOutput, errorOutput, metadata) {
  const safeMetadata = metadata && typeof metadata === 'object' ? metadata : {};
  const normalizedTaskOutput = toText(taskOutput);
  const normalizedErrorOutput = toText(errorOutput);
  const outputBeforeError = extractTaskOutputBeforeError(normalizedTaskOutput);
  const duration = Number(safeMetadata.duration_ms ?? safeMetadata.durationMs);

  return {
    goal: toText(safeMetadata.task_description || safeMetadata.original_description),
    filesModified: extractFilesModified(normalizedTaskOutput),
    commandsRun: extractCommands(normalizedTaskOutput),
    progressSummary: lastChars(outputBeforeError, MAX_PROGRESS_LENGTH),
    errorDetails: lastChars(normalizedErrorOutput, MAX_ERROR_LENGTH),
    approachTaken: firstChars(normalizedTaskOutput, MAX_APPROACH_LENGTH),
    durationMs: Number.isFinite(duration) ? duration : 0,
    provider: toText(safeMetadata.provider).trim() || 'unknown',
  };
}

function formatResumeContextForPrompt(resumeContext) {
  if (!resumeContext || typeof resumeContext !== 'object' || Object.keys(resumeContext).length === 0) {
    return '';
  }

  const provider = toText(resumeContext.provider).trim() || 'unknown';
  const durationMs = Number.isFinite(Number(resumeContext.durationMs)) ? Number(resumeContext.durationMs) : 0;
  const filesModified = Array.isArray(resumeContext.filesModified)
    ? resumeContext.filesModified.filter(Boolean)
    : [];

  return [
    '## Previous Attempt (failed)',
    `**Provider:** ${provider} | **Duration:** ${durationMs / 1000}s`,
    `**Files modified:** ${filesModified.length > 0 ? filesModified.join(', ') : 'none'}`,
    `**Progress:** ${toText(resumeContext.progressSummary)}`,
    `**Error:** ${toText(resumeContext.errorDetails)}`,
    `**Approach taken:** ${toText(resumeContext.approachTaken)}`,
    '',
    'Do not repeat the same approach. Fix the error and complete the task.',
  ].join('\n');
}

module.exports = {
  buildResumeContext,
  formatResumeContextForPrompt,
};
