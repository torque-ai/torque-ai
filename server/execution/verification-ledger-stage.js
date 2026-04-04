'use strict';

const PASSING_OUTCOMES = ['no_change', 'early_exit'];
const { normalizeMetadata } = require('../utils/normalize-metadata');

function safeParseMetadata(task) {
  if (!task) return {};
  return normalizeMetadata(task.metadata);
}

function createVerificationLedgerStage({ verificationLedger, projectConfigCore }) {
  return async function verificationLedgerStage(ctx) {
    const projectConfig = projectConfigCore.getProjectConfig(ctx.task?.working_directory);
    if (!projectConfig || projectConfig.verification_ledger !== true) return;

    const metadata = safeParseMetadata(ctx.task);
    if (metadata.verification_ledger === false) return;

    const checks = [];
    const workflowId = ctx.task?.workflow_id || null;
    const taskId = ctx.task?.id || ctx.taskId;

    for (const [stageName, outcome] of Object.entries(ctx.validationStages || {})) {
      if (!outcome || outcome.outcome === 'skipped') continue;

      const passed = PASSING_OUTCOMES.includes(outcome.outcome) ? 1 : 0;
      checks.push({
        task_id: taskId,
        workflow_id: workflowId,
        phase: 'after',
        check_name: stageName,
        tool: stageName,
        output_snippet: outcome.error ? String(outcome.error).slice(0, 2000) : null,
        passed,
        duration_ms: outcome.duration_ms || null,
      });
    }

    const finalization = metadata.finalization || {};
    const verifyResult = finalization.verify_command_result;
    if (verifyResult) {
      const output = verifyResult.output || null;
      const exitCode = typeof verifyResult.exit_code === 'number' ? verifyResult.exit_code : verifyResult.exitCode;
      const duration = verifyResult.duration || verifyResult.durationMs;

      checks.push({
        task_id: taskId,
        workflow_id: workflowId,
        phase: 'after',
        check_name: 'verify_command',
        tool: 'verify_command',
        command: verifyResult.command || null,
        exit_code: exitCode,
        output,
        output_snippet: output ? String(output).slice(0, 2000) : null,
        duration,
        duration_ms: duration || null,
        passed: exitCode === 0 ? 1 : 0,
      });
    }

    if (checks.length > 0) {
      verificationLedger.insertChecks(checks);
    }
  };
}

module.exports = { createVerificationLedgerStage };
