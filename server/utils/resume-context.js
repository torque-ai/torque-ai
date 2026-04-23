'use strict';

const MAX_PROGRESS_LENGTH = 500;
const MAX_ERROR_LENGTH = 1000;
const MAX_APPROACH_LENGTH = 500;
const MAX_COMMANDS = 20;
const MAX_FILES = 50;
const RESUME_CONTEXT_HEADING = '## Previous Attempt (failed)';
const RESUME_CONTEXT_INSTRUCTION = 'Do not repeat the same approach. Fix the error and complete the task.';

const FILE_ACTION_PATTERN = /\b(?:Wrote|Created|Modified|Updated|Edited)\b(?:\s+(?:file|path))?\s*[:-]?\s*(.+)$/i;
const MARKDOWN_LINK_PATTERN = /\[([^\]\r\n]+\.[A-Za-z0-9]{1,16})\](?:\([^)]+\))?/g;
const CODE_SPAN_PATH_PATTERN = /`([^`\r\n]+\.[A-Za-z0-9]{1,16})`/g;
const QUOTED_PATH_PATTERN = /["']([^"'\r\n]+\.[A-Za-z0-9]{1,16})["']/g;
const PLAIN_PATH_PATTERN = /(?:^|[\s([<])((?:(?:[A-Za-z]:[\\/])|(?:[A-Za-z0-9_.-]+[\\/]))(?:[A-Za-z0-9_. -]+[\\/])*[A-Za-z0-9_. -]+\.[A-Za-z0-9]{1,16}|[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,16})(?=$|[\s),>\]])/g;
const COMMAND_PREFIX_PATTERN = /^(?:npx|npm|pnpm|yarn|git|node|vitest|dotnet)\b/;
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
  return toText(rawPath)
    .trim()
    .replace(/^[`'"[(<]+/, '')
    .replace(/[`'"\])>.,;:]+$/, '')
    .replace(/\\/g, '/');
}

function isFileLikePath(value) {
  const normalized = normalizePath(value);
  if (!normalized) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) return false;
  return /\.[A-Za-z0-9]{1,16}$/.test(normalized);
}

function addPath(list, rawPath) {
  const normalized = normalizePath(rawPath);
  if (!isFileLikePath(normalized) || list.length >= MAX_FILES) return;
  addUnique(list, normalized);
}

function collectPathMatches(list, text, pattern) {
  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    addPath(list, match[1]);
    if (list.length >= MAX_FILES) break;
  }
}

function addMetadataFiles(list, metadata) {
  const candidates = [
    metadata.filesModified,
    metadata.files_modified,
    metadata.modifiedFiles,
    metadata.modified_files,
  ];

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    for (const filePath of candidate) {
      addPath(list, filePath);
      if (list.length >= MAX_FILES) return;
    }
  }
}

function extractTaskOutputBeforeError(taskOutput) {
  const normalized = toText(taskOutput);
  if (!normalized) return '';

  const match = ERROR_BOUNDARY_PATTERN.exec(normalized);
  return match ? normalized.slice(0, match.index) : normalized;
}

function extractFilesModified(taskOutput, metadata = {}) {
  const filesModified = [];
  const lines = toText(taskOutput).split(/\r?\n/);

  for (const line of lines) {
    const actionMatch = line.match(FILE_ACTION_PATTERN);
    const searchText = actionMatch && actionMatch[1] ? actionMatch[1] : line;

    if (actionMatch) {
      collectPathMatches(filesModified, searchText, MARKDOWN_LINK_PATTERN);
      collectPathMatches(filesModified, searchText, CODE_SPAN_PATH_PATTERN);
      collectPathMatches(filesModified, searchText, QUOTED_PATH_PATTERN);
      collectPathMatches(filesModified, searchText, PLAIN_PATH_PATTERN);
    }

    if (!actionMatch) {
      collectPathMatches(filesModified, searchText, MARKDOWN_LINK_PATTERN);
    }

    if (filesModified.length >= MAX_FILES) {
      break;
    }
  }

  addMetadataFiles(filesModified, metadata);
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
    if (/^\$\s+/.test(trimmed)) {
      command = trimmed.replace(/^\$\s+/, '').trim();
    } else if (/^>\s+/.test(trimmed)) {
      const candidate = trimmed.replace(/^>\s+/, '').trim();
      command = COMMAND_PREFIX_PATTERN.test(candidate) ? candidate : '';
    } else if (COMMAND_PREFIX_PATTERN.test(trimmed)) {
      command = trimmed;
    }

    addUnique(commandsRun, command);
  }

  return commandsRun;
}

function getGoal(metadata) {
  return toText(
    metadata.task_description
      || metadata.original_description
      || metadata.description
      || metadata.goal
  );
}

function getDurationMs(metadata) {
  const explicit = Number(metadata.duration_ms ?? metadata.durationMs);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;

  const startedAt = Date.parse(metadata.started_at || metadata.startedAt || '');
  const completedAt = Date.parse(metadata.completed_at || metadata.completedAt || '');
  if (Number.isFinite(startedAt) && Number.isFinite(completedAt)) {
    return Math.max(0, completedAt - startedAt);
  }

  return 0;
}

function buildResumeContext(taskOutput, errorOutput, metadata) {
  const safeMetadata = metadata && typeof metadata === 'object' ? metadata : {};
  const normalizedTaskOutput = toText(taskOutput);
  const normalizedErrorOutput = toText(errorOutput);
  const outputBeforeError = extractTaskOutputBeforeError(normalizedTaskOutput);

  return {
    goal: getGoal(safeMetadata),
    filesModified: extractFilesModified(normalizedTaskOutput, safeMetadata),
    commandsRun: extractCommands(normalizedTaskOutput),
    progressSummary: lastChars(outputBeforeError, MAX_PROGRESS_LENGTH),
    errorDetails: lastChars(normalizedErrorOutput, MAX_ERROR_LENGTH),
    approachTaken: firstChars(normalizedTaskOutput, MAX_APPROACH_LENGTH),
    durationMs: getDurationMs(safeMetadata),
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
    ? resumeContext.filesModified.map(normalizePath).filter(Boolean)
    : [];

  return [
    '## Previous Attempt (failed)',
    `**Provider:** ${provider} | **Duration:** ${durationMs / 1000}s`,
    `**Files modified:** ${filesModified.length > 0 ? filesModified.join(', ') : 'none'}`,
    `**Progress:** ${toText(resumeContext.progressSummary)}`,
    `**Error:** ${toText(resumeContext.errorDetails)}`,
    `**Approach taken:** ${toText(resumeContext.approachTaken)}`,
    '',
    RESUME_CONTEXT_INSTRUCTION,
  ].join('\n');
}

function parseResumeContextValue(value) {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function stripExistingResumeContextPreamble(prompt) {
  const normalized = toText(prompt);
  const leadingWhitespaceMatch = normalized.match(/^\s*/);
  const leadingLength = leadingWhitespaceMatch ? leadingWhitespaceMatch[0].length : 0;
  const body = normalized.slice(leadingLength);

  if (!body.startsWith(RESUME_CONTEXT_HEADING)) {
    return normalized;
  }

  const delimiterMatch = /\r?\n\r?\n---\r?\n\r?\n/.exec(body);
  if (delimiterMatch) {
    return body.slice(delimiterMatch.index + delimiterMatch[0].length);
  }

  const instructionIndex = body.indexOf(RESUME_CONTEXT_INSTRUCTION);
  if (instructionIndex < 0) {
    return normalized;
  }

  return body
    .slice(instructionIndex + RESUME_CONTEXT_INSTRUCTION.length)
    .replace(/^\s+/, '');
}

function prependResumeContextToPrompt(prompt, resumeContext, options = {}) {
  const parsed = parseResumeContextValue(resumeContext);
  const preamble = formatResumeContextForPrompt(parsed);
  if (!preamble) {
    return toText(prompt);
  }

  const description = options.replaceExisting === false
    ? toText(prompt)
    : stripExistingResumeContextPreamble(prompt);

  if (!description.trim()) {
    return description;
  }

  const separator = options.separator === false ? '' : (options.separator || '---');
  const separatorBlock = separator ? `\n\n${separator}\n\n` : '\n\n';
  return `${preamble}${separatorBlock}${description}`;
}

module.exports = {
  buildResumeContext,
  formatResumeContextForPrompt,
  prependResumeContextToPrompt,
};
