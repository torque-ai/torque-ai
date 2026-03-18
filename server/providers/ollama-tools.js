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
 * external paths (read-only operations are safe).
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const logger = require('../logger').child({ component: 'ollama-tools' });

// Safety limits
const MAX_FILE_READ_BYTES = 512 * 1024; // 512KB per file read
const MAX_COMMAND_TIMEOUT_MS = 30_000;   // 30s per command
const MAX_OUTPUT_BYTES = 128 * 1024;     // 128KB per tool result

// Platform detection — cached at module load
const IS_WINDOWS = process.platform === 'win32';

/**
 * Tool definitions in OpenAI / Ollama function-calling format.
 */
const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file. Returns the file text with line numbers.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (relative to working directory or absolute)' },
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
      name: 'run_command',
      description: 'Execute a shell command and return its output. Use for build, test, or diagnostic commands.',
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
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
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
  // Refuse particularly dangerous commands even with wildcard allowlist
  if (allowlist.includes('*')) {
    const ALWAYS_BLOCKED = ['rm -rf /', 'mkfs', 'dd if=', ':(){', 'fork bomb'];
    const cmdLower = command.toLowerCase();
    if (ALWAYS_BLOCKED.some(b => cmdLower.includes(b))) {
      return false;
    }
  }
  for (const pattern of allowlist) {
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
 * @param {string} [options.commandMode='unrestricted'] - 'unrestricted' | 'allowlist'
 * @param {string[]} [options.commandAllowlist=[]] - Allowed command patterns when commandMode='allowlist'
 * @returns {{ execute(name: string, args: Object): { result: string, error?: boolean, metadata?: Object }, changedFiles: Set }}
 */
function createToolExecutor(workingDir, options = {}) {
  const changedFiles = new Set();
  const commandMode = options.commandMode || 'unrestricted';
  const commandAllowlist = options.commandAllowlist || [];

  function execute(toolName, args) {
    try {
      switch (toolName) {
        case 'read_file': {
          const { resolvedPath } = resolveSafePath(args.path, workingDir);
          if (!fs.existsSync(resolvedPath)) {
            return { result: `Error: File not found: ${args.path}`, error: true };
          }
          const stat = fs.statSync(resolvedPath);
          if (stat.size > MAX_FILE_READ_BYTES) {
            return { result: `Error: File too large (${stat.size} bytes, max ${MAX_FILE_READ_BYTES}).`, error: true };
          }
          const content = fs.readFileSync(resolvedPath, 'utf-8');
          const numbered = content.split('\n').map((line, i) => `${i + 1}\t${line}`).join('\n');
          return { result: truncateOutput(numbered) };
        }

        case 'write_file': {
          const { resolvedPath, allowed } = resolveSafePath(args.path, workingDir);
          if (!allowed) {
            return {
              result: `Error: path resolves outside working directory: ${resolvedPath}`,
              error: true,
            };
          }
          const dir = path.dirname(resolvedPath);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          fs.writeFileSync(resolvedPath, args.content, 'utf-8');
          changedFiles.add(resolvedPath);
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
          if (!fs.existsSync(resolvedPath)) {
            return { result: `Error: File not found: ${args.path}`, error: true };
          }
          const content = fs.readFileSync(resolvedPath, 'utf-8');

          if (args.replace_all) {
            // Replace all occurrences, return metadata.replacements count
            const occurrences = content.split(args.old_text).length - 1;
            if (occurrences === 0) {
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
            return {
              result: `Edit applied to ${args.path} (${occurrences} replacement${occurrences !== 1 ? 's' : ''})`,
              metadata: { replacements: occurrences },
            };
          } else {
            // Exact single-match mode
            const idx = content.indexOf(args.old_text);
            if (idx === -1) {
              const lines = content.split('\n');
              const preview = lines.slice(0, Math.min(30, lines.length)).join('\n');
              return {
                result: `Error: old_text not found in ${args.path}. First 30 lines:\n${preview}`,
                error: true,
              };
            }
            const secondIdx = content.indexOf(args.old_text, idx + 1);
            if (secondIdx !== -1) {
              return {
                result: `Error: old_text matches multiple locations in ${args.path}. Use replace_all=true or provide more surrounding context to make the match unique.`,
                error: true,
              };
            }
            const newContent = content.slice(0, idx) + args.new_text + content.slice(idx + args.old_text.length);
            fs.writeFileSync(resolvedPath, newContent, 'utf-8');
            changedFiles.add(resolvedPath);
            return { result: `Edit applied to ${args.path}` };
          }
        }

        case 'list_directory': {
          const { resolvedPath } = resolveSafePath(args.path || '.', workingDir);
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
          const { resolvedPath } = resolveSafePath(args.path || '.', workingDir);
          const globFilter = args.glob || '*';

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
            const output = execSync(args.command, {
              cwd: workingDir,
              timeout: MAX_COMMAND_TIMEOUT_MS,
              maxBuffer: MAX_OUTPUT_BYTES * 2,
              encoding: 'utf-8',
              shell: true, // Node picks platform shell automatically (cmd.exe on Win, /bin/sh on Unix)
            });
            return { result: truncateOutput(output) || '(no output)' };
          } catch (e) {
            const stderr = e.stderr ? e.stderr.toString() : '';
            const stdout = e.stdout ? e.stdout.toString() : '';
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
  } catch { /* not JSON */ }

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
  createToolExecutor,
  executeTool,       // legacy compat
  parseToolCalls,
  resolveSafePath,
  IS_WINDOWS,
  MAX_FILE_READ_BYTES,
  MAX_COMMAND_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
};
