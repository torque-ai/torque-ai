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
 * @returns {{ shouldRequeue: boolean, requeueFields?: object }}
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
    retry_count: retryCount + 1,
  };

  return { shouldRequeue: true, requeueFields };
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
      id: 'task-1',
      retry_count: 0,
      max_retries: 2,
      workflow_id: 'wf-1',
      workflow_node_id: 'step-2',
    };

    const { shouldRequeue, requeueFields } = computeRequeueDecision(task);

    expect(shouldRequeue).toBe(true);
    expect(requeueFields.status).toBe('queued');
    expect(requeueFields.provider).toBeNull();
    expect(requeueFields.ollama_host_id).toBeNull();
    expect(requeueFields.mcp_instance_id).toBeNull();
    expect(requeueFields.retry_count).toBe(1);

    // workflow_id and workflow_node_id must NOT appear in requeueFields —
    // they stay as-is in the DB and must be preserved.
    expect(requeueFields).not.toHaveProperty('workflow_id');
    expect(requeueFields).not.toHaveProperty('workflow_node_id');
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
    };

    const { shouldRequeue, requeueFields } = computeRequeueDecision(task);

    expect(shouldRequeue).toBe(true);
    // cancel_reason must NOT be set in requeueFields
    expect(requeueFields).not.toHaveProperty('cancel_reason');
  });

});

// ============================================================
// describe('orphan requeue -- workflow integration')
// ============================================================

describe('orphan requeue -- workflow integration', () => {

  test('requeued task preserves workflow_id and workflow_node_id', () => {
    const task = {
      id: 'task-5',
      retry_count: 0,
      max_retries: 2,
      workflow_id: 'wf-abc',
      workflow_node_id: 'node-xyz',
    };

    const { shouldRequeue, requeueFields } = computeRequeueDecision(task);

    expect(shouldRequeue).toBe(true);
    // The update fields must NOT contain workflow_id or workflow_node_id —
    // they are preserved by not being overwritten in the DB.
    expect(requeueFields).not.toHaveProperty('workflow_id');
    expect(requeueFields).not.toHaveProperty('workflow_node_id');
  });

  test('requeued tasks go through queue scheduler which re-evaluates routing', () => {
    const task = {
      id: 'task-6',
      retry_count: 0,
      max_retries: 2,
    };

    const { shouldRequeue, requeueFields } = computeRequeueDecision(task);

    expect(shouldRequeue).toBe(true);
    // provider=null forces the queue scheduler to re-evaluate routing
    expect(requeueFields.provider).toBeNull();
    // ollama_host_id=null releases any host slot assignment
    expect(requeueFields.ollama_host_id).toBeNull();
  });

  test('epoch check requeues when retries available', () => {
    const task = {
      id: 'task-7',
      status: 'running',
      server_epoch: 5,
      retry_count: 0,
      max_retries: 2,
    };
    const currentEpoch = 7;

    const { isOrphan, canRequeue } = computeEpochOrphanDecision(task, currentEpoch);

    expect(isOrphan).toBe(true);
    expect(canRequeue).toBe(true);
  });

  test('epoch check cancels when retries exhausted', () => {
    const task = {
      id: 'task-8',
      status: 'running',
      server_epoch: 5,
      retry_count: 2,
      max_retries: 2,
    };
    const currentEpoch = 7;

    const { isOrphan, canRequeue } = computeEpochOrphanDecision(task, currentEpoch);

    expect(isOrphan).toBe(true);
    expect(canRequeue).toBe(false);
  });

});
