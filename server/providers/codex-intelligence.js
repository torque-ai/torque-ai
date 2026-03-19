'use strict';

/**
 * Codex Intelligence Module
 *
 * Local system intelligence for Codex provider tasks.
 * Offloads analysis to the local system instead of the LLM:
 * 1. Project type detection — package.json, tsconfig, language, framework
 * 2. Pre-task analysis — existing type/syntax errors in target files
 * 3. Lightweight file context — paths + sizes + key exports (not full contents)
 * 4. Enriched prompt builder — structured prompt with all intelligence
 *
 * "Not all intelligence needs to be handled by the LLM."
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const logger = require('../logger').child({ component: 'codex-intelligence' });
const serverConfig = require('../config');
const { BASE_LLM_RULES } = require('../constants');

// Dependency injection
let db = null;
let _promptsModule = null;

function init(deps) {
  if (deps.db) db = deps.db;
  serverConfig.init({ db: deps.db });
  if (deps.prompts) _promptsModule = deps.prompts;
}

// ─── 1. Project Type Detection ──────────────────────────────────────────

/**
 * Detect project type, language, test framework, and build tool from local files.
 * Pure filesystem analysis — no LLM required.
 * @param {string} workingDir - Project root
 * @returns {{ type: string, language: string, testFramework: string|null, buildTool: string|null, hasTypeScript: boolean }}
 */
function detectProjectInfo(workingDir) {
  if (!workingDir) return { type: 'unknown', language: 'unknown', testFramework: null, buildTool: null, hasTypeScript: false };

  const info = { type: 'unknown', language: 'unknown', testFramework: null, buildTool: null, hasTypeScript: false };

  // Check for tsconfig.json first (affects language detection)
  try {
    if (fs.existsSync(path.join(workingDir, 'tsconfig.json'))) {
      info.hasTypeScript = true;
      info.language = 'typescript';
    }
  } catch { /* skip */ }

  // Check for package.json (Node.js)
  try {
    const pkgPath = path.join(workingDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      info.type = 'node';
      if (!info.hasTypeScript) info.language = 'javascript';

      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

      // Detect test framework
      if (allDeps.vitest) info.testFramework = 'vitest';
      else if (allDeps.jest) info.testFramework = 'jest';
      else if (allDeps.mocha) info.testFramework = 'mocha';
      else if (allDeps.ava) info.testFramework = 'ava';

      // Detect build tool
      if (allDeps.vite) info.buildTool = 'vite';
      else if (allDeps.webpack) info.buildTool = 'webpack';
      else if (allDeps.esbuild) info.buildTool = 'esbuild';
      else if (allDeps.rollup) info.buildTool = 'rollup';

      if (allDeps.typescript) info.hasTypeScript = true;
    }
  } catch { /* skip */ }

  // Check other project types if not already identified
  if (info.type === 'unknown') {
    try {
      if (fs.existsSync(path.join(workingDir, 'Cargo.toml'))) {
        info.type = 'rust'; info.language = 'rust';
      } else if (fs.existsSync(path.join(workingDir, 'go.mod'))) {
        info.type = 'go'; info.language = 'go';
      } else if (fs.existsSync(path.join(workingDir, 'pyproject.toml')) ||
                 fs.existsSync(path.join(workingDir, 'requirements.txt'))) {
        info.type = 'python'; info.language = 'python';
      }
    } catch { /* skip */ }
  }

  return info;
}

// ─── 2. Pre-Task Analysis ───────────────────────────────────────────────

/**
 * Run local pre-analysis on target files before Codex starts.
 * Detects existing type errors and gathers file metadata.
 * @param {string} workingDir - Project root
 * @param {string[]} filePaths - Relative paths of target files
 * @returns {{ existingErrors: string[], fileInfo: Array<{path: string, lines: number, size: number, exports: string[]}> }}
 */
function runPreAnalysis(workingDir, filePaths) {
  const result = { existingErrors: [], fileInfo: [] };
  if (!workingDir || !filePaths || filePaths.length === 0) return result;

  // Run tsc --noEmit if TypeScript project (configurable).
  // Pre-analysis is enabled when db is available AND the config flag is set.
  // The previous `!db` form was inverted: it enabled pre-analysis when db was
  // absent, which is the opposite of the intent (no db = no config to read).
  const preAnalysisEnabled = db && serverConfig.getBool('codex_pre_analysis');
  if (preAnalysisEnabled) {
    const hasTsConfig = safeExists(path.join(workingDir, 'tsconfig.json'));
    if (hasTsConfig) {
      const tsFiles = filePaths.filter(f => /\.(ts|tsx)$/.test(f));
      if (tsFiles.length > 0) {
        try {
          const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
          execFileSync(npxCmd, ['tsc', '--noEmit', '--pretty', 'false'], {
            cwd: workingDir,
            encoding: 'utf8',
            timeout: 30000,
            windowsHide: true
          });
        } catch (e) {
          if (e.stdout) {
            // Extract only errors in target files
            const targetBases = new Set(filePaths.map(f => path.basename(f)));
            const errors = e.stdout.split('\n')
              .filter(line => {
                if (!line.includes('error TS')) return false;
                // Only include errors from target files or their immediate dependencies
                return filePaths.some(f => line.includes(f)) ||
                       [...targetBases].some(b => line.includes(b));
              })
              .slice(0, 10);
            result.existingErrors.push(...errors);
          }
        }
      }
    }
  }

  // Gather file info (sizes, line counts, key exports)
  for (const filePath of filePaths) {
    const fullPath = path.resolve(workingDir, filePath);
    try {
      const stat = fs.statSync(fullPath);
      const content = fs.readFileSync(fullPath, 'utf8');
      const lineCount = content.split('\n').length;
      const exports = extractKeyExports(content);

      result.fileInfo.push({
        path: filePath,
        size: stat.size,
        lines: lineCount,
        exports
      });
    } catch {
      result.fileInfo.push({ path: filePath, size: 0, lines: 0, exports: [] });
    }
  }

  return result;
}

/**
 * Extract key exported symbols from file content.
 * @param {string} content - File content
 * @returns {string[]} Array of symbol identifiers like "fn:myFunc", "class:MyClass"
 */
function extractKeyExports(content) {
  if (!content) return [];
  const exports = [];
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    // Exported functions
    const fnMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
    if (fnMatch) { exports.push(`fn:${fnMatch[1]}`); continue; }

    // Classes
    const classMatch = trimmed.match(/^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/);
    if (classMatch) { exports.push(`class:${classMatch[1]}`); continue; }

    // Interfaces
    const ifaceMatch = trimmed.match(/^(?:export\s+)?interface\s+(\w+)/);
    if (ifaceMatch) { exports.push(`iface:${ifaceMatch[1]}`); continue; }
  }

  // module.exports pattern
  if (exports.length === 0) {
    const modExports = content.match(/module\.exports\s*=\s*\{([^}]+)\}/);
    if (modExports) {
      const names = modExports[1].split(',')
        .map(s => s.trim().split(/[\s:]/)[0].trim())
        .filter(n => n && /^\w+$/.test(n));
      exports.push(...names.slice(0, 12).map(n => `exp:${n}`));
    }
  }

  return exports.slice(0, 15);
}

// ─── 3. Lightweight File Context ────────────────────────────────────────

/**
 * Build a lightweight file context for Codex.
 * Lists files with sizes and key exports — NOT full content.
 * Codex can read files itself, so we just tell it where to look.
 * @param {Array<{actual: string, mentioned: string}>} resolvedFiles - Resolved file references
 * @param {string} workingDir - Project root
 * @param {Object} analysis - Result from runPreAnalysis
 * @returns {string} Formatted file listing
 */
function buildLightweightFileContext(resolvedFiles, workingDir, analysis) {
  if (!resolvedFiles || resolvedFiles.length === 0) return '';

  let context = '\n## Target Files\n';
  context += 'Read these files to understand the current code before making changes.\n\n';

  for (const { actual } of resolvedFiles) {
    const info = analysis.fileInfo.find(f => f.path === actual);
    if (info && info.lines > 0) {
      const sizeKb = Math.round(info.size / 1024);
      const exportsStr = info.exports.length > 0
        ? ` — exports: ${info.exports.join(', ')}`
        : '';
      context += `- \`${actual}\` (${info.lines} lines, ${sizeKb}KB${exportsStr})\n`;
    } else {
      context += `- \`${actual}\` (new file)\n`;
    }
  }

  return context;
}

// ─── 4. Enriched Prompt Builder ─────────────────────────────────────────

/**
 * Build a structured, enriched prompt for Codex using local intelligence.
 * Combines project info, pre-analysis, file context, and enrichment into
 * a well-organized prompt that maximizes Codex effectiveness.
 *
 * @param {Object} task - Task record
 * @param {Array<{actual: string, mentioned: string}>} resolvedFiles - Resolved file refs
 * @param {string} workingDir - Project root
 * @param {string} enrichment - Context enrichment from context-enrichment.js (imports, tests, git, fewshot)
 * @returns {string} Complete Codex prompt
 */
function buildCodexEnrichedPrompt(task, resolvedFiles, workingDir, enrichment) {
  const parts = [];

  // 1. Task description (primary)
  parts.push(`## Task\n\n${task.task_description}`);

  // 2. Project info (local detection)
  const projectInfo = detectProjectInfo(workingDir);
  if (projectInfo.type !== 'unknown') {
    const projParts = [`- Type: ${projectInfo.type} (${projectInfo.language})`];
    if (projectInfo.testFramework) projParts.push(`- Tests: ${projectInfo.testFramework}`);
    if (projectInfo.buildTool) projParts.push(`- Build: ${projectInfo.buildTool}`);
    if (projectInfo.hasTypeScript) projParts.push('- TypeScript: yes');
    parts.push(`\n## Project\n${projParts.join('\n')}`);
  }

  // 3. Pre-analysis (local type/syntax checks)
  const filePaths = resolvedFiles ? resolvedFiles.map(r => r.actual) : [];
  const analysis = runPreAnalysis(workingDir, filePaths);

  if (analysis.existingErrors.length > 0) {
    parts.push(
      `\n## Pre-Existing Errors\n` +
      `These errors exist in the target files before your changes. Fix them if relevant to your task:\n` +
      analysis.existingErrors.map(e => `- ${e}`).join('\n')
    );
  }

  // 4. Lightweight file context (paths + sizes, NOT full content)
  if (resolvedFiles && resolvedFiles.length > 0) {
    parts.push(buildLightweightFileContext(resolvedFiles, workingDir, analysis));
  }

  // 5. Task type instructions (from prompts module)
  if (_promptsModule) {
    const taskTypes = _promptsModule.detectTaskTypes(task.task_description);
    let taskTypeInstructions = '';
    for (const type of taskTypes) {
      if (_promptsModule.TASK_TYPE_INSTRUCTIONS[type]) {
        taskTypeInstructions += _promptsModule.TASK_TYPE_INSTRUCTIONS[type];
      }
    }
    if (taskTypeInstructions) {
      parts.push(taskTypeInstructions);
    }
  }

  // 6. Enrichment context (import types, test patterns, git context, few-shot)
  if (enrichment) {
    parts.push(enrichment);
  }

  // 7. Quality rules
  parts.push(`\n## Quality Rules\n${BASE_LLM_RULES}`);

  // 8. Verify command hint
  if (db) {
    const verifyCommand = serverConfig.get('verify_command');
    if (verifyCommand) {
      parts.push(`\n## Verification\nAfter making changes, run: \`${verifyCommand}\` to verify correctness.`);
    }
  }

  const prompt = parts.join('\n');
  logger.info(`[CodexIntel] Built enriched prompt: ${prompt.length} chars (project: ${projectInfo.type}, ` +
    `files: ${filePaths.length}, errors: ${analysis.existingErrors.length}, ` +
    `enrichment: ${enrichment ? enrichment.length : 0} chars)`);

  return prompt;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function safeExists(filePath) {
  try { return fs.existsSync(filePath); } catch { return false; }
}

module.exports = {
  init,
  detectProjectInfo,
  runPreAnalysis,
  extractKeyExports,
  buildLightweightFileContext,
  buildCodexEnrichedPrompt,
};
