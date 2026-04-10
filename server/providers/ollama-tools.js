'use strict';

/**
 * providers/ollama-tools.js — Tool definitions and execution for Ollama agentic mode
 *
 * Provides file I/O, directory listing, search, and shell command tools
 * that Ollama models can invoke via the /api/chat tool-calling interface.
 *
 * Security: run_command is intentionally shell-capable — TORQUE tasks
 * need to run build/test/diagnostic commands (dotnet build, npm test, etc.).
 * The model is the agent; this is the tool layer, same as Claude Code's Bash tool.
 *
 * Path jail: write_file and edit_file hard-refuse paths that resolve outside
 * the working directory. read_file, list_directory, and search_files allow
 * external absolute paths (read-only operations are safe) but block relative
 * paths that escape the working directory via ../ traversal.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../logger').child({ component: 'ollama-tools' });
const { isSafeRegex } = require('../utils/safe-regex');
const { lineSimilarity } = require('../handlers/hashline-handlers');

// Safety limits
const MAX_FILE_READ_BYTES = 512 * 1024; // 512KB per file read
const MAX_COMMAND_TIMEOUT_MS = 30_000;   // 30s per command
const MAX_OUTPUT_BYTES = 128 * 1024;     // 128KB per tool result

// Platform detection — cached at module load
const IS_WINDOWS = process.platform === 'win32';

/**
 * Re-indent new_text to match the file's indentation at the match point.
 * Uses prefix-replacement (not character-count delta) to handle mixed tabs/spaces.
 * @param {string} newText - The replacement text
 * @param {string} fileIndent - Leading whitespace of the matched region's first non-blank line
 * @returns {string} Re-indented text
 */
function reindentNewText(newText, fileIndent) {
  const lines = newText.split('\n');
  const firstNonBlank = lines.find(l => l.trim().length > 0);
  if (!firstNonBlank) return newText;
  const newIndent = firstNonBlank.match(/^(\s*)/)[1];

  if (newIndent === fileIndent) return newText;

  return lines.map(line => {
    if (!line.trim()) return line;
    if (line.startsWith(newIndent)) {
      return fileIndent + line.slice(newIndent.length);
    }
    const lineIndent = line.match(/^(\s*)/)[1];
    const common = Math.min(lineIndent.length, newIndent.length);
    return fileIndent + line.slice(common);
  }).join('\n');
}

/**
 * Find a whitespace-normalized match for old_text in file content.
 * Strips leading whitespace from each line before comparing.
 * Returns { startLine, lineCount, fileIndent, lineIndents } or null.
 *   - fileIndent: leading whitespace of the first non-blank matched line
 *   - lineIndents: per-line leading whitespace for each matched file line
 * Throws if multiple matches found.
 */
function findWhitespaceNormalizedMatch(oldText, fileContent) {
  const oldLines = oldText.split('\n').map(l => l.trimStart());
  const fileLines = fileContent.split('\n');
  const normalizedFileLines = fileLines.map(l => l.trimStart());

  const matches = [];
  for (let i = 0; i <= normalizedFileLines.length - oldLines.length; i++) {
    let matched = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (normalizedFileLines[i + j] !== oldLines[j]) {
        matched = false;
        break;
      }
    }
    if (matched) matches.push(i);
  }

  if (matches.length === 0) return null;
  if (matches.length > 1) {
    const err = new Error('multiple_normalized_matches');
    err.code = 'MULTIPLE_MATCHES';
    throw err;
  }

  const startLine = matches[0];
  const matchedFileLines = fileLines.slice(startLine, startLine + oldLines.length);
  const firstNonBlank = matchedFileLines.find(l => l.trim().length > 0);
  const fileIndent = firstNonBlank ? firstNonBlank.match(/^(\s*)/)[1] : '';
  const lineIndents = matchedFileLines.map(l => l.match(/^(\s*)/)[1]);

  return { startLine, lineCount: oldLines.length, fileIndent, lineIndents };
}

/**
 * Find a fuzzy match for old_text in file content using line-by-line Levenshtein similarity.
 * Requires: avg similarity >= 0.80, every line >= 0.50, ambiguity gap (second-best < 0.70).
 * @param {string} oldText - Text to search for
 * @param {string} fileContent - Full file content
 * @returns {{ startLine: number, lineCount: number, fileIndent: string, score: number } | null}
 */
function findFuzzyMatch(oldText, fileContent) {
  const searchLines = oldText.split('\n');
  const fileLines = fileContent.split('\n');

  // Performance guard
  if (fileLines.length > 2000 || searchLines.length > 50) return null;
  if (searchLines.length === 0 || fileLines.length === 0) return null;

  let bestScore = 0;
  let bestStart = -1;
  let secondBestScore = 0;

  for (let i = 0; i <= fileLines.length - searchLines.length; i++) {
    let totalSim = 0;
    let minSim = 1;
    for (let j = 0; j < searchLines.length; j++) {
      const sim = lineSimilarity(searchLines[j], fileLines[i + j]);
      totalSim += sim;
      if (sim < minSim) minSim = sim;
    }
    const avgSim = totalSim / searchLines.length;

    // Track second-best at >= 0.70 for ambiguity detection,
    // but only accept best match if it also passes minSim >= 0.50
    if (avgSim >= 0.70) {
      if (avgSim > bestScore && minSim >= 0.5) {
        secondBestScore = bestScore;
        bestScore = avgSim;
        bestStart = i;
      } else if (avgSim > secondBestScore) {
        secondBestScore = avgSim;
      }
    }
  }

  if (bestStart === -1) return null;

  // Ambiguity gap: second-best must be < 0.70
  if (secondBestScore >= 0.70) return null;

  const firstNonBlank = fileLines.slice(bestStart, bestStart + searchLines.length)
    .find(l => l.trim().length > 0);
  const fileIndent = firstNonBlank ? firstNonBlank.match(/^(\s*)/)[1] : '';

  return {
    startLine: bestStart,
    lineCount: searchLines.length,
    fileIndent,
    score: bestScore,
  };
}

/**
 * Tool definitions in OpenAI / Ollama function-calling format.
 */
const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file. Returns the file text with line numbers. For large files (500+ lines), use start_line/end_line to read only the relevant section — reading the entire file wastes context and slows down inference.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (relative to working directory or absolute)' },
          start_line: { type: 'integer', description: 'First line to read (1-based, inclusive). Omit to start from beginning.' },
          end_line: { type: 'integer', description: 'Last line to read (1-based, inclusive). Omit to read to end.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file. Creates the file if it does not exist, overwrites if it does. Path must be inside the working directory.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (relative to working directory or absolute, must be inside working directory)' },
          content: { type: 'string', description: 'The full file content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace a specific text span in a file. old_text must match exactly (including whitespace/indentation). Without replace_all, fails if multiple matches exist. Path must be inside the working directory.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (must be inside working directory)' },
          old_text: { type: 'string', description: 'Exact text to find in the file' },
          new_text: { type: 'string', description: 'Replacement text' },
          replace_all: { type: 'boolean', description: 'When true, replaces all occurrences (default: false — fails on multiple matches)' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List files and subdirectories at the given path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path (relative to working directory or absolute). Use "." for current directory.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search for a text/regex pattern across files in a directory. Returns matching lines with file paths and line numbers (format: filePath:lineNo: lineContent). Pure Node.js — does not invoke grep or findstr.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Text or regex pattern to search for' },
          path: { type: 'string', description: 'Directory to search in (default: working directory)' },
          glob: { type: 'string', description: 'File extension filter, e.g. "*.cs" or "*.ts" (optional)' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'replace_lines',
      description: 'Replace a range of lines in a file by line number. Use this instead of edit_file for large files — no need to reproduce exact text. Line numbers come from read_file output (1-based). Path must be inside the working directory.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (must be inside working directory)' },
          start_line: { type: 'integer', description: 'First line to replace (1-based, inclusive)' },
          end_line: { type: 'integer', description: 'Last line to replace (1-based, inclusive)' },
          new_text: { type: 'string', description: 'Replacement text (replaces the entire line range)' },
        },
        required: ['path', 'start_line', 'end_line', 'new_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Execute a shell command and return its output. Use for build, test, or diagnostic commands. Do NOT use find/grep/rg for file search — use search_files and list_directory instead (much faster).',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to execute' },
        },
        required: ['command'],
      },
    },
  },
];

// Read-only tool names — tasks that don't mention modification get only these.
// Keeping tool count ≤5 prevents qwen3-coder from switching to XML format.
const READ_ONLY_TOOL_NAMES = new Set(['read_file', 'list_directory', 'search_files']);
const WRITE_TOOL_NAMES = new Set(['write_file', 'edit_file', 'replace_lines']);
const MODIFICATION_KEYWORDS = /\b(create|add|write|implement|generate|edit|modify|change|update|refactor|rename|fix|remove|delete|replace|move|insert|append)\b/i;

/**
 * Select tools appropriate for a task. Read-only tasks get 3 tools (under the
 * ~5 tool threshold for reliable JSON tool calls). Modification tasks get all 7.
 * @param {string} taskDescription - The task prompt
 * @param {{ commandMode?: string, commandAllowlist?: string[], toolAllowlist?: string[] }} [options]
 * @returns {Array} Filtered TOOL_DEFINITIONS
 */
function selectToolsForTask(taskDescription, options = {}) {
  const baseTools = MODIFICATION_KEYWORDS.test(taskDescription || '')
    ? TOOL_DEFINITIONS
    : TOOL_DEFINITIONS.filter(t => READ_ONLY_TOOL_NAMES.has(t.function.name));
  const toolAllowlist = Array.isArray(options.toolAllowlist)
    ? options.toolAllowlist
      .map((toolName) => typeof toolName === 'string' ? toolName.trim() : '')
      .filter(Boolean)
    : null;
  const scopedTools = toolAllowlist
    ? TOOL_DEFINITIONS.filter((tool) => toolAllowlist.includes(tool.function.name))
    : baseTools;

  const commandMode = options.commandMode || 'allowlist';
  const commandAllowlist = Array.isArray(options.commandAllowlist) ? options.commandAllowlist.filter(Boolean) : [];
  if (commandMode === 'allowlist' && commandAllowlist.length === 0) {
    return scopedTools.filter((tool) => tool.function.name !== 'run_command');
  }

  return scopedTools;
}

/**
 * Resolve a path relative to the working directory and check whether it
 * falls within that directory.
 *
 * @param {string} filePath  - The path to resolve (relative or absolute)
 * @param {string} workingDir - The working directory to use as base and jail
 * @returns {{ resolvedPath: string, allowed: boolean }}
 */
function resolveSafePath(filePath, workingDir) {
  const normalizedWorking = path.resolve(workingDir);
  const resolved = path.resolve(workingDir, filePath);
  // Allow if resolved IS the working directory or is strictly inside it.
  // Use path separator suffix check to prevent prefix-collision
  // (e.g. /tmp/foo must not match /tmp/foobar).
  const allowed =
    resolved === normalizedWorking ||
    resolved.startsWith(normalizedWorking + path.sep);
  return { resolvedPath: resolved, allowed };
}

function normalizeScopedPaths(paths, workingDir) {
  if (!Array.isArray(paths) || paths.length === 0) return null;
  const resolvedPaths = [];
  const seen = new Set();
  for (const scope of paths) {
    if (typeof scope !== 'string') continue;
    const trimmed = scope.trim();
    if (!trimmed) continue;
    const resolved = path.resolve(workingDir, trimmed);
    const normalized = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    resolvedPaths.push(resolved);
  }
  return resolvedPaths.length > 0 ? resolvedPaths : null;
}

function isPathWithinScope(targetPath, scopePath) {
  const normalize = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const normalizedTarget = normalize(path.resolve(targetPath));
  const normalizedScope = normalize(path.resolve(scopePath));
  return normalizedTarget === normalizedScope || normalizedTarget.startsWith(normalizedScope + path.sep);
}

function isPathAllowedByScopes(targetPath, scopedPaths) {
  if (!Array.isArray(scopedPaths) || scopedPaths.length === 0) return true;
  return scopedPaths.some((scopePath) => isPathWithinScope(targetPath, scopePath));
}

/**
 * Truncate output to MAX_OUTPUT_BYTES with a marker.
 * @param {string} text
 * @returns {string}
 */
function truncateOutput(text) {
  if (text.length <= MAX_OUTPUT_BYTES) return text;
  return text.slice(0, MAX_OUTPUT_BYTES) + '\n[... output truncated]';
}

/**
 * Simple glob-to-extension check.
 * Supports patterns like "*.cs", "*.ts", "*.js".
 * If the pattern has no wildcard, falls back to exact filename match.
 *
 * @param {string} filename - The base filename to test
 * @param {string} globPattern - e.g. "*.cs"
 * @returns {boolean}
 */
function matchGlob(filename, globPattern) {
  if (!globPattern || globPattern === '*' || globPattern === '*.*') return true;
  // Handle "*.ext" pattern
  if (globPattern.startsWith('*.')) {
    const ext = globPattern.slice(1); // ".ext"
    return path.extname(filename) === ext;
  }
  // Fall back to exact match (e.g. "package.json")
  return filename === globPattern;
}

/**
 * Recursively search files under a directory for lines matching a regex pattern.
 * Pure Node.js — no grep, no findstr.
 *
 * @param {string} dir - Absolute directory path to search
 * @param {RegExp} regex - Compiled pattern
 * @param {string} [globFilter] - Optional glob filter (e.g. "*.cs")
 * @param {string[]} results - Accumulator for matches (mutated in place)
 * @param {number} maxMatches - Cap on total matches
 */
function searchRecursive(dir, regex, globFilter, results, maxMatches, visited = new Set()) {
  if (results.length >= maxMatches) return;

  // Symlink cycle detection: resolve real path and skip if already visited
  let realDir;
  try { realDir = fs.realpathSync(dir); } catch { return; }
  if (visited.has(realDir)) return;
  visited.add(realDir);

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // Skip unreadable directories
  }

  for (const entry of entries) {
    if (results.length >= maxMatches) break;
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // Skip hidden directories and common noise dirs
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'bin' || entry.name === 'obj' || entry.name === 'dist' || entry.name === 'build') continue;
      searchRecursive(fullPath, regex, globFilter, results, maxMatches, visited);
    } else if (entry.isFile()) {
      if (!matchGlob(entry.name, globFilter)) continue;

      let content;
      try {
        const stat = fs.statSync(fullPath);
        if (stat.size > MAX_FILE_READ_BYTES) continue; // Skip oversized files
        content = fs.readFileSync(fullPath, 'utf-8');
      } catch {
        continue; // Skip unreadable files
      }

      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (results.length >= maxMatches) break;
        if (regex.test(lines[i])) {
          results.push(`${fullPath}:${i + 1}: ${lines[i]}`);
        }
      }
    }
  }
}

/**
 * Validate a command against a list of allowlist patterns.
 * Pattern matching: '*' in a pattern matches any sequence of characters
 * (simple glob, not regex).
 *
 * @param {string} command - The command to check
 * @param {string[]} allowlist - Array of glob patterns
 * @returns {boolean} true if the command is allowed
 */
function isCommandAllowed(command, allowlist) {
  // ALWAYS check dangerous commands regardless of allowlist mode
  const ALWAYS_BLOCKED = ['rm -rf /', 'mkfs', 'dd if=', ':(){', 'fork bomb'];
  const cmdLower = command.toLowerCase();
  if (ALWAYS_BLOCKED.some(b => cmdLower.includes(b))) {
    return false;
  }
  // Reject dangerous shell chaining operators to prevent command injection.
  // Blocks: ; (chain), | (pipe), & (background/AND), ` (backtick subshell),
  // >> (append redirect). Allows: quotes, (), $, {} in arguments (needed for
  // node -e "...", dotnet test --filter "...", etc.)
  if (/[;|&`]|>\s*>/.test(command)) {
    return false;
  }
  for (const pattern of allowlist) {
    if (pattern === '*') return true;
    // Convert the simple glob to a regex:
    // Escape regex special chars except *, then replace * with .*
    const escaped = pattern.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*');
    const regex = new RegExp(`^${escaped}$`);
    if (regex.test(command)) return true;
  }
  return false;
}

/**
 * Create a tool executor bound to a working directory.
 *
 * @param {string} workingDir - The working directory for all tool operations
 * @param {Object} [options]
 * @param {string} [options.commandMode='allowlist'] - 'unrestricted' | 'allowlist'
 * @param {string[]} [options.commandAllowlist=[]] - Allowed command patterns when commandMode='allowlist'
 * @param {string[]} [options.writeAfterReadPaths=[]] - Once all of these paths have been read successfully, the next tool call must be a write tool until a file is modified.
 * @returns {{ execute(name: string, args: Object): { result: string, error?: boolean, metadata?: Object }, changedFiles: Set }}
 */
function createToolExecutor(workingDir, options = {}) {
  const changedFiles = new Set();
  const commandMode = options.commandMode || 'allowlist';
  const commandAllowlist = options.commandAllowlist || [];
  const readAllowlist = normalizeScopedPaths(options.readAllowlist, workingDir);
  const writeAllowlist = normalizeScopedPaths(options.writeAllowlist, workingDir);
  const writeAfterReadPaths = normalizeScopedPaths(options.writeAfterReadPaths, workingDir);
  const parsedDiagnosticReadLimitAfterFailedCommand = Number.parseInt(options.diagnosticReadLimitAfterFailedCommand, 10);
  const diagnosticReadLimitAfterFailedCommand = Number.isFinite(parsedDiagnosticReadLimitAfterFailedCommand)
    && parsedDiagnosticReadLimitAfterFailedCommand > 0
    ? parsedDiagnosticReadLimitAfterFailedCommand
    : 0;
  const writeAfterReadScopeKeys = new Set(
    Array.isArray(writeAfterReadPaths)
      ? writeAfterReadPaths.map((scopePath) => (process.platform === 'win32' ? scopePath.toLowerCase() : scopePath))
      : []
  );
  const satisfiedWriteAfterReadScopes = new Set();
  let pendingWriteAfterFailedCommand = false;
  let remainingDiagnosticReadsAfterFailedCommand = 0;

  function markReadScopeSatisfied(resolvedPath) {
    if (!Array.isArray(writeAfterReadPaths) || writeAfterReadPaths.length === 0) return;
    for (const scopePath of writeAfterReadPaths) {
      if (!isPathWithinScope(resolvedPath, scopePath)) continue;
      const scopeKey = process.platform === 'win32' ? scopePath.toLowerCase() : scopePath;
      satisfiedWriteAfterReadScopes.add(scopeKey);
    }
  }

  function mustWriteBeforeContinuing(toolName) {
    if (!Array.isArray(writeAfterReadPaths) || writeAfterReadScopeKeys.size === 0) return false;
    if (changedFiles.size > 0) return false;
    if (satisfiedWriteAfterReadScopes.size < writeAfterReadScopeKeys.size) return false;
    return !WRITE_TOOL_NAMES.has(toolName);
  }

  function enterFailedCommandRecoveryMode() {
    pendingWriteAfterFailedCommand = true;
    remainingDiagnosticReadsAfterFailedCommand = diagnosticReadLimitAfterFailedCommand;
  }

  function clearFailedCommandRecoveryMode() {
    pendingWriteAfterFailedCommand = false;
    remainingDiagnosticReadsAfterFailedCommand = 0;
  }

  function enforceFailedCommandRecoveryMode(toolName) {
    if (!pendingWriteAfterFailedCommand) return null;
    if (WRITE_TOOL_NAMES.has(toolName)) return null;
    if (toolName === 'read_file' && remainingDiagnosticReadsAfterFailedCommand > 0) {
      remainingDiagnosticReadsAfterFailedCommand -= 1;
      return null;
    }

    const readBudgetMessage = diagnosticReadLimitAfterFailedCommand > 0
      ? `You may use at most ${diagnosticReadLimitAfterFailedCommand} diagnostic read_file call(s) after a failed command, and that allowance is exhausted.`
      : 'No diagnostic read_file calls are allowed after a failed command for this task.';
    return {
      result: `Error: verification recovery mode is active. ${readBudgetMessage} Your next tool call must modify a file with write_file, edit_file, or replace_lines.`,
      error: true,
    };
  }

  function execute(toolName, args) {
    try {
      const failedCommandRecoveryResult = enforceFailedCommandRecoveryMode(toolName);
      if (failedCommandRecoveryResult) {
        return failedCommandRecoveryResult;
      }
      if (mustWriteBeforeContinuing(toolName)) {
        return {
          result: 'Error: initial read phase is complete. Your next tool call must modify a file with write_file, edit_file, or replace_lines before any more reads or commands.',
          error: true,
        };
      }
      switch (toolName) {
        case 'read_file': {
          const { resolvedPath, allowed } = resolveSafePath(args.path, workingDir);
          // Block relative paths that escape the working directory via ../
          if (!path.isAbsolute(args.path) && !allowed) {
            return {
              result: `Error: path traversal detected — relative path resolves outside working directory: ${args.path}`,
              error: true,
            };
          }
          if (!isPathAllowedByScopes(resolvedPath, readAllowlist)) {
            return {
              result: `Error: read path is outside the allowed scope: ${args.path}`,
              error: true,
            };
          }
          if (!fs.existsSync(resolvedPath)) {
            return { result: `Error: File not found: ${args.path}`, error: true };
          }
          const stat = fs.statSync(resolvedPath);
          if (stat.size > MAX_FILE_READ_BYTES) {
            return { result: `Error: File too large (${stat.size} bytes, max ${MAX_FILE_READ_BYTES}).`, error: true };
          }
          const content = fs.readFileSync(resolvedPath, 'utf-8');
          const allLines = content.split('\n');
          const startLine = parseInt(args.start_line, 10) || 1;
          const endLine = parseInt(args.end_line, 10) || allLines.length;
          const clampedStart = Math.max(1, Math.min(startLine, allLines.length));
          const clampedEnd = Math.max(clampedStart, Math.min(endLine, allLines.length));
          const sliced = allLines.slice(clampedStart - 1, clampedEnd);
          const numbered = sliced.map((line, i) => `${clampedStart + i}\t${line}`).join('\n');
          const rangeNote = (clampedStart > 1 || clampedEnd < allLines.length)
            ? `[Showing lines ${clampedStart}-${clampedEnd} of ${allLines.length}]\n`
            : '';
          markReadScopeSatisfied(resolvedPath);
          return { result: truncateOutput(rangeNote + numbered) };
        }

        case 'write_file': {
          if (typeof args.content !== 'string') {
            return { result: null, error: 'content must be a string' };
          }
          const { resolvedPath, allowed } = resolveSafePath(args.path, workingDir);
          if (!allowed) {
            return {
              result: `Error: path resolves outside working directory: ${resolvedPath}`,
              error: true,
            };
          }
          if (!isPathAllowedByScopes(resolvedPath, writeAllowlist)) {
            return {
              result: `Error: write path is outside the allowed scope: ${args.path}`,
              error: true,
            };
          }
          const dir = path.dirname(resolvedPath);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          fs.writeFileSync(resolvedPath, args.content, 'utf-8');
          changedFiles.add(resolvedPath);
          clearFailedCommandRecoveryMode();
          return { result: `File written: ${args.path} (${args.content.length} bytes)` };
        }

        case 'edit_file': {
          const { resolvedPath, allowed } = resolveSafePath(args.path, workingDir);
          if (!allowed) {
            return {
              result: `Error: path resolves outside working directory: ${resolvedPath}`,
              error: true,
            };
          }
          if (!isPathAllowedByScopes(resolvedPath, writeAllowlist)) {
            return {
              result: `Error: write path is outside the allowed scope: ${args.path}`,
              error: true,
            };
          }
          if (!fs.existsSync(resolvedPath)) {
            return { result: `Error: File not found: ${args.path}`, error: true };
          }
          const content = fs.readFileSync(resolvedPath, 'utf-8');

          if (args.replace_all) {
            // Replace all occurrences, return metadata.replacements count
            const occurrences = content.split(args.old_text).length - 1;
            if (occurrences === 0) {
              // Whitespace-normalized fallback for replace_all
              try {
                const wsMatch = findWhitespaceNormalizedMatch(args.old_text, content);
                if (wsMatch) {
                  const oldLines = args.old_text.split('\n').map(l => l.trimStart());
                  const fileLines = content.split('\n');
                  const normalizedFileLines = fileLines.map(l => l.trimStart());
                  let replacements = 0;
                  const resultLines = [];
                  let i = 0;
                  while (i < fileLines.length) {
                    let matched = true;
                    if (i <= fileLines.length - oldLines.length) {
                      for (let j = 0; j < oldLines.length; j++) {
                        if (normalizedFileLines[i + j] !== oldLines[j]) {
                          matched = false;
                          break;
                        }
                      }
                    } else {
                      matched = false;
                    }
                    if (matched) {
                      const firstNonBlank = fileLines.slice(i, i + oldLines.length).find(l => l.trim().length > 0);
                      const indent = firstNonBlank ? firstNonBlank.match(/^(\s*)/)[1] : '';
                      resultLines.push(...reindentNewText(args.new_text, indent).split('\n'));
                      i += oldLines.length;
                      replacements++;
                    } else {
                      resultLines.push(fileLines[i]);
                      i++;
                    }
                  }
                  if (replacements > 0) {
                    fs.writeFileSync(resolvedPath, resultLines.join('\n'), 'utf-8');
                    changedFiles.add(resolvedPath);
                    clearFailedCommandRecoveryMode();
                    return {
                      result: `Edit applied to ${args.path} (${replacements} replacement${replacements !== 1 ? 's' : ''}, matched with normalized whitespace)`,
                      metadata: { replacements },
                    };
                  }
                }
              } catch { /* fall through to error */ }

              const lines = content.split('\n');
              const preview = lines.slice(0, Math.min(30, lines.length)).join('\n');
              return {
                result: `Error: old_text not found in ${args.path}. First 30 lines:\n${preview}`,
                error: true,
              };
            }
            const newContent = content.split(args.old_text).join(args.new_text);
            fs.writeFileSync(resolvedPath, newContent, 'utf-8');
            changedFiles.add(resolvedPath);
            clearFailedCommandRecoveryMode();
            return {
              result: `Edit applied to ${args.path} (${occurrences} replacement${occurrences !== 1 ? 's' : ''})`,
              metadata: { replacements: occurrences },
            };
          } else {
            // Exact single-match mode.
            // When old_text starts with whitespace, require line-boundary alignment:
            // the match must start at the beginning of the file or immediately after
            // a newline. This prevents '  foo();' from matching inside '    foo();'
            // as a substring of a more-indented line.
            const oldTextStartsWithWhitespace = /^\s/.test(args.old_text);
            let idx = -1;
            if (oldTextStartsWithWhitespace) {
              let searchFrom = 0;
              while (searchFrom <= content.length - args.old_text.length) {
                const found = content.indexOf(args.old_text, searchFrom);
                if (found === -1) break;
                if (found === 0 || content[found - 1] === '\n') {
                  idx = found;
                  break;
                }
                searchFrom = found + 1;
              }
            } else {
              idx = content.indexOf(args.old_text);
            }
            if (idx === -1) {
              // Tier 1: whitespace-normalized fallback
              try {
                const wsMatch = findWhitespaceNormalizedMatch(args.old_text, content);
                if (wsMatch) {
                  const fileLines = content.split('\n');
                  // Re-indent new_text lines using per-line file indentation.
                  // This preserves the exact tab/space style of each file line.
                  const newLines = args.new_text.split('\n');
                  const reindentedLines = newLines.map((newLine, i) => {
                    if (!newLine.trim()) return newLine; // preserve blank lines
                    const fileLineIndent = wsMatch.lineIndents[Math.min(i, wsMatch.lineCount - 1)];
                    return fileLineIndent + newLine.trimStart();
                  });
                  const before = fileLines.slice(0, wsMatch.startLine);
                  const after = fileLines.slice(wsMatch.startLine + wsMatch.lineCount);
                  const newContent = [...before, ...reindentedLines, ...after].join('\n');
                  fs.writeFileSync(resolvedPath, newContent, 'utf-8');
                  changedFiles.add(resolvedPath);
                  clearFailedCommandRecoveryMode();
                  return {
                    result: `Edit applied to ${args.path} (matched with normalized whitespace)`,
                  };
                }
              } catch (wsErr) {
                if (wsErr.code === 'MULTIPLE_MATCHES') {
                  return {
                    result: `Error: old_text matches multiple locations in ${args.path} after whitespace normalization. Provide more surrounding context to make the match unique.`,
                    error: true,
                  };
                }
              }

              // Tier 2: fuzzy matching
              const fuzzyMatch = findFuzzyMatch(args.old_text, content);
              if (fuzzyMatch) {
                const fileLines = content.split('\n');
                const reindented = reindentNewText(args.new_text, fuzzyMatch.fileIndent);
                const before = fileLines.slice(0, fuzzyMatch.startLine);
                const after = fileLines.slice(fuzzyMatch.startLine + fuzzyMatch.lineCount);
                const newContent = [...before, ...reindented.split('\n'), ...after].join('\n');
                fs.writeFileSync(resolvedPath, newContent, 'utf-8');
                changedFiles.add(resolvedPath);
                clearFailedCommandRecoveryMode();
                return {
                  result: `Edit applied to ${args.path} (fuzzy match at ${(fuzzyMatch.score * 100).toFixed(1)}% similarity)`,
                };
              }

              const lines = content.split('\n');
              const preview = lines.slice(0, Math.min(30, lines.length)).join('\n');
              return {
                result: `Error: old_text not found in ${args.path}. Include more context or check indentation. First 30 lines:\n${preview}`,
                error: true,
              };
            }
            // Find second match (line-boundary-aware when old_text starts with whitespace)
            let secondIdx = -1;
            if (oldTextStartsWithWhitespace) {
              let searchFrom2 = idx + 1;
              while (searchFrom2 <= content.length - args.old_text.length) {
                const found2 = content.indexOf(args.old_text, searchFrom2);
                if (found2 === -1) break;
                if (found2 === 0 || content[found2 - 1] === '\n') {
                  secondIdx = found2;
                  break;
                }
                searchFrom2 = found2 + 1;
              }
            } else {
              secondIdx = content.indexOf(args.old_text, idx + 1);
            }
            if (secondIdx !== -1) {
              return {
                result: `Error: old_text matches multiple locations in ${args.path}. Use replace_all=true or provide more surrounding context to make the match unique.`,
                error: true,
              };
            }
            // Indentation normalization: use reindentNewText (prefix-replacement)
            // to fix LLMs that send new_text with wrong base indentation.
            const oldFirstNonBlank = args.old_text.split('\n').find(l => l.trim().length > 0);
            const oldIndent = oldFirstNonBlank ? oldFirstNonBlank.match(/^(\s*)/)[1] : '';
            const finalNewText = reindentNewText(args.new_text, oldIndent);
            const newContent = content.slice(0, idx) + finalNewText + content.slice(idx + args.old_text.length);
            fs.writeFileSync(resolvedPath, newContent, 'utf-8');
            changedFiles.add(resolvedPath);
            clearFailedCommandRecoveryMode();
            return { result: `Edit applied to ${args.path}` };
          }
        }

        case 'replace_lines': {
          const { resolvedPath, allowed } = resolveSafePath(args.path, workingDir);
          if (!allowed) {
            return { result: `Error: path resolves outside working directory: ${resolvedPath}`, error: true };
          }
          if (!isPathAllowedByScopes(resolvedPath, writeAllowlist)) {
            return {
              result: `Error: write path is outside the allowed scope: ${args.path}`,
              error: true,
            };
          }
          if (!fs.existsSync(resolvedPath)) {
            return { result: `Error: File not found: ${args.path}`, error: true };
          }
          const startLine = parseInt(args.start_line, 10);
          const endLine = parseInt(args.end_line, 10);
          if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
            return { result: `Error: invalid line range ${startLine}-${endLine} (must be 1-based, start <= end)`, error: true };
          }
          const fileLines = fs.readFileSync(resolvedPath, 'utf-8').split('\n');
          if (endLine > fileLines.length) {
            return { result: `Error: end_line ${endLine} exceeds file length (${fileLines.length} lines)`, error: true };
          }
          const newLines = args.new_text.split('\n');
          const before = fileLines.slice(0, startLine - 1);
          const after = fileLines.slice(endLine);
          fs.writeFileSync(resolvedPath, [...before, ...newLines, ...after].join('\n'), 'utf-8');
          changedFiles.add(resolvedPath);
          clearFailedCommandRecoveryMode();
          return { result: `Replaced lines ${startLine}-${endLine} (${endLine - startLine + 1} lines) with ${newLines.length} lines in ${args.path}` };
        }

        case 'list_directory': {
          const dirPath = args.path || '.';
          const { resolvedPath, allowed } = resolveSafePath(dirPath, workingDir);
          // Block relative paths that escape the working directory via ../
          if (!path.isAbsolute(dirPath) && !allowed) {
            return {
              result: `Error: path traversal detected — relative path resolves outside working directory: ${dirPath}`,
              error: true,
            };
          }
          if (!isPathAllowedByScopes(resolvedPath, readAllowlist)) {
            return {
              result: `Error: list path is outside the allowed scope: ${dirPath}`,
              error: true,
            };
          }
          if (!fs.existsSync(resolvedPath)) {
            return { result: `Error: Directory not found: ${args.path}`, error: true };
          }
          const entries = fs.readdirSync(resolvedPath, { withFileTypes: true });
          const dirs = entries.filter(e => e.isDirectory());
          const files = entries.filter(e => !e.isDirectory());
          const parts = [];
          if (dirs.length > 0) {
            parts.push(`Directories (${dirs.length}):`);
            dirs.forEach(e => parts.push(`  ${e.name}/`));
          }
          if (files.length > 0) {
            parts.push(`Files (${files.length}):`);
            files.forEach(e => {
              try {
                const size = fs.statSync(path.join(resolvedPath, e.name)).size;
                parts.push(size > 1024 ? `  ${e.name} (${(size/1024).toFixed(1)}KB)` : `  ${e.name}`);
              } catch { parts.push(`  ${e.name}`); }
            });
          }
          const listing = parts.join('\n');
          return { result: truncateOutput(listing) || '(empty directory)', metadata: { directories: dirs.length, files: files.length } };
        }

        case 'search_files': {
          const searchPath = args.path || '.';
          const { resolvedPath, allowed } = resolveSafePath(searchPath, workingDir);
          // Block relative paths that escape the working directory via ../
          if (!path.isAbsolute(searchPath) && !allowed) {
            return {
              result: `Error: path traversal detected — relative path resolves outside working directory: ${searchPath}`,
              error: true,
            };
          }
          if (!isPathAllowedByScopes(resolvedPath, readAllowlist)) {
            return {
              result: `Error: search path is outside the allowed scope: ${searchPath}`,
              error: true,
            };
          }
          const globFilter = args.glob || '*';

          if (!isSafeRegex(args.pattern)) {
            return { error: 'Unsafe regex pattern' };
          }

          let regex;
          try {
            regex = new RegExp(args.pattern);
          } catch (e) {
            return { result: `Error: Invalid regex pattern: ${e.message}`, error: true };
          }

          const results = [];
          searchRecursive(resolvedPath, regex, globFilter, results, 100);

          if (results.length === 0) return { result: 'No matches found.' };
          return { result: truncateOutput(results.join('\n')) };
        }

        case 'run_command': {
          // Validate against allowlist if in allowlist mode
          if (commandMode === 'allowlist') {
            if (!isCommandAllowed(args.command, commandAllowlist)) {
              return {
                result: `Error: Command not in allowlist: ${args.command}`,
                error: true,
              };
            }
          }

          try {
            // SECURITY: shell: true is required for commands with quotes, pipes,
            // and complex arguments (e.g., node -e "..."). Injection is prevented
            // by isCommandAllowed() above which rejects shell metacharacters
            // (;|&`$(){}!<>) and dangerous command patterns before reaching here.
            const { execSync } = require('child_process');
            const output = execSync(args.command, {
              cwd: workingDir,
              timeout: MAX_COMMAND_TIMEOUT_MS,
              maxBuffer: MAX_OUTPUT_BYTES * 2,
              encoding: 'utf-8',
              shell: true,
              windowsHide: true,
            });
            clearFailedCommandRecoveryMode();
            return { result: truncateOutput(output) || '(no output)' };
          } catch (e) {
            const stderr = e.stderr ? e.stderr.toString() : '';
            const stdout = e.stdout ? e.stdout.toString() : '';
            enterFailedCommandRecoveryMode();
            return {
              result: truncateOutput(`Command failed (exit ${e.status}):\n${stdout}\n${stderr}`),
              error: true,
            };
          }
        }

        default:
          return { result: `Error: Unknown tool '${toolName}'`, error: true };
      }
    } catch (e) {
      logger.info(`[Tools] Tool '${toolName}' threw: ${e.message}`);
      return { result: `Error executing ${toolName}: ${e.message}`, error: true };
    }
  }

  return { execute, changedFiles };
}

/**
 * Legacy functional interface — kept for backward compatibility.
 * Prefer createToolExecutor() for new code.
 *
 * @deprecated Use createToolExecutor(workingDir, options).execute(toolName, args) instead.
 */
function executeTool(toolName, args, workingDir, options = {}) {
  // Create a shared changedFiles set if one is provided in options, otherwise fresh
  const executor = createToolExecutor(workingDir, options);
  // Merge any pre-existing changedFiles
  if (options.changedFiles) {
    for (const f of executor.changedFiles) options.changedFiles.add(f);
  }
  const result = executor.execute(toolName, args);
  // Copy newly tracked files back to caller's set
  if (options.changedFiles) {
    for (const f of executor.changedFiles) options.changedFiles.add(f);
  }
  return result;
}

/**
 * Parse tool calls from model response.
 * Handles structured tool_calls field, <tool_call> XML tags, raw JSON in content,
 * and JSON in markdown code blocks.
 *
 * Priority order:
 *   1. Structured tool_calls field (OpenAI-format)
 *   2. <tool_call> XML tags (Qwen2.5 native format)
 *   3. Raw JSON object with "name" key
 *   4. JSON in markdown code blocks
 *
 * @param {Object} message - The assistant message from Ollama
 * @returns {Array<{name: string, arguments: Object}>}
 */
function parseToolCalls(message) {
  // Priority 1: Structured tool_calls field
  if (message.tool_calls && message.tool_calls.length > 0) {
    return message.tool_calls.map(tc => ({
      id: tc.id || undefined, // Preserve tool_call_id for OpenAI-compatible APIs
      name: tc.function.name,
      arguments: typeof tc.function.arguments === 'string'
        ? JSON.parse(tc.function.arguments)
        : tc.function.arguments,
    }));
  }

  const content = (message.content || '').trim();
  if (!content) return [];

  // Priority 2: <tool_call> XML tags (qwen2.5 native format)
  const toolCallTagRegex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  const tagMatches = [];
  let match;
  while ((match = toolCallTagRegex.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed.name) {
        tagMatches.push({ name: parsed.name, arguments: parsed.arguments || {} });
      }
    } catch { /* skip malformed */ }
  }
  if (tagMatches.length > 0) return tagMatches;

  // Priority 2b: <function=name> XML tags (alternate format some models emit)
  // Format: <function=tool_name>\n<parameter=key>\nvalue\n</parameter>\n</function>
  const funcTagRegex = /<function=(\w+)>([\s\S]*?)<\/function>/g;
  const funcMatches = [];
  while ((match = funcTagRegex.exec(content)) !== null) {
    const name = match[1];
    const body = match[2].trim();
    const args = {};
    const paramRegex = /<parameter=(\w+)>\s*([\s\S]*?)\s*<\/parameter>/g;
    let paramMatch;
    while ((paramMatch = paramRegex.exec(body)) !== null) {
      args[paramMatch[1]] = paramMatch[2].trim();
    }
    if (name) funcMatches.push({ name, arguments: args });
  }
  if (funcMatches.length > 0) return funcMatches;

  // Priority 3: Raw JSON object or array with "name" and "arguments" keys
  try {
    const parsed = JSON.parse(content);
    // Single object: {"name": "...", "arguments": {...}}
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.name && typeof parsed.name === 'string') {
      return [{ id: parsed.id, name: parsed.name, arguments: parsed.arguments || {} }];
    }
    // Array of objects: [{"name": "...", "arguments": {...}}, ...]
    if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].name) {
      return parsed.filter(tc => tc.name && typeof tc.name === 'string').map(tc => ({
        id: tc.id, name: tc.name, arguments: tc.arguments || {},
      }));
    }
  } catch {
    // Priority 3b: Newline-separated JSON objects (models that emit multiple tool
    // calls as separate JSON objects on separate lines instead of an array)
    const lines = content.split('\n').map(l => l.trim()).filter(l => l.startsWith('{'));
    if (lines.length > 0) {
      const ndjsonCalls = [];
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.name && typeof parsed.name === 'string') {
            ndjsonCalls.push({ id: parsed.id, name: parsed.name, arguments: parsed.arguments || {} });
          }
        } catch { /* skip malformed */ }
      }
      if (ndjsonCalls.length > 0) return ndjsonCalls;
    }
  }

  // Priority 4: JSON in markdown code blocks (```json ... ``` or ``` ... ```)
  const codeBlockRegex = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/g;
  const codeMatches = [];
  while ((match = codeBlockRegex.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed.name && typeof parsed.name === 'string') {
        codeMatches.push({ name: parsed.name, arguments: parsed.arguments || {} });
      }
    } catch { /* skip */ }
  }
  if (codeMatches.length > 0) return codeMatches;

  return [];
}

module.exports = {
  TOOL_DEFINITIONS,
  selectToolsForTask,
  createToolExecutor,
  executeTool,       // legacy compat
  parseToolCalls,
  resolveSafePath,
  reindentNewText,
  findWhitespaceNormalizedMatch,
  findFuzzyMatch,
  IS_WINDOWS,
  MAX_FILE_READ_BYTES,
  MAX_COMMAND_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
};
