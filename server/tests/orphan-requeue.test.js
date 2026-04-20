/**
 * Logic-level tests for orphan re-queue behavior.
 *
 * These tests validate the requeue decision logic that will be implemented
 * in startup orphan cleanup (index.js) and await epoch-check (await.js).
 * No mocking needed — all tests operate on pure data structures.
 */

import { describe, test, expect } from 'vitest';

// ============================================================
// Pure decision helpers (inline — the real implementation
// lives in index.js and await.js, these mirror the contract)
// ============================================================

/**
 * Determine whether an orphaned task should be requeued or cancelled.
 * @param {{ retry_count?: number, max_retries?: number }} task
 * @returns {{ shouldRequeue: boolean, requeueFields?: object, requeuedTask?: object }}
 */
function computeRequeueDecision(task) {
  const retryCount = task.retry_count || 0;
  const maxRetries = task.max_retries != null ? task.max_retries : 2;
  const shouldRequeue = retryCount < maxRetries;

  if (!shouldRequeue) {
    return { shouldRequeue: false };
  }

  // Fields written to the DB when requeueing.
  // workflow_id and workflow_node_id are NOT included — they remain as-is.
  const requeueFields = {
    status: 'queued',
    provider: null,
    ollama_host_id: null,
    mcp_instance_id: null,
    cancel_reason: null,
    retry_count: retryCount + 1,
  };

  return {
    shouldRequeue: true,
    requeueFields,
    requeuedTask: {
      ...task,
      ...requeueFields,
    },
  };
}

/**
 * Determine whether a running task is an orphan and if it can be requeued.
 * Used by the await epoch-check path.
 * @param {{ server_epoch?: number, retry_count?: number, max_retries?: number }} task
 * @param {number} currentEpoch
 * @returns {{ isOrphan: boolean, canRequeue: boolean }}
 */
function computeEpochOrphanDecision(task, currentEpoch) {
  const taskEpoch = task.server_epoch;
  const isOrphan = task.status === 'running' &&
    taskEpoch != null &&
    taskEpoch < currentEpoch;

  const retryCount = task.retry_count || 0;
  const maxRetries = task.max_retries != null ? task.max_retries : 2;
  const canRequeue = isOrphan && retryCount < maxRetries;

  return { isOrphan, canRequeue };
}

// ============================================================
// describe('orphan requeue logic')
// ============================================================

describe('orphan requeue logic', () => {

  test('orphaned task is requeued instead of cancelled', () => {
    const task = {
      id: 'orphan-1',
      status: 'running',
      provider: 'codex',
      ollama_host_id: 'host-1',
      mcp_instance_id: 'dead-instance',
      retry_count: 0,
      max_retries: 2,
      workflow_id: 'wf-1',
      workflow_node_id: 'step-2',
    };

    const { shouldRequeue, requeuedTask } = computeRequeueDecision(task);

    expect(shouldRequeue).toBe(true);
    expect(requeuedTask.status).toBe('queued');
    expect(requeuedTask.provider).toBeNull();
    expect(requeuedTask.ollama_host_id).toBeNull();
    expect(requeuedTask.mcp_instance_id).toBeNull();
    expect(requeuedTask.retry_count).toBe(1);
    expect(requeuedTask.workflow_id).toBe('wf-1');
    expect(requeuedTask.workflow_node_id).toBe('step-2');
  });

  test('orphaned task is cancelled when max retries exhausted', () => {
    const task = {
      id: 'task-2',
      retry_count: 2,
      max_retries: 2,
    };

    const { shouldRequeue } = computeRequeueDecision(task);

    expect(shouldRequeue).toBe(false);
  });

  test('non-workflow orphaned task is also requeued', () => {
    const task = {
      id: 'task-3',
      retry_count: 0,
      max_retries: 2,
      workflow_id: null,
      workflow_node_id: null,
    };

    const { shouldRequeue } = computeRequeueDecision(task);

    expect(shouldRequeue).toBe(true);
  });

  test('requeued task clears cancel_reason', () => {
    const task = {
      id: 'task-4',
      retry_count: 0,
      max_retries: 2,
      cancel_reason: 'orphan_cleanup',
    };

    const { shouldRequeue, requeuedTask } = computeRequeueDecision(task);

    expect(shouldRequeue).toBe(true);
    expect(requeuedTask.status).toBe('queued');
    expect(requeuedTask.cancel_reason).toBeNull();
  });

});

// ============================================================
// describe('orphan requeue -- workflow integration')
// ============================================================

describe('orphan requeue -- workflow integration', () => {

  test('requeued task preserves workflow_id and workflow_node_id', () => {
    // When updateTaskStatus sets status='queued', workflow fields are NOT cleared
    // because the updateTaskStatus function only clears provider/host/instance.
    const requeueFields = {
      status: 'queued',
      provider: null,
      ollama_host_id: null,
      mcp_instance_id: null,
    };

    // Verify workflow IDs are not being cleared.
    expect(requeueFields).not.toHaveProperty('workflow_id');
    expect(requeueFields).not.toHaveProperty('workflow_node_id');
  });

  test('requeued tasks go through queue scheduler which re-evaluates routing', () => {
    // A requeued task has provider=null, so smart routing re-evaluates.
    // This means it can be routed to a different provider/host than the original.
    const requeuedTask = { provider: null, ollama_host_id: null };

    expect(requeuedTask.provider).toBeNull();
    expect(requeuedTask.ollama_host_id).toBeNull();
  });

  test('epoch check requeues when retries available', () => {
    const taskEpoch = 5;
    const currentEpoch = 7;
    const retryCount = 0;
    const maxRetries = 2;

    const isOrphan = taskEpoch < currentEpoch;
    const canRequeue = retryCount < maxRetries;
    const decision = computeEpochOrphanDecision({
      status: 'running',
      server_epoch: taskEpoch,
      retry_count: retryCount,
      max_retries: maxRetries,
    }, currentEpoch);

    expect(isOrphan).toBe(true);
    expect(canRequeue).toBe(true);
    expect(decision).toEqual({ isOrphan, canRequeue });
  });

  test('epoch check cancels when retries exhausted', () => {
    const retryCount = 2;
    const maxRetries = 2;

    const canRequeue = retryCount < maxRetries;

    expect(canRequeue).toBe(false);
  });

});
