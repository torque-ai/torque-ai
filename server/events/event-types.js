'use strict';

const EVENT_TYPES = {
  TASK_CREATED: 'task.created',
  TASK_QUEUED: 'task.queued',
  TASK_RUNNING: 'task.running',
  TASK_COMPLETED: 'task.completed',
  TASK_FAILED: 'task.failed',
  TASK_CANCELLED: 'task.cancelled',
  TASK_SKIPPED: 'task.skipped',
  TASK_REQUEUED: 'task.requeued',
  TOOL_CALLED: 'tool.called',
  PROVIDER_ROUTED: 'provider.routed',
  PROVIDER_FAILOVER: 'provider.failover',
  VERIFY_RAN: 'verify.ran',
  VERIFY_TAG_ASSIGNED: 'verify.tag.assigned',
  RETRY_SCHEDULED: 'retry.scheduled',
  GOAL_GATE_EVALUATED: 'goal_gate.evaluated',
  WORKFLOW_STARTED: 'workflow.started',
  WORKFLOW_COMPLETED: 'workflow.completed',
  WORKFLOW_FAILED: 'workflow.failed',
  BUDGET_BREACHED: 'budget.breached',
};

module.exports = { EVENT_TYPES };
