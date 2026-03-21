'use strict';

const MAX_GOAL_LENGTH = 200;
const MAX_PROGRESS_LENGTH = 500;
const MAX_ERROR_LENGTH = 1000;
const MAX_APPROACH_LENGTH = 500;
const MAX_PROMPT_LENGTH = 3000;

const FILE_PATTERNS = [
  /^(?:Wrote|Created|Modified)\s+(.+)$/,
  /^Edit:\s+(.+)$/,
  /^---\s+a\/(.+)$/,
  /^\+\+\+\s+b\/(.+)$/,
  /^[MA]\s{2}(.+)$/,
];

const ERROR_BOUNDARY_PATTERNS = [
  /^\s*Error\b.*$/m,
  /^\s*ERROR\b.*$/m,
  /^\s*Failed\b.*$/m,
  /^\s*FAILED\b.*$/m,
  /^\s*Exception\b.*$/m,
  /^\s*Traceback\b.*$/m,
  /^\s*Command failed\b.*$/m,
];

const COMMAND_PATTERNS = ['npx ', 'npm ', 'git ', 'node '];

function toText(value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

function firstChars(text, maxLength) {
  const normalized = toText(text);
  return normalized.slice(0, maxLength);
}

function lastChars(text, maxLength) {
  const normalized = toText(text);
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(normalized.length - maxLength);
}

function addUnique(values, value) {
  if (!value || values.includes(value)) return;
  values.push(value);
}

function normalizePath(rawPath) {
  let filePath = toText(rawPath).trim();
  if (!filePath) return '';

  filePath = filePath.split('\t')[0].trim();
  filePath = filePath.replace(/^["'`]+|["'`]+$/g, '');
  filePath = filePath.replace(/^[ab][\\/]/, '');
  filePath = filePath.replace(/[,:;]+$/, '');
  filePath = filePath.replace(/\s+\([^)]*\)$/, '');

  if (!filePath || filePath === '/dev/null') return '';
  return filePath;
}

function looksLikePath(value) {
  return /[\\/]/.test(value) || /\.[A-Za-z0-9]+$/.test(value);
}

function extractFilesModified(text) {
  const filesModified = [];
  const lines = toText(text).split(/\r?\n/);

  for (const line of lines) {
    for (const pattern of FILE_PATTERNS) {
      const match = line.match(pattern);
      if (!match) continue;

      const filePath = normalizePath(match[1]);
      if (looksLikePath(filePath)) {
        addUnique(filesModified, filePath);
      }
      break;
    }
  }

  return filesModified;
}

function extractCommands(text) {
  const commandsRun = [];
  const lines = toText(text).split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let command = '';
    if (trimmed.startsWith('$ ') || trimmed.startsWith('> ')) {
      command = trimmed.slice(2).trim();
    } else {
      let matchIndex = -1;
      for (const marker of COMMAND_PATTERNS) {
        const index = trimmed.indexOf(marker);
        if (index !== -1 && (matchIndex === -1 || index < matchIndex)) {
          matchIndex = index;
        }
      }

      if (matchIndex !== -1) {
        command = trimmed.slice(matchIndex).trim();
      }
    }

    addUnique(commandsRun, command);
  }

  return commandsRun;
}

function extractTaskOutputBeforeError(taskOutput) {
  const normalized = toText(taskOutput);
  if (!normalized) return '';

  let boundaryIndex = -1;
  for (const pattern of ERROR_BOUNDARY_PATTERNS) {
    const match = pattern.exec(normalized);
    if (!match || typeof match.index !== 'number') continue;
    if (boundaryIndex === -1 || match.index < boundaryIndex) {
      boundaryIndex = match.index;
    }
  }

  return boundaryIndex === -1 ? normalized : normalized.slice(0, boundaryIndex);
}

function buildResumeContext(taskOutput, errorOutput, metadata) {
  const safeMetadata = metadata && typeof metadata === 'object' ? metadata : {};
  const normalizedTaskOutput = toText(taskOutput);
  const normalizedErrorOutput = toText(errorOutput);
  const outputBeforeError = extractTaskOutputBeforeError(normalizedTaskOutput);
  const combinedOutput = [normalizedTaskOutput, normalizedErrorOutput].filter(Boolean).join('\n');
  const description = toText(safeMetadata.description).trim();

  return {
    goal: description || firstChars(normalizedTaskOutput, MAX_GOAL_LENGTH),
    filesModified: extractFilesModified(combinedOutput),
    commandsRun: extractCommands(combinedOutput),
    progressSummary: lastChars(outputBeforeError, MAX_PROGRESS_LENGTH).trim(),
    errorDetails: lastChars(normalizedErrorOutput, MAX_ERROR_LENGTH).trim(),
    approachTaken: firstChars(normalizedTaskOutput, MAX_APPROACH_LENGTH).trim(),
    durationMs: Number.isFinite(safeMetadata.durationMs) ? safeMetadata.durationMs : 0,
    provider: toText(safeMetadata.provider).trim() || 'unknown',
  };
}

function formatResumeContextForPrompt(resumeContext) {
  const safeContext = resumeContext && typeof resumeContext === 'object' ? resumeContext : {};
  const provider = toText(safeContext.provider).trim() || 'unknown';
  const durationMs = Number.isFinite(safeContext.durationMs) ? safeContext.durationMs : 0;
  const filesModified = Array.isArray(safeContext.filesModified) ? safeContext.filesModified.filter(Boolean) : [];
  const commandsRun = Array.isArray(safeContext.commandsRun) ? safeContext.commandsRun.filter(Boolean) : [];
  const progressSummary = toText(safeContext.progressSummary).trim();
  const errorDetails = toText(safeContext.errorDetails).trim();
  const approachTaken = toText(safeContext.approachTaken).trim();

  const lines = [
    '## Previous Attempt (failed)',
    `**Provider:** ${provider} | **Duration:** ${durationMs}ms`,
  ];

  if (filesModified.length > 0) {
    lines.push(`**Files touched:** ${filesModified.join(', ')}`);
  }

  if (commandsRun.length > 0) {
    lines.push(`**Commands run:** ${commandsRun.join(', ')}`);
  }

  if (progressSummary) {
    lines.push(`**Progress before failure:**\n${progressSummary}`);
  }

  if (errorDetails) {
    lines.push(`**Error:**\n${errorDetails}`);
  }

  if (approachTaken) {
    lines.push(`**Approach taken:**\n${approachTaken}`);
  }

  lines.push('');
  lines.push('Do NOT repeat the same approach. Analyze what went wrong, fix the root cause, and complete the task.');

  const markdown = lines.join('\n');
  return markdown.length <= MAX_PROMPT_LENGTH
    ? markdown
    : markdown.slice(0, MAX_PROMPT_LENGTH);
}

module.exports = {
  buildResumeContext,
  formatResumeContextForPrompt,
};
