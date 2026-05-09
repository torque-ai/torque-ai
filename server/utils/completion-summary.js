'use strict';

/**
 * Pure completion summarizer for successful task rows.
 *
 * Failed/cancelled tasks already have error-summary.js. This helper covers the
 * opposite operator problem: a task can be marked completed while the useful
 * completion evidence is buried in a provider transcript, or missing entirely.
 */

const COMPLETED_STATUSES = new Set(['completed', 'shipped']);
const MAX_FILE_LIST = 20;
const MAX_EXCERPT = 360;

function summarizeTaskCompletion(task) {
  if (!task || typeof task !== 'object') return null;

  const status = String(task.status || '').toLowerCase();
  if (!COMPLETED_STATUSES.has(status)) return null;

  const filesModified = normalizeFilesModified(task.files_modified);
  const output = typeof task.output === 'string' ? task.output : '';
  const errorOutput = typeof task.error_output === 'string' ? task.error_output : '';
  const finalAnswer = extractFinalAnswer(output, errorOutput);
  const executedCommands = extractExecutedCommands(`${output}\n${errorOutput}`);
  const verification = extractVerificationEvidence(`${output}\n${errorOutput}`, executedCommands);

  const evidence = {
    files_modified: filesModified.length > 0,
    final_answer: Boolean(finalAnswer),
    verification_command: verification.commands.length > 0,
    stdout: output.trim().length > 0,
    stderr_transcript: errorOutput.trim().length > 0,
    executed_command_count: executedCommands.length,
  };

  let category = 'completed_with_evidence';
  let confidence = 'medium';
  let nextStep = null;
  const summaryParts = [];

  if (filesModified.length > 0) {
    category = 'completed_with_changes';
    confidence = 'high';
    summaryParts.push(`Completed with ${filesModified.length} modified file${filesModified.length === 1 ? '' : 's'}: ${formatFileList(filesModified)}.`);
  } else {
    summaryParts.push('Completed with no recorded file changes.');
  }

  if (verification.commands.length > 0) {
    const statusLabel = verification.status === 'unknown' ? 'recorded' : verification.status;
    summaryParts.push(`Verification ${statusLabel}: ${verification.commands[0]}.`);
  }

  if (finalAnswer) {
    summaryParts.push(`Final answer: ${finalAnswer.excerpt}`);
  }

  if (filesModified.length === 0 && !finalAnswer && verification.commands.length === 0) {
    category = 'completed_no_evidence';
    confidence = 'low';
    nextStep = 'Review the transcript or retry the task before trusting the completed status.';
    const transcriptNote = executedCommands.length > 0
      ? ` Transcript only shows ${executedCommands.length} executed command${executedCommands.length === 1 ? '' : 's'}, none of them verification.`
      : '';
    summaryParts.length = 0;
    summaryParts.push(`Marked completed, but no completion evidence was captured: no modified files, no final answer, and no verification command.${transcriptNote}`);
  }

  return {
    summary: summaryParts.join(' '),
    category,
    confidence,
    files_modified_count: filesModified.length,
    files_modified: filesModified.slice(0, MAX_FILE_LIST),
    files_modified_truncated: filesModified.length > MAX_FILE_LIST,
    final_answer: finalAnswer,
    verification,
    evidence,
    next_step: nextStep,
  };
}

function normalizeFilesModified(raw) {
  if (Array.isArray(raw)) {
    return raw
      .map(normalizeFileEntry)
      .filter(Boolean);
  }

  if (typeof raw === 'string' && raw.trim()) {
    try {
      return normalizeFilesModified(JSON.parse(raw));
    } catch {
      return [];
    }
  }

  return [];
}

function normalizeFileEntry(entry) {
  if (typeof entry === 'string') return entry.trim();
  if (entry && typeof entry === 'object') {
    return String(entry.file_path || entry.file || entry.path || '').trim();
  }
  return '';
}

function formatFileList(files) {
  const visible = files.slice(0, 3);
  const suffix = files.length > visible.length ? `, and ${files.length - visible.length} more` : '';
  return visible.join(', ') + suffix;
}

function extractFinalAnswer(output, errorOutput) {
  const stdout = cleanExcerpt(output);
  if (stdout && !isProgressOnlyOutput(stdout)) {
    return {
      source: 'stdout',
      excerpt: truncate(stdout, MAX_EXCERPT),
    };
  }

  const blocks = extractCodexBlocks(errorOutput);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const candidate = cleanExcerpt(blocks[i]);
    if (isLikelyFinalAnswer(candidate)) {
      return {
        source: 'provider_transcript',
        excerpt: truncate(candidate, MAX_EXCERPT),
      };
    }
  }

  return null;
}

function extractCodexBlocks(text) {
  if (!text) return [];
  const lines = String(text).split(/\r?\n/);
  const blocks = [];

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().toLowerCase() !== 'codex') continue;
    const block = [];
    for (let j = i + 1; j < lines.length; j++) {
      const marker = lines[j].trim();
      if (isTranscriptMarker(marker)) {
        i = j - 1;
        break;
      }
      block.push(lines[j]);
      if (j === lines.length - 1) i = j;
    }
    const textBlock = block.join('\n').trim();
    if (textBlock) blocks.push(textBlock);
  }

  return blocks;
}

function isTranscriptMarker(line) {
  if (!line) return false;
  if (/^(exec|user|system|assistant|tool|tokens used|elapsed)\b/i.test(line)) return true;
  if (/^(succeeded|failed)\s+in\s+\d+/i.test(line)) return true;
  if (/^-{4,}$/.test(line)) return true;
  return line.toLowerCase() === 'codex';
}

function isLikelyFinalAnswer(text) {
  const candidate = cleanExcerpt(text);
  if (!candidate) return false;
  if (/^(i'll|i will|i'm going|i am going|i'm checking|i am checking|i'll first|let me)\b/i.test(candidate)) {
    return false;
  }
  return /\b(implemented|updated|changed|modified|added|removed|fixed|migrated|refactored|completed|done|validated|tests?:|verification|ran|not run|no tests run|files? changed)\b/i.test(candidate);
}

function isProgressOnlyOutput(text) {
  return /^\[Agentic:\s*iteration\b/i.test(text.trim());
}

function cleanExcerpt(text) {
  return String(text || '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
    .replace(/\n{3,}/g, '\n\n');
}

function extractExecutedCommands(text) {
  if (!text) return [];
  const lines = String(text).split(/\r?\n/);
  const commands = [];

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().toLowerCase() !== 'exec') continue;
    for (let j = i + 1; j < lines.length; j++) {
      const command = lines[j].trim();
      if (!command) continue;
      if (isTranscriptMarker(command)) break;
      commands.push(command);
      break;
    }
  }

  return unique(commands.map(normalizeCommandForDisplay).filter(Boolean));
}

function normalizeCommandForDisplay(command) {
  return String(command || '').replace(/\s+/g, ' ').trim();
}

function extractVerificationEvidence(text, executedCommands) {
  const commands = unique((executedCommands || []).filter(isVerificationCommand));
  const status = commands.length === 0
    ? 'not_recorded'
    : inferVerificationStatus(text);

  return {
    status,
    commands: commands.slice(0, 5),
    commands_truncated: commands.length > 5,
  };
}

function isVerificationCommand(command) {
  return /\b(?:dotnet\s+test|npm\s+(?:run\s+)?(?:test|ci|lint)|npx\s+vitest|pnpm\s+(?:test|run\s+(?:test|lint|ci))|yarn\s+(?:test|lint)|pytest|python(?:3)?\s+-m\s+pytest|cargo\s+test|go\s+test)\b/i.test(command);
}

function inferVerificationStatus(text) {
  const t = String(text || '');
  if (/\b(?:Test Run Successful|Tests?\s+passed|PASS\b|passed\b|0\s+failed|succeeded\s+in)\b/i.test(t)) {
    return 'passed';
  }
  if (/\b(?:Test Run Failed|Tests?\s+failed|FAIL\b|failed\b|exit code\s+[1-9])\b/i.test(t)) {
    return 'failed';
  }
  return 'unknown';
}

function unique(values) {
  return [...new Set(values)];
}

function truncate(text, maxLen) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen - 1)}...`;
}

module.exports = {
  summarizeTaskCompletion,
  _internals: {
    normalizeFilesModified,
    extractFinalAnswer,
    extractCodexBlocks,
    extractExecutedCommands,
    extractVerificationEvidence,
    isLikelyFinalAnswer,
  },
};
