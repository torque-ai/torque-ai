'use strict';

const PASSING_OUTCOMES = new Set(['no_change', 'early_exit']);
const FAILING_OUTCOMES = new Set(['error', 'status:failed']);

function createVerificationLedgerStage({ verificationLedger, projectConfigCore }) {

  return async function verificationLedgerStage(ctx) {
    // Check project-level config
    const projectConfig = projectConfigCore.getProjectConfig(ctx.task?.working_directory);
    if (projectConfig && projectConfig.verification_ledger === false) return;
    if (projectConfig && !projectConfig.verification_ledger) return; // off by default

    // Check per-task override
    let metadata = {};
    try { metadata = JSON.parse(ctx.task?.metadata || '{}'); } catch (_) { /* ignore */ }
    if (metadata.verification_ledger === false) return;

    const checks = [];
    const workflowId = ctx.task?.workflow_id || null;

    // Convert each validation stage outcome to a ledger check
    for (const [stageName, outcome] of Object.entries(ctx.validationStages || {})) {
      if (!outcome || outcome.outcome === 'skipped') continue;

      const passed = PASSING_OUTCOMES.has(outcome.outcome)
        ? 1
        : FAILING_OUTCOMES.has(outcome.outcome)
          ? 0
          : 0;
      checks.push({
        task_id: ctx.taskId,
        workflow_id: workflowId,
        phase: 'after',
        check_name: stageName,
        tool: stageName,
        exit_code: passed ? 0 : 1,
        output_snippet: outcome.error ? String(outcome.error).slice(0, 2000) : null,
        passed,
        duration_ms: outcome.duration_ms || null,
      });
    }

    // Record verify_command result if available
    const finalization = metadata.finalization || {};
    const verifyResult = finalization.verify_command_result;
    if (verifyResult) {
      checks.push({
        task_id: ctx.taskId,
        workflow_id: workflowId,
        phase: 'after',
        check_name: 'verify_command',
        tool: 'verify_command',
        command: verifyResult.command || null,
        exit_code: verifyResult.exitCode ?? null,
        output_snippet: verifyResult.output ? String(verifyResult.output).slice(0, 2000) : null,
        passed: verifyResult.exitCode === 0 ? 1 : 0,
        duration_ms: verifyResult.durationMs || null,
      });
    }

    if (checks.length > 0) {
      verificationLedger.insertChecks(checks);
    }
  };
}

module.exports = { createVerificationLedgerStage };
