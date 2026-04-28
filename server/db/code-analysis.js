'use strict';

/**
 * Code Analysis Module
 *
 * Extracted from database.js — static analysis functions for code quality,
 * documentation coverage, accessibility, i18n, dead code, resource estimation,
 * type verification, and build error analysis.
 *
 * Uses setDb() dependency injection to receive the SQLite connection.
 */

const { SOURCE_EXTENSIONS, UI_EXTENSIONS } = require('../constants');

let db;

// Lazy module-level cache of prepared statements keyed by a stable name.
const _stmtCache = new Map();
function _getStmt(key, sql) {
  const cached = _stmtCache.get(key);
  if (cached) return cached;
  const stmt = db.prepare(sql);
  _stmtCache.set(key, stmt);
  return stmt;
}

function setDb(dbInstance) {
  db = dbInstance;
  _stmtCache.clear();
}

// ============================================
// Code Complexity Analysis
// ============================================

function analyzeCodeComplexity(taskId, filePath, content) {
  const now = new Date().toISOString();

  const decisionPatterns = [
    /\bif\s*\(/g,
    /\belse\b/g,
    /\bwhile\s*\(/g,
    /\bfor\s*\(/g,
    /\bcase\s+/g,
    /\bcatch\s*\(/g,
    /\?\s*[^:]+\s*:/g,
    /&&/g,
    /\|\|/g
  ];

  let cyclomaticComplexity = 1;
  for (const pattern of decisionPatterns) {
    const matches = content.match(pattern);
    if (matches) cyclomaticComplexity += matches.length;
  }

  let maxNestingDepth = 0;
  let currentDepth = 0;
  for (const char of content) {
    if (char === '{') {
      currentDepth++;
      maxNestingDepth = Math.max(maxNestingDepth, currentDepth);
    } else if (char === '}') {
      currentDepth = Math.max(0, currentDepth - 1);
    }
  }

  const functionPatterns = [
    /function\s+\w+\s*\(/g,
    /\w+\s*[=:]\s*(async\s+)?function\s*\(/g,
    /\w+\s*[=:]\s*(async\s+)?\([^)]*\)\s*=>/g,
    /\w+\s*\([^)]*\)\s*{/g
  ];

  let functionCount = 0;
  for (const pattern of functionPatterns) {
    const matches = content.match(pattern);
    if (matches) functionCount += matches.length;
  }

  const linesOfCode = content.split('\n').filter(line => line.trim().length > 0).length;

  const safeLoc = Math.max(1, linesOfCode);
  const safeComplexity = Math.max(1, cyclomaticComplexity);
  const maintainabilityIndex = Math.max(0, Math.min(100,
    171 - 5.2 * Math.log(safeComplexity) - 0.23 * safeComplexity - 16.2 * Math.log(safeLoc)
  ));

  db.prepare(`
    INSERT INTO complexity_metrics (task_id, file_path, cyclomatic_complexity, cognitive_complexity, lines_of_code, function_count, max_nesting_depth, maintainability_index, analyzed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(taskId, filePath, cyclomaticComplexity, cyclomaticComplexity * maxNestingDepth, linesOfCode, functionCount, maxNestingDepth, maintainabilityIndex, now);

  return {
    file_path: filePath,
    cyclomatic_complexity: cyclomaticComplexity,
    max_nesting_depth: maxNestingDepth,
    lines_of_code: linesOfCode,
    function_count: functionCount,
    maintainability_index: Math.round(maintainabilityIndex * 10) / 10
  };
}

function getComplexityMetrics(taskId) {
  return db.prepare('SELECT * FROM complexity_metrics WHERE task_id = ?').all(taskId);
}

// ============================================
// Dead Code Detection
// ============================================

function detectDeadCode(taskId, filePath, content) {
  const now = new Date().toISOString();
  const deadCode = [];

  const funcPattern = /(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function|\b(\w+)\s*:\s*(?:async\s+)?function)/g;
  const functions = [];
  let match;

  while ((match = funcPattern.exec(content)) !== null) {
    const funcName = match[1] || match[2] || match[3];
    if (funcName && !['constructor', 'render', 'componentDidMount', 'ngOnInit'].includes(funcName)) {
      functions.push({ name: funcName, line: content.substring(0, match.index).split('\n').length });
    }
  }

  for (const func of functions) {
    const callPattern = new RegExp(`\\b${func.name}\\s*\\(`, 'g');
    const calls = content.match(callPattern);
    if (!calls || calls.length <= 1) {
      deadCode.push({
        type: 'unused_function',
        identifier: func.name,
        line: func.line,
        confidence: 0.7
      });
    }
  }

  const varPattern = /(?:const|let|var)\s+(\w+)\s*=/g;
  while ((match = varPattern.exec(content)) !== null) {
    const varName = match[1];
    if (varName && varName.length > 1) {
      const usagePattern = new RegExp(`\\b${varName}\\b`, 'g');
      const usages = content.match(usagePattern);
      if (usages && usages.length <= 1) {
        deadCode.push({
          type: 'unused_variable',
          identifier: varName,
          line: content.substring(0, match.index).split('\n').length,
          confidence: 0.6
        });
      }
    }
  }

  for (const item of deadCode) {
    _getStmt('insertDeadCode', `
      INSERT INTO dead_code_results (task_id, file_path, dead_code_type, identifier, line_number, confidence, detected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(taskId, filePath, item.type, item.identifier, item.line, item.confidence, now);
  }

  return deadCode;
}

function getDeadCodeResults(taskId) {
  return db.prepare('SELECT * FROM dead_code_results WHERE task_id = ?').all(taskId);
}

// ============================================
// Documentation Coverage
// ============================================

function checkDocCoverage(taskId, filePath, content) {
  const now = new Date().toISOString();
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();

  const publicItems = [];
  const documentedItems = [];

  if (SOURCE_EXTENSIONS.has(ext)) {
    const exportPattern = /export\s+(?:async\s+)?(?:function|class|const|let|var|interface|type)\s+(\w+)/g;
    let match;
    while ((match = exportPattern.exec(content)) !== null) {
      publicItems.push({ name: match[1], line: content.substring(0, match.index).split('\n').length });
      const beforeExport = content.substring(Math.max(0, match.index - 500), match.index);
      if (/\/\*\*[\s\S]*?\*\/\s*$/.test(beforeExport)) {
        documentedItems.push(match[1]);
      }
    }
  } else if (['.cs'].includes(ext)) {
    const publicPattern = /public\s+(?:async\s+)?(?:class|interface|struct|enum|void|string|int|bool|\w+)\s+(\w+)/g;
    let match;
    while ((match = publicPattern.exec(content)) !== null) {
      publicItems.push({ name: match[1], line: content.substring(0, match.index).split('\n').length });
      const beforePublic = content.substring(Math.max(0, match.index - 300), match.index);
      if (/\/\/\/\s*<summary>/.test(beforePublic)) {
        documentedItems.push(match[1]);
      }
    }
  } else if (['.py'].includes(ext)) {
    const defPattern = /def\s+(\w+)\s*\(/g;
    let match;
    while ((match = defPattern.exec(content)) !== null) {
      if (!match[1].startsWith('_')) {
        publicItems.push({ name: match[1], line: content.substring(0, match.index).split('\n').length });
        const afterDef = content.substring(match.index, match.index + 200);
        if (/def\s+\w+\s*\([^)]*\)\s*:\s*\n\s*['"]{3}/.test(afterDef)) {
          documentedItems.push(match[1]);
        }
      }
    }
  }

  const coverage = publicItems.length > 0 ? (documentedItems.length / publicItems.length) * 100 : 100;
  const missingDocs = publicItems.filter(p => !documentedItems.includes(p.name)).map(p => p.name);

  db.prepare(`
    INSERT INTO doc_coverage_results (task_id, file_path, total_public_items, documented_items, coverage_percent, missing_docs, analyzed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(taskId, filePath, publicItems.length, documentedItems.length, coverage, JSON.stringify(missingDocs), now);

  return {
    file_path: filePath,
    total_public_items: publicItems.length,
    documented_items: documentedItems.length,
    coverage_percent: Math.round(coverage * 10) / 10,
    missing_docs: missingDocs
  };
}

function getDocCoverageResults(taskId) {
  return db.prepare('SELECT * FROM doc_coverage_results WHERE task_id = ?').all(taskId);
}

// ============================================
// Resource Usage Estimation
// ============================================

function estimateResourceUsage(taskId, filePath, content) {
  const now = new Date().toISOString();

  const risks = [];
  let memoryScore = 0;
  let cpuScore = 0;

  const infiniteLoopPatterns = [
    /while\s*\(\s*true\s*\)/,
    /while\s*\(\s*1\s*\)/,
    /for\s*\(\s*;\s*;\s*\)/
  ];
  for (const pattern of infiniteLoopPatterns) {
    if (pattern.test(content)) {
      risks.push('potential_infinite_loop');
      cpuScore += 50;
    }
  }

  const memoryPatterns = [
    { pattern: /new\s+Array\s*\(\s*\d{6,}\s*\)/, risk: 'large_array_allocation', score: 30 },
    { pattern: /\.push\s*\([^)]*\)\s*.*while|for.*\.push\s*\(/s, risk: 'unbounded_array_growth', score: 20 },
    { pattern: /Buffer\.alloc\s*\(\s*\d{6,}\s*\)/, risk: 'large_buffer_allocation', score: 25 }
  ];
  for (const { pattern, risk, score } of memoryPatterns) {
    if (pattern.test(content)) {
      risks.push(risk);
      memoryScore += score;
    }
  }

  const blockingPatterns = [/readFileSync/, /writeFileSync/, /execSync/, /spawnSync/];
  let hasBlockingIo = false;
  for (const pattern of blockingPatterns) {
    if (pattern.test(content)) {
      hasBlockingIo = true;
      risks.push('blocking_io');
      cpuScore += 10;
    }
  }

  const recursivePattern = /function\s+(\w+)[^{]*{[^}]*\1\s*\(/g;
  if (recursivePattern.test(content)) {
    risks.push('potential_stack_overflow');
    memoryScore += 20;
  }

  const estimatedMemoryMb = 50 + memoryScore;

  db.prepare(`
    INSERT INTO resource_estimates (task_id, file_path, estimated_memory_mb, estimated_cpu_score, has_infinite_loop_risk, has_memory_leak_risk, has_blocking_io, risk_factors, estimated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    taskId, filePath, estimatedMemoryMb, cpuScore,
    risks.includes('potential_infinite_loop') ? 1 : 0,
    risks.includes('unbounded_array_growth') ? 1 : 0,
    hasBlockingIo ? 1 : 0,
    JSON.stringify(risks), now
  );

  return {
    file_path: filePath,
    estimated_memory_mb: estimatedMemoryMb,
    cpu_risk_score: cpuScore,
    risk_factors: risks
  };
}

function getResourceEstimates(taskId) {
  return db.prepare('SELECT * FROM resource_estimates WHERE task_id = ?').all(taskId);
}

// ============================================
// Internationalization Check
// ============================================

function checkI18n(taskId, filePath, content) {
  const now = new Date().toISOString();
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();

  const hardcodedStrings = [];

  if (SOURCE_EXTENSIONS.has(ext)) {
    const stringPatterns = [
      />\s*([A-Z][a-z]+(?:\s+[a-z]+)+)\s*</g,
      /["'`]([A-Z][a-z]+(?:\s+[a-z]+){2,})["'`]/g
    ];

    for (const pattern of stringPatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const text = match[1].trim();
        if (text.length > 10 && !text.includes('://') && !text.match(/^[A-Z_]+$/)) {
          hardcodedStrings.push({
            text: text.substring(0, 50),
            line: content.substring(0, match.index).split('\n').length
          });
        }
      }
    }
  }

  db.prepare(`
    INSERT INTO i18n_results (task_id, file_path, hardcoded_strings_count, hardcoded_strings, missing_translations, checked_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(taskId, filePath, hardcodedStrings.length, JSON.stringify(hardcodedStrings), null, now);

  return {
    file_path: filePath,
    hardcoded_strings_count: hardcodedStrings.length,
    hardcoded_strings: hardcodedStrings.slice(0, 10)
  };
}

function getI18nResults(taskId) {
  return db.prepare('SELECT * FROM i18n_results WHERE task_id = ?').all(taskId);
}

// ============================================
// Accessibility Compliance
// ============================================

function checkAccessibility(taskId, filePath, content) {
  const now = new Date().toISOString();
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();

  const violations = [];

  if (UI_EXTENSIONS.has(ext)) {
    const imgNoAlt = /<img(?![^>]*alt=)[^>]*>/gi;
    let match;
    while ((match = imgNoAlt.exec(content)) !== null) {
      violations.push({
        rule: 'img-alt',
        wcag: '1.1.1',
        message: 'Image missing alt attribute',
        line: content.substring(0, match.index).split('\n').length
      });
    }

    const inputNoLabel = /<input(?![^>]*aria-label)[^>]*type=["'](?:text|email|password|tel)["'][^>]*>/gi;
    while ((match = inputNoLabel.exec(content)) !== null) {
      const context = content.substring(Math.max(0, match.index - 200), match.index);
      if (!/<label[^>]*for=/.test(context)) {
        violations.push({
          rule: 'input-label',
          wcag: '1.3.1',
          message: 'Form input missing associated label',
          line: content.substring(0, match.index).split('\n').length
        });
      }
    }

    const clickNoKey = /onClick=(?![^>]*onKeyPress|onKeyDown|onKeyUp)[^>]*>/gi;
    while ((match = clickNoKey.exec(content)) !== null) {
      const element = content.substring(match.index, match.index + 100);
      if (!/<button|<a\s|<input/.test(element)) {
        violations.push({
          rule: 'click-keyboard',
          wcag: '2.1.1',
          message: 'Click handler without keyboard alternative',
          line: content.substring(0, match.index).split('\n').length
        });
      }
    }

    const headings = content.match(/<h[1-6]/gi) || [];
    const levels = headings.map(h => parseInt(h.charAt(2), 10));
    for (let i = 1; i < levels.length; i++) {
      if (levels[i] - levels[i - 1] > 1) {
        violations.push({
          rule: 'heading-order',
          wcag: '1.3.1',
          message: `Heading level skipped (h${levels[i - 1]} to h${levels[i]})`,
          line: 0
        });
      }
    }
  }

  db.prepare(`
    INSERT INTO a11y_results (task_id, file_path, violations_count, violations, wcag_level, checked_at)
    VALUES (?, ?, ?, ?, 'AA', ?)
  `).run(taskId, filePath, violations.length, JSON.stringify(violations), now);

  return {
    file_path: filePath,
    violations_count: violations.length,
    violations: violations
  };
}

function getAccessibilityResults(taskId) {
  return db.prepare('SELECT * FROM a11y_results WHERE task_id = ?').all(taskId);
}

// ============================================
// Type Reference Verification
// ============================================

function verifyTypeReferences(taskId, filePath, content, workingDirectory) {
  const fs = require('fs');
  const path = require('path');
  const now = new Date().toISOString();
  const results = [];

  const patterns = [
    { regex: /:\s*I([A-Z][a-zA-Z0-9]+)/g, kind: 'interface' },
    { regex: /,\s*I([A-Z][a-zA-Z0-9]+)/g, kind: 'interface' },
    { regex: /class\s+\w+\s*:\s*([A-Z][a-zA-Z0-9]+)(?!\s*<)/g, kind: 'class' },
    { regex: /implements\s+([A-Z][a-zA-Z0-9]+)/g, kind: 'interface' },
    { regex: /extends\s+([A-Z][a-zA-Z0-9]+)/g, kind: 'class' }
  ];

  const referencedTypes = new Set();

  for (const { regex, kind } of patterns) {
    let match;
    while ((match = regex.exec(content)) !== null) {
      const typeName = kind === 'interface' ? `I${match[1]}` : match[1];
      const frameworkTypes = ['IDisposable', 'IEnumerable', 'IList', 'IDictionary', 'ICollection',
        'INotifyPropertyChanged', 'ICommand', 'Object', 'Exception', 'EventArgs', 'Component'];
      if (!frameworkTypes.includes(typeName)) {
        referencedTypes.add(JSON.stringify({ name: typeName, kind }));
      }
    }
  }

  for (const typeJson of referencedTypes) {
    const { name: typeName, kind } = JSON.parse(typeJson);
    let existsInCodebase = false;
    let foundInFile = null;

    const searchPattern = kind === 'interface'
      ? `interface ${typeName}`
      : `class ${typeName}`;

    function searchDir(dir, depth = 0) {
      if (depth > 8 || existsInCodebase) return;

      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (existsInCodebase) break;
          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            if (!['node_modules', '.git', 'bin', 'obj', 'dist', '.vs'].includes(entry.name)) {
              searchDir(fullPath, depth + 1);
            }
          } else if (entry.isFile() && /\.(cs|ts|tsx|js|jsx)$/.test(entry.name)) {
            try {
              const fileContent = fs.readFileSync(fullPath, 'utf8');
              if (fileContent.includes(searchPattern)) {
                existsInCodebase = true;
                foundInFile = fullPath;
              }
            } catch (_e) { void _e; /* skip unreadable files */ }
          }
        }
      } catch (_e) { void _e; /* skip unreadable dirs */ }
    }

    if (workingDirectory) {
      searchDir(workingDirectory);
    }

    _getStmt('insertTypeVerification', `
      INSERT INTO type_verification_results (task_id, file_path, type_name, type_kind, exists_in_codebase, found_in_file, severity, details, verified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      taskId, filePath, typeName, kind, existsInCodebase ? 1 : 0, foundInFile,
      existsInCodebase ? 'info' : 'error',
      existsInCodebase ? `Found in ${foundInFile}` : `${kind} ${typeName} not found in codebase - may be hallucinated`,
      now
    );

    results.push({
      type_name: typeName,
      type_kind: kind,
      exists: existsInCodebase,
      found_in: foundInFile
    });
  }

  const missingTypes = results.filter(r => !r.exists);
  return {
    task_id: taskId,
    file_path: filePath,
    types_checked: results.length,
    missing_types: missingTypes.length,
    results,
    status: missingTypes.length > 0 ? 'types_missing' : 'verified'
  };
}

function getTypeVerificationResults(taskId) {
  return db.prepare('SELECT * FROM type_verification_results WHERE task_id = ?').all(taskId);
}

// ============================================
// Build Error Analysis
// ============================================

function analyzeBuildOutput(taskId, buildOutput) {
  const now = new Date().toISOString();
  const errors = [];

  const errorPatterns = [
    {
      regex: /error CS0104:.*'([^']+)'.*ambiguous.*between.*'([^']+)'.*and.*'([^']+)'/g,
      type: 'namespace_conflict',
      extract: (m) => ({
        code: 'CS0104',
        message: `Ambiguous reference: ${m[1]} between ${m[2]} and ${m[3]}`,
        suggestedFix: `Add using alias: using ${m[1]} = ${m[2]};`
      })
    },
    {
      regex: /error CS0246:.*type or namespace.*'([^']+)'.*could not be found/gi,
      type: 'missing_type',
      extract: (m) => ({
        code: 'CS0246',
        message: `Missing type or namespace: ${m[1]}`,
        suggestedFix: `Add missing using statement or verify ${m[1]} exists`
      })
    },
    {
      regex: /error CS0234:.*'([^']+)'.*does not exist.*namespace.*'([^']+)'/gi,
      type: 'missing_namespace_member',
      extract: (m) => ({
        code: 'CS0234',
        message: `${m[1]} does not exist in namespace ${m[2]}`,
        suggestedFix: `Verify the type exists or check namespace spelling`
      })
    },
    {
      regex: /error CS0103:.*name.*'([^']+)'.*does not exist/gi,
      type: 'undefined_name',
      extract: (m) => ({
        code: 'CS0103',
        message: `Undefined name: ${m[1]}`,
        suggestedFix: `Define ${m[1]} or add appropriate using statement`
      })
    },
    {
      regex: /error CS1061:.*'([^']+)'.*does not contain.*definition.*'([^']+)'/gi,
      type: 'missing_member',
      extract: (m) => ({
        code: 'CS1061',
        message: `${m[1]} does not have member ${m[2]}`,
        suggestedFix: `Verify ${m[2]} exists on ${m[1]} or check for typos`
      })
    },
    {
      regex: /([^\s(]+)\((\d+),\d+\):\s*error\s+(\w+):/g,
      type: 'file_location',
      extract: (m) => ({ filePath: m[1], lineNumber: parseInt(m[2], 10), code: m[3] })
    }
  ];

  for (const { regex, type, extract } of errorPatterns) {
    let match;
    while ((match = regex.exec(buildOutput)) !== null) {
      const extracted = extract(match);
      if (type === 'file_location') continue;

      errors.push({
        error_type: type,
        ...extracted
      });
    }
  }

  for (const error of errors) {
    _getStmt('insertBuildErrorAnalysis', `
      INSERT INTO build_error_analysis (task_id, error_code, error_type, file_path, line_number, message, suggested_fix, auto_fixable, analyzed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      taskId, error.code, error.error_type, error.filePath || null, error.lineNumber || null,
      error.message, error.suggestedFix || null, error.autoFixable ? 1 : 0, now
    );
  }

  return {
    task_id: taskId,
    errors_found: errors.length,
    errors,
    has_namespace_conflicts: errors.some(e => e.error_type === 'namespace_conflict'),
    has_missing_types: errors.some(e => e.error_type === 'missing_type')
  };
}

function getBuildErrorAnalysis(taskId) {
  return db.prepare('SELECT * FROM build_error_analysis WHERE task_id = ?').all(taskId);
}

/**
 * Factory: create a code-analysis instance with injected db.
 * @param {{ db: object }} deps
 */
function createCodeAnalysis({ db: dbInstance }) {
  setDb(dbInstance);
  return {
    analyzeCodeComplexity,
    getComplexityMetrics,
    detectDeadCode,
    getDeadCodeResults,
    checkDocCoverage,
    getDocCoverageResults,
    estimateResourceUsage,
    getResourceEstimates,
    checkI18n,
    getI18nResults,
    checkAccessibility,
    getAccessibilityResults,
    verifyTypeReferences,
    getTypeVerificationResults,
    analyzeBuildOutput,
    getBuildErrorAnalysis,
  };
}

module.exports = {
  setDb,
  // Code Complexity
  analyzeCodeComplexity,
  getComplexityMetrics,
  // Dead Code Detection
  detectDeadCode,
  getDeadCodeResults,
  // Documentation Coverage
  checkDocCoverage,
  getDocCoverageResults,
  // Resource Estimation
  estimateResourceUsage,
  getResourceEstimates,
  // Internationalization
  checkI18n,
  getI18nResults,
  // Accessibility
  checkAccessibility,
  getAccessibilityResults,
  // Type Verification
  verifyTypeReferences,
  getTypeVerificationResults,
  // Build Error Analysis
  analyzeBuildOutput,
  getBuildErrorAnalysis,
  createCodeAnalysis,
};
