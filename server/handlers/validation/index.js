/**
 * Validation handlers — aggregator + core validation/baseline/build/quality handlers
 * Sub-modules handle specific domains:
 *   ./file.js      — file tracking and change recording
 *   ./xaml.js      — XAML/WPF validation
 *   ./security.js  — security scan, file locks, rate limits, backups
 *   ./analysis.js  — complexity, dead code, doc coverage, style, audit
 *   ./safeguard.js — LLM safeguards, type verification, build analysis, i18n, a11y
 *   ./failure.js   — failure patterns, retry rules
 */

const database = require('../../database');
const costTracking = require('../../db/cost-tracking');
const fileTracking = require('../../db/file-tracking');
const validationRules = require('../../db/validation-rules');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { TASK_TIMEOUTS } = require('../../constants');
const { requireString, requireTask, ErrorCodes, makeError } = require('../shared');
const logger = require('../../logger').child({ component: 'validation' });
const postToolHooks = require('../../hooks/post-tool-hooks');
const { checkApprovalGate } = require('../../hooks/approval-gate');

// Sub-module imports
const fileHandlers = require('./file');
const xamlHandlers = require('./xaml');
const securityHandlers = require('./security');
const analysisHandlers = require('./analysis');
const safeguardHandlers = require('./safeguard');
const failureHandlers = require('./failure');

const PRECOMMIT_CHECKS = new Set(['validation', 'syntax', 'build']);

function normalizePrecommitChecks(checks) {
  if (!Array.isArray(checks)) return [];
  return [...new Set(
    checks
      .map((check) => `${check}`.trim().toLowerCase())
      .filter((check) => PRECOMMIT_CHECKS.has(check))
  )];
}


// ============================================
// Output Validation Handlers
// ============================================

function handleListValidationRules(args) {
  const { enabled_only = true, severity } = args;
  const rules = validationRules.getValidationRules(enabled_only);
  const severityOrder = ['info', 'warning', 'error', 'critical'];
  const normalizeSeverity = (value) => {
    const idx = severityOrder.indexOf(`${value || ''}`.trim().toLowerCase());
    return idx === -1 ? 0 : idx;
  };

  let filtered = rules;
  if (severity) {
    const minIdx = normalizeSeverity(severity);
    filtered = rules.filter(r => normalizeSeverity(r.severity) >= minIdx);
  }

  if (filtered.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## Validation Rules\n\nNo validation rules found.`
      }]
    };
  }

  let output = `## Validation Rules\n\n`;
  output += `| Name | Type | Severity | Auto-Fail | Enabled |\n`;
  output += `|------|------|----------|-----------|----------|\n`;

  filtered.forEach(rule => {
    output += `| ${rule.name} | ${rule.rule_type} | ${rule.severity} | ${rule.auto_fail ? '✓' : '-'} | ${rule.enabled ? '✓' : '✗'} |\n`;
  });

  output += `\n**Total:** ${filtered.length} rules\n`;

  return { content: [{ type: 'text', text: output }] };
}

function handleAddValidationRule(args) {
  const { name, description, rule_type, pattern, condition, severity = 'warning', auto_fail = false } = args;

  if (!name || !description || !rule_type) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'name, description, and rule_type are required');
  }

  if (rule_type === 'pattern' && !pattern) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'pattern is required for pattern-type rules');
  }

  if ((rule_type === 'size' || rule_type === 'delta') && !condition) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'condition is required for size/delta-type rules');
  }

  const id = `val-${Date.now()}`;
  validationRules.saveValidationRule({
    id, name, description, rule_type,
    pattern: pattern || null,
    condition: condition || null,
    severity, auto_fail
  });

  return {
    content: [{
      type: 'text',
      text: `## Validation Rule Added\n\n- **ID:** ${id}\n- **Name:** ${name}\n- **Type:** ${rule_type}\n- **Severity:** ${severity}\n- **Auto-Fail:** ${auto_fail ? 'Yes' : 'No'}`
    }]
  };
}

function handleUpdateValidationRule(args) {
  const { rule_id, enabled, severity, auto_fail } = args;

  if (!rule_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'rule_id is required');
  }

  const existingRule = validationRules.getValidationRule(rule_id);
  if (!existingRule) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Validation rule not found: ${rule_id}`);
  }

  const updates = {};
  if (enabled !== undefined) updates.enabled = enabled;
  if (severity !== undefined) updates.severity = severity;
  if (auto_fail !== undefined) updates.auto_fail = auto_fail;

  validationRules.saveValidationRule({ ...existingRule, ...updates });

  return {
    content: [{
      type: 'text',
      text: `## Validation Rule Updated\n\n- **Rule ID:** ${rule_id}\n- **Changes:** ${Object.keys(updates).map(k => `${k}=${updates[k]}`).join(', ')}`
    }]
  };
}

function handleValidateTaskOutput(args) {
  const { task_id } = args;

  const err = requireString(args, 'task_id');
  if (err) return err;

  const { task, error: taskErr } = requireTask(task_id);
  if (taskErr) return taskErr;

  const fileChanges = [];
  const workDir = task.working_directory;
  if (workDir && fs.existsSync(workDir)) {
    try {
      let gitOutput = '';
      const tryGitDiff = (gitArgs) => {
        try {
          return execFileSync('git', gitArgs, {
            cwd: workDir, encoding: 'utf-8', timeout: TASK_TIMEOUTS.GIT_STATUS, windowsHide: true
          }).trim();
        } catch { return ''; }
      };
      gitOutput = tryGitDiff(['diff', '--name-only', 'HEAD~1', 'HEAD']);
      if (!gitOutput) gitOutput = tryGitDiff(['diff', '--name-only', '--cached']);
      if (!gitOutput) gitOutput = tryGitDiff(['diff', '--name-only']);
      const changedFiles = gitOutput.split('\n').filter(f => f.trim());
      for (const relFile of changedFiles) {
        const absPath = path.join(workDir, relFile);
        if (fs.existsSync(absPath)) {
          try {
            const content = fs.readFileSync(absPath, 'utf-8');
            const stats = fs.statSync(absPath);
            fileChanges.push({ path: relFile, content, size: stats.size });
          } catch (readErr) {
            logger.debug('[validation-handlers] non-critical error reading files for validation:', readErr.message || readErr);
          }
        }
      }
    } catch (gitErr) {
      logger.debug('[validation-handlers] non-critical error reading git diff for validation:', gitErr.message || gitErr);
    }
  }

  const results = validationRules.validateTaskOutput(task.id, fileChanges);

  if (results.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## Validation Passed ✓\n\nTask ${task_id} passed all validation rules.`
      }]
    };
  }

  let output = `## Validation Results\n\n`;
  output += `**Task:** ${task_id}\n\n`;

  const critical = results.filter(r => r.severity === 'critical');
  const errors = results.filter(r => r.severity === 'error');
  const warnings = results.filter(r => r.severity === 'warning');
  const info = results.filter(r => r.severity === 'info');

  if (critical.length > 0) {
    output += `### 🔴 Critical (${critical.length})\n`;
    critical.forEach(r => output += `- **${r.rule_name || r.rule}**: ${r.details || r.matched_content || r.file || 'pattern matched'}\n`);
    output += '\n';
  }

  if (errors.length > 0) {
    output += `### 🟠 Errors (${errors.length})\n`;
    errors.forEach(r => output += `- **${r.rule_name || r.rule}**: ${r.details || r.matched_content || r.file || 'pattern matched'}\n`);
    output += '\n';
  }

  if (warnings.length > 0) {
    output += `### 🟡 Warnings (${warnings.length})\n`;
    warnings.forEach(r => output += `- **${r.rule_name || r.rule}**: ${r.details || r.matched_content || r.file || 'pattern matched'}\n`);
    output += '\n';
  }

  if (info.length > 0) {
    output += `### 🔵 Info (${info.length})\n`;
    info.forEach(r => output += `- **${r.rule_name || r.rule}**: ${r.details || r.matched_content || r.file || 'pattern matched'}\n`);
  }

  return { content: [{ type: 'text', text: output }] };
}

function handleGetValidationResults(args) {
  const { task_id, min_severity = 'warning' } = args;

  if (!task_id || typeof task_id !== 'string' || task_id.trim().length === 0) {
    return makeError(ErrorCodes.INVALID_PARAM, 'task_id is required and must be a non-empty string');
  }

  const results = validationRules.getValidationResults(task_id.trim(), min_severity);

  if (results.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## Validation Results\n\nNo validation issues found for task ${task_id} (min severity: ${min_severity}).`
      }]
    };
  }

  let output = `## Validation Results for ${task_id}\n\n`;
  results.forEach(r => {
    output += `- **[${r.severity.toUpperCase()}]** ${r.rule_name}: ${r.details || r.matched_content}\n`;
    if (r.file_path) output += `  File: ${r.file_path}\n`;
  });

  return { content: [{ type: 'text', text: output }] };
}

function handleRejectTask(args) {
  const { approval_id, notes } = args;

  const err = requireString(args, 'approval_id');
  if (err) return err;

  validationRules.decideApproval(approval_id, false, 'user', notes || null);

  return {
    content: [{
      type: 'text',
      text: `## Rejected ✗\n\nApproval ${approval_id} has been rejected.${notes ? `\n\nReason: ${notes}` : ''}`
    }]
  };
}


// ============================================
// File Baseline Handlers
// ============================================

function handleCaptureFileBaselines(args) {
  const { working_directory, extensions } = args;

  if (!working_directory) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory is required');
  }

  const exts = extensions || ['.cs', '.xaml', '.ts', '.js', '.py'];
  const captured = fileTracking.captureDirectoryBaselines(working_directory, exts);

  return {
    content: [{
      type: 'text',
      text: `## File Baselines Captured\n\n- **Directory:** ${working_directory}\n- **Extensions:** ${exts.join(', ')}\n- **Files Captured:** ${captured.length}\n\n${captured.length > 0 ? captured.slice(0, 20).map(f => `- ${f}`).join('\n') + (captured.length > 20 ? `\n- ... and ${captured.length - 20} more` : '') : 'No files found matching the extensions.'}`
    }]
  };
}

function handleCompareFileBaseline(args) {
  const { file_path, working_directory } = args;

  if (!file_path || !working_directory) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'file_path and working_directory are required');
  }

  const result = fileTracking.compareFileToBaseline(file_path, working_directory);

  if (!result.hasBaseline) {
    return {
      content: [{
        type: 'text',
        text: `## No Baseline Found\n\nNo baseline exists for ${file_path}. Run \`capture_file_baselines\` first.`
      }]
    };
  }

  if (result.error) {
    return {
      content: [{
        type: 'text',
        text: `## Comparison Error\n\n${result.error}`
      }]
    };
  }

  const status = result.isTruncated ? '🔴 TRUNCATED' :
                 result.isSignificantlyShrunk ? '🟡 Significantly Shrunk' : '✅ OK';

  return {
    content: [{
      type: 'text',
      text: `## File Baseline Comparison\n\n**File:** ${file_path}\n**Status:** ${status}\n\n| Metric | Baseline | Current | Delta |\n|--------|----------|---------|-------|\n| Size | ${result.baseline.size_bytes} bytes | ${result.current.size} bytes | ${result.sizeDelta > 0 ? '+' : ''}${result.sizeDelta} (${result.sizeChangePercent.toFixed(1)}%) |\n| Lines | ${result.baseline.line_count} | ${result.current.lines} | ${result.lineDelta > 0 ? '+' : ''}${result.lineDelta} |`
    }]
  };
}


// ============================================
// Syntax & Diff Handlers
// ============================================

async function handleRunSyntaxCheck(args) {
  try {

  const { file_path, working_directory } = args;


  if (!file_path || !working_directory) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'file_path and working_directory are required');
  }

  const result = await fileTracking.runSyntaxValidation(file_path, working_directory);

  if (!result.validated) {
    return {
      content: [{
        type: 'text',
        text: `## Syntax Check\n\n**File:** ${file_path}\n**Status:** Not validated - ${result.reason || result.error}`
      }]
    };
  }

  const status = result.passed ? '✅ PASSED' : '❌ FAILED';
  let output = `## Syntax Check\n\n**File:** ${file_path}\n**Status:** ${status}\n\n`;

  for (const r of result.results) {
    output += `### ${r.validator}\n- Exit Code: ${r.exitCode}\n- Passed: ${r.success ? 'Yes' : 'No'}\n`;
    if (r.errorOutput) {
      output += `- Error: ${r.errorOutput.slice(0, 500)}\n`;
    }
  }

  return { content: [{ type: 'text', text: output }] };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }}

function handleListSyntaxValidators(_args) {
  let validators;
  try {
    validators = fileTracking.listAllSyntaxValidators ? fileTracking.listAllSyntaxValidators() : [];
  } catch {
    return {
      content: [{
        type: 'text',
        text: `## Syntax Validators\n\nNo validators configured.`
      }]
    };
  }

  if (validators.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## Syntax Validators\n\nNo validators configured.`
      }]
    };
  }

  let output = `## Syntax Validators\n\n| Name | Extensions | Command | Enabled |\n|------|------------|---------|----------|\n`;
  validators.forEach(v => {
    output += `| ${v.name} | ${v.file_extensions} | ${v.command} | ${v.enabled ? '✓' : '✗'} |\n`;
  });

  return { content: [{ type: 'text', text: output }] };
}

function handleRegisterHook(args) {
  const { event_type: eventType, hook_name: hookName } = args;

  const err = requireString(args, 'event_type');
  if (err) return err;

  try {
    const hook = postToolHooks.registerBuiltInHook(eventType, hookName);
    return {
      content: [{
        type: 'text',
        text: `## Hook Registered\n\n**ID:** ${hook.id}\n**Event:** ${hook.event_type}\n**Hook:** ${hook.hook_name}\n**Built-in:** ${hook.built_in ? 'Yes' : 'No'}`
      }],
      hook,
    };
  } catch (hookErr) {
    return makeError(ErrorCodes.INVALID_PARAM, hookErr.message || String(hookErr));
  }
}

function handleListHooks(args) {
  const { event_type: eventType } = args || {};

  try {
    const hooks = postToolHooks.listHooks(eventType);

    if (hooks.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `## Hooks\n\nNo hooks registered${eventType ? ` for ${eventType}` : ''}.`
        }],
        hooks,
      };
    }

    let output = '## Hooks\n\n';
    output += '| ID | Event | Hook | Built-in |\n';
    output += '|----|-------|------|----------|\n';
    for (const hook of hooks) {
      output += `| ${hook.id} | ${hook.event_type} | ${hook.hook_name} | ${hook.built_in ? 'Yes' : 'No'} |\n`;
    }

    return {
      content: [{ type: 'text', text: output }],
      hooks,
    };
  } catch (hookErr) {
    return makeError(ErrorCodes.INVALID_PARAM, hookErr.message || String(hookErr));
  }
}

function handleRemoveHook(args) {
  const err = requireString(args, 'hook_id');
  if (err) return err;

  const removed = postToolHooks.removeHook(args.hook_id);
  if (!removed) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Hook not found: ${args.hook_id}`);
  }

  return {
    content: [{
      type: 'text',
      text: `## Hook Removed\n\n**ID:** ${removed.id}\n**Event:** ${removed.event_type}\n**Hook:** ${removed.hook_name}`
    }],
    hook: removed,
  };
}

function handleCheckApprovalGate(args) {
  const err = requireString(args, 'task_id');
  if (err) return err;

  const result = checkApprovalGate(args.task_id);
  const reasons = result.reasons || [];

  let output = `## Approval Gate\n\n**Task:** ${args.task_id}\n**Approved:** ${result.approved ? 'Yes' : 'No'}\n`;
  if (reasons.length > 0) {
    output += `\n**Reasons:**\n`;
    for (const reason of reasons) {
      output += `- ${reason}\n`;
    }
  }

  return {
    content: [{ type: 'text', text: output }],
    approved: result.approved,
    reasons,
  };
}

function handlePreviewTaskDiff(args) {
  const { task_id } = args;

  const err = requireString(args, 'task_id');
  if (err) return err;

  const { task, error: taskErr } = requireTask(task_id);
  if (taskErr) return taskErr;

  let preview = fileTracking.getDiffPreview(task_id);

  if (!preview) {
    const diff = task.output || 'No diff available - task has no output';
    fileTracking.createDiffPreview(task_id, diff, 0, 0, 0);
    preview = fileTracking.getDiffPreview(task_id);
  }

  return {
    content: [{
      type: 'text',
      text: `## Diff Preview for ${task_id}\n\n**Status:** ${preview.status}\n**Files Changed:** ${preview.files_changed}\n**Lines Added:** +${preview.lines_added}\n**Lines Removed:** -${preview.lines_removed}\n\n\`\`\`diff\n${preview.diff_content.slice(0, 5000)}\n\`\`\``
    }]
  };
}

function handleApproveDiff(args) {
  const { task_id } = args;

  const err = requireString(args, 'task_id');
  if (err) return err;

  fileTracking.markDiffReviewed(task_id, 'user');

  return {
    content: [{
      type: 'text',
      text: `## Diff Approved ✓\n\nTask ${task_id} diff has been approved for commit.`
    }]
  };
}

function handleConfigureDiffPreview(args) {
  const { required } = args;

  database.setConfig('diff_preview_required', required ? '1' : '0');

  return {
    content: [{
      type: 'text',
      text: `## Diff Preview Configuration\n\n**Required:** ${required ? 'Yes' : 'No'}\n\n${required ? 'Tasks will require diff preview approval before committing.' : 'Tasks can commit without diff preview.'}`
    }]
  };
}


// ============================================
// Quality & Provider Scoring Handlers
// ============================================

function handleGetQualityScore(args) {
  const { task_id } = args;

  const err = requireString(args, 'task_id');
  if (err) return err;

  const score = fileTracking.getQualityScore(task_id);

  if (!score) {
    return {
      content: [{
        type: 'text',
        text: `## Quality Score\n\nNo quality score recorded for task ${task_id}.`
      }]
    };
  }

  return {
    content: [{
      type: 'text',
      text: `## Quality Score for ${task_id}\n\n**Overall:** ${score.overall_score.toFixed(1)}/100\n\n| Component | Score |\n|-----------|-------|\n| Validation | ${score.validation_score?.toFixed(1) || 'N/A'} |\n| Syntax | ${score.syntax_score?.toFixed(1) || 'N/A'} |\n| Completeness | ${score.completeness_score?.toFixed(1) || 'N/A'} |\n\n**Provider:** ${score.provider}\n**Task Type:** ${score.task_type}`
    }]
  };
}

function handleGetProviderQuality(args) {
  const { provider } = args;

  const err = requireString(args, 'provider');
  if (err) return err;

  const stats = fileTracking.getProviderQualityStats(provider);

  if (!stats) {
    return {
      content: [{
        type: 'text',
        text: `## Provider Quality\n\nNo quality data for provider ${provider}.`
      }]
    };
  }

  return {
    content: [{
      type: 'text',
      text: `## Quality Stats for ${provider}\n\n- **Total Tasks:** ${stats.total_tasks}\n- **Average Score:** ${stats.avg_score?.toFixed(1) || 'N/A'}/100\n- **Min Score:** ${stats.min_score?.toFixed(1) || 'N/A'}\n- **Max Score:** ${stats.max_score?.toFixed(1) || 'N/A'}`
    }]
  };
}

function handleGetProviderStats(args) {
  const { provider } = args;

  const stats = fileTracking.getProviderStats(provider);

  if (stats.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## Provider Statistics\n\nNo statistics recorded${provider ? ` for ${provider}` : ''}.`
      }]
    };
  }

  let output = `## Provider Statistics\n\n| Provider | Task Type | Total | Success | Failed | Success Rate | Avg Quality |\n|----------|-----------|-------|---------|--------|--------------|-------------|\n`;

  stats.forEach(s => {
    const successRate = s.total_tasks > 0 ? ((s.successful_tasks / s.total_tasks) * 100).toFixed(1) : '0.0';
    output += `| ${s.provider} | ${s.task_type} | ${s.total_tasks} | ${s.successful_tasks} | ${s.failed_tasks} | ${successRate}% | ${s.avg_quality_score?.toFixed(1) || 'N/A'} |\n`;
  });

  return { content: [{ type: 'text', text: output }] };
}

function handleGetBestProvider(args) {
  const { task_type } = args;

  if (task_type === undefined || task_type === null || typeof task_type !== 'string' || task_type.length === 0) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_type is required and must be a non-empty string');
  }

  const best = fileTracking.getBestProviderForTaskType(task_type);

  if (!best) {
    return {
      content: [{
        type: 'text',
        text: `## Best Provider for ${task_type}\n\nNot enough data to recommend a provider. Need at least 3 completed tasks of this type.`
      }]
    };
  }

  return {
    content: [{
      type: 'text',
      text: `## Best Provider for ${task_type}\n\n**Recommended:** ${best.provider}\n- **Success Rate:** ${(best.success_rate * 100).toFixed(1)}%\n- **Avg Quality:** ${best.avg_quality_score?.toFixed(1) || 'N/A'}/100`
    }]
  };
}


// ============================================
// Rollback & Build Handlers
// ============================================

function handleListRollbacks(args) {
  const { status, limit = 50 } = args;

  const rollbacks = fileTracking.listRollbacks(status, limit);

  if (rollbacks.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## Rollback History\n\nNo rollbacks found${status ? ` with status ${status}` : ''}.`
      }]
    };
  }

  let output = `## Rollback History\n\n| Task | Type | Status | Initiated | Reason |\n|------|------|--------|-----------|--------|\n`;

  rollbacks.forEach(r => {
    output += `| ${r.task_id.slice(0, 8)}... | ${r.rollback_type} | ${r.status} | ${r.initiated_at} | ${(r.reason || '').slice(0, 30)} |\n`;
  });

  return { content: [{ type: 'text', text: output }] };
}

async function handleRunBuildCheck(args) {
  try {

  const { task_id, working_directory } = args;


  if (!working_directory) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory is required');
  }

  const result = await fileTracking.runBuildCheck(task_id || 'manual', working_directory);

  if (!result.checked) {
    return {
      content: [{
        type: 'text',
        text: `## Build Check\n\n**Status:** Not checked\n**Reason:** ${result.reason || result.error}`
      }]
    };
  }

  const status = result.passed ? '✅ PASSED' : '❌ FAILED';

  let output = `## Build Check\n\n**Status:** ${status}\n**Command:** ${result.command}\n**Duration:** ${result.duration.toFixed(1)}s\n**Exit Code:** ${result.exitCode}\n`;

  if (result.errorOutput) {
    output += `\n### Errors\n\`\`\`\n${result.errorOutput}\n\`\`\``;
  }

  return { content: [{ type: 'text', text: output }] };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }}

function handleGetBuildResult(args) {
  const { task_id } = args;

  if (!task_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required');
  }

  const result = fileTracking.getBuildCheck(task_id);

  if (!result) {
    return {
      content: [{
        type: 'text',
        text: `## Build Result\n\nNo build check recorded for task ${task_id}.`
      }]
    };
  }

  const status = result.status === 'passed' ? '✅ PASSED' : '❌ FAILED';

  return {
    content: [{
      type: 'text',
      text: `## Build Result for ${task_id}\n\n**Status:** ${status}\n**Command:** ${result.build_command}\n**Duration:** ${result.duration_seconds?.toFixed(1) || 'N/A'}s\n**Checked:** ${result.checked_at}`
    }]
  };
}

function handleConfigureBuildCheck(args) {
  const { enabled } = args;

  database.setConfig('build_check_enabled', enabled ? '1' : '0');

  return {
    content: [{
      type: 'text',
      text: `## Build Check Configuration\n\n**Enabled:** ${enabled ? 'Yes' : 'No'}\n\n${enabled ? 'Build checks will run automatically after code tasks.' : 'Build checks are disabled.'}`
    }]
  };
}

function handleSetupPrecommitHook(args) {
  const { working_directory } = args;
  const checks = normalizePrecommitChecks(args.checks || ['validation', 'syntax']);
  const checksText = checks.length > 0 ? checks.join(', ') : 'none';
  const runValidation = checks.includes('validation');
  const runSyntax = checks.includes('syntax');
  const runBuild = checks.includes('build');

  if (!working_directory) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory is required');
  }

  if (/\.\.[/\\]/.test(working_directory)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'working_directory must not contain ".." path segments');
  }

  const gitDir = path.join(working_directory, '.git');
  if (!fs.existsSync(gitDir)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'Not a git repository');
  }

  const hooksDir = path.join(gitDir, 'hooks');
  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  const configPath = path.join(hooksDir, 'pre-commit.config.json');
  fs.writeFileSync(configPath, JSON.stringify({ checks }, null, 2), { encoding: 'utf-8' });

  const isWindows = process.platform === 'win32';

  let hookPath;
  if (isWindows) {
    let psScript = `# Torque pre-commit hook (PowerShell)\n# Checks: ${checksText}\n\nWrite-Host "Running Torque pre-commit checks..."\n$runValidation = $false\n$runSyntax = $false\n$runBuild = $false\n\n$configPath = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'pre-commit.config.json'\n$runChecks = @()\ntry {\n  $configRaw = Get-Content -Raw -Path $configPath -ErrorAction SilentlyContinue\n  if ($configRaw) {\n    $config = $configRaw | ConvertFrom-Json -ErrorAction Stop\n    if ($config -and $config.checks) {\n      $runChecks = @($config.checks)\n    }\n  }\n} catch {\n  $runChecks = @()\n}\n\nif ($runChecks -contains 'validation') { $runValidation = $true }\nif ($runChecks -contains 'syntax') { $runSyntax = $true }\nif ($runChecks -contains 'build') { $runBuild = $true }\n\nif ($runValidation) {\n`;

    psScript += `# Check for validation failures\n$stubs = Get-ChildItem -Recurse -Include *.cs,*.ts,*.js -File -ErrorAction SilentlyContinue | Select-String -Pattern '// implementation|// TODO' -ErrorAction SilentlyContinue | Select-Object -First 5\nif ($stubs) {\n  $stubs | ForEach-Object { Write-Host $_.ToString() }\n  Write-Host "Warning: Found stub implementations. Consider completing before commit."\n}\n\n`;
    psScript += `# Run syntax checks on staged files\n$stagedCs = git diff --cached --name-only --diff-filter=ACM | Where-Object { $_ -match '\\.cs$' }\nif ($stagedCs) {\n  Write-Host "Checking C# syntax..."\n  dotnet build --no-restore --verbosity quiet 2>$null\n  if ($LASTEXITCODE -ne 0) { Write-Host "Warning: Build check failed" }\n}\n\n`;
    psScript += `# Run build\nif (Test-Path "package.json") {\n  npm run build --if-present 2>$null\n  if ($LASTEXITCODE -ne 0) { Write-Host "Warning: Build failed" }\n} elseif ((Test-Path "*.csproj") -or (Test-Path "*.sln")) {\n  dotnet build --no-restore 2>$null\n  if ($LASTEXITCODE -ne 0) { Write-Host "Warning: Build failed" }\n}\n\n`;
    psScript += `# Allow commit to proceed\nexit 0\n`;

    const psPath = path.join(hooksDir, 'pre-commit.ps1');
    fs.writeFileSync(psPath, psScript, { encoding: 'utf-8' });

    const shimScript = `#!/bin/sh\n# Torque pre-commit hook shim — delegates to PowerShell on Windows\nexec powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(dirname "$0")/pre-commit.ps1"\n`;
    hookPath = path.join(hooksDir, 'pre-commit');
    fs.writeFileSync(hookPath, shimScript, { mode: 0o755 });
  } else {
    let hookScript = `#!/bin/bash\n# Torque pre-commit hook\n# Checks: ${checksText}\n\necho "Running Torque pre-commit checks..."\n\n`;

    if (runValidation) {
      hookScript += `# Check for validation failures\nif grep -rn "// implementation\\\\|// TODO" --include="*.cs" --include="*.ts" --include="*.js" . 2>/dev/null | head -5; then\n  echo "⚠️  Warning: Found stub implementations. Consider completing before commit."\nfi\n\n`;
    }

    if (runSyntax) {
      hookScript += `# Run syntax checks on staged files\nSTAGED_CS=$(git diff --cached --name-only --diff-filter=ACM | grep '\\.cs$')\nif [ -n "$STAGED_CS" ]; then\n  echo "Checking C# syntax..."\n  dotnet build --no-restore --verbosity quiet 2>/dev/null || echo "⚠️  Build check failed"\nfi\n\n`;
    }

    if (runBuild) {
      hookScript += `# Run build\nif [ -f "package.json" ]; then\n  npm run build --if-present 2>/dev/null || echo "⚠️  Build failed"\nelif [ -f "*.csproj" ] || [ -f "*.sln" ]; then\n  dotnet build --no-restore 2>/dev/null || echo "⚠️  Build failed"\nfi\n\n`;
    }

    hookScript += `# Allow commit to proceed\nexit 0\n`;

    hookPath = path.join(hooksDir, 'pre-commit');
    fs.writeFileSync(hookPath, hookScript, { mode: 0o755 });
  }

  return {
    content: [{
      type: 'text',
      text: `## Pre-Commit Hook Installed\n\n**Location:** ${hookPath}\n**Checks:** ${checksText}\n\nThe hook will run before each commit to check for:\n${checks.map(c => `- ${c}`).join('\n')}`
    }]
  };
}


// ============================================
// Cost Handlers (merged from cost.js)
// ============================================

function handleGetCostSummary(args) {
  const parsed = parseInt(args.days, 10);
  const days = Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
  const summary = costTracking.getCostSummary(args.provider, days);
  const data = { days, costs: summary };
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(data, null, 2)
    }],
    structuredData: data,
  };
}

function handleGetBudgetStatus(args) {
  const status = costTracking.getBudgetStatus(args.budget_id);
  const data = { count: status.length, budgets: status };
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(data, null, 2)
    }],
    structuredData: data,
  };
}

function handleSetBudget(args) {
  if (!args.name) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'name is required');
  }
  if (!args.budget_usd || args.budget_usd <= 0) {
    return makeError(ErrorCodes.INVALID_PARAM, 'budget_usd must be a positive number');
  }

  costTracking.setBudget(
    args.name,
    args.budget_usd,
    args.provider || null,
    args.period || 'monthly',
    args.alert_threshold || 80
  );

  return {
    content: [{
      type: 'text',
      text: `Budget "${args.name}" set to $${args.budget_usd} ${args.period || 'monthly'}${args.provider ? ` for ${args.provider}` : ''}`
    }]
  };
}

function handleGetCostForecast(args) {
  const forecast = costTracking.getCostForecast(args.days || 30);
  return {
    content: [{ type: 'text', text: JSON.stringify(forecast, null, 2) }],
    structuredData: { forecast },
  };
}


// ============================================
// Exports — aggregate all sub-modules
// ============================================

function createValidationHandlers() {
  return {
    ...fileHandlers,
    ...xamlHandlers,
    ...securityHandlers,
    ...analysisHandlers,
    ...safeguardHandlers,
    ...failureHandlers,
    handleListValidationRules,
    handleAddValidationRule,
    handleUpdateValidationRule,
    handleValidateTaskOutput,
    handleGetValidationResults,
    handleRejectTask,
    handleCaptureFileBaselines,
    handleCompareFileBaseline,
    handleRunSyntaxCheck,
    handleListSyntaxValidators,
    handleRegisterHook,
    handleListHooks,
    handleRemoveHook,
    handleCheckApprovalGate,
    handlePreviewTaskDiff,
    handleApproveDiff,
    handleConfigureDiffPreview,
    handleGetQualityScore,
    handleGetProviderQuality,
    handleGetProviderStats,
    handleGetBestProvider,
    handleListRollbacks,
    handleRunBuildCheck,
    handleGetBuildResult,
    handleConfigureBuildCheck,
    handleSetupPrecommitHook,
    handleGetCostSummary,
    handleGetBudgetStatus,
    handleSetBudget,
    handleGetCostForecast,
  };
}

module.exports = {
  ...fileHandlers,
  ...xamlHandlers,
  ...securityHandlers,
  ...analysisHandlers,
  ...safeguardHandlers,
  ...failureHandlers,
  handleListValidationRules,
  handleAddValidationRule,
  handleUpdateValidationRule,
  handleValidateTaskOutput,
  handleGetValidationResults,
  handleRejectTask,
  handleCaptureFileBaselines,
  handleCompareFileBaseline,
  handleRunSyntaxCheck,
  handleListSyntaxValidators,
  handleRegisterHook,
  handleListHooks,
  handleRemoveHook,
  handleCheckApprovalGate,
  handlePreviewTaskDiff,
  handleApproveDiff,
  handleConfigureDiffPreview,
  handleGetQualityScore,
  handleGetProviderQuality,
  handleGetProviderStats,
  handleGetBestProvider,
  handleListRollbacks,
  handleRunBuildCheck,
  handleGetBuildResult,
  handleConfigureBuildCheck,
  handleSetupPrecommitHook,
  handleGetCostSummary,
  handleGetBudgetStatus,
  handleSetBudget,
  handleGetCostForecast,
  createValidationHandlers,
};
