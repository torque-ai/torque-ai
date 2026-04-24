'use strict';

const { computeBackoff, shouldRetry } = require('./retry-policy');

function withTimeout(promise, ms) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return promise;
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`Activity timed out after ${ms}ms`);
      err.code = 'ACTIVITY_TIMEOUT';
      err.retriable = false;
      reject(err);
    }, ms);

    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function sleep(ms) {
  if (!ms || ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarize(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    return value.slice(0, 200);
  }

  try {
    const serialized = JSON.stringify(value);
    return serialized.length > 200 ? `${serialized.slice(0, 200)}...` : serialized;
  } catch {
    return '[unserializable]';
  }
}

function createActivityRunner({ db, store, journal, logger = console } = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('createActivityRunner requires a database handle');
  }
  if (!store || typeof store.create !== 'function') {
    throw new Error('createActivityRunner requires an activity store');
  }
  if (!journal || typeof journal.write !== 'function') {
    throw new Error('createActivityRunner requires a journal writer');
  }

  async function runActivity({ workflowId, taskId, kind, name, input, fn, options = {} }) {
    if (!kind || typeof kind !== 'string') {
      throw new Error('runActivity requires a kind');
    }
    if (!name || typeof name !== 'string') {
      throw new Error('runActivity requires a name');
    }
    if (typeof fn !== 'function') {
      throw new Error('runActivity requires an activity function');
    }

    const activityId = store.create({ workflowId, taskId, kind, name, input, options });

    if (workflowId) {
      journal.write({
        workflowId,
        taskId,
        type: 'activity_started',
        payload: { activity_id: activityId, kind, name, input },
      });
    }

    const max_attempts = options.max_attempts || 1;
    const policy = options.retry_policy || {};
    let lastError = null;
    let attempt = 0;

    while (attempt < max_attempts) {
      attempt += 1;
      store.markRunning(activityId);

      try {
        const result = await withTimeout(
          Promise.resolve().then(() => fn()),
          options.start_to_close_timeout_ms
        );

        store.complete(activityId, result);

        if (workflowId) {
          journal.write({
            workflowId,
            taskId,
            type: 'activity_completed',
            payload: {
              activity_id: activityId,
              attempt,
              result_summary: summarize(result),
            },
          });
        }

        return { ok: true, value: result, activity_id: activityId, attempt };
      } catch (err) {
        lastError = err;

        if (err?.code === 'ACTIVITY_TIMEOUT') {
          store.fail(activityId, err.message, 'timed_out');
        }

        if (!shouldRetry({ attempt, max_attempts, error: err, policy })) {
          break;
        }

        const backoff = computeBackoff({ attempt: attempt + 1, ...policy });
        await sleep(backoff);
      }
    }

    if (lastError) {
      const finalStatus = lastError.code === 'ACTIVITY_TIMEOUT' ? 'timed_out' : 'failed';

      if (finalStatus === 'failed') {
        store.fail(activityId, lastError.message, finalStatus);
      }

      if (workflowId) {
        try {
          journal.write({
            workflowId,
            taskId,
            type: 'activity_failed',
            payload: {
              activity_id: activityId,
              attempt,
              error: lastError.message,
              status: finalStatus,
            },
          });
        } catch (journalErr) {
          if (typeof logger?.warn === 'function') {
            logger.warn('Failed to write activity failure event', {
              activity_id: activityId,
              error: journalErr.message,
            });
          }
        }
      }
    }

    return {
      ok: false,
      error: lastError?.message || 'unknown',
      attempt,
      activity_id: activityId,
    };
  }

  function heartbeat(activityId) {
    store.heartbeat(activityId);
  }

  return { runActivity, heartbeat };
}

module.exports = { createActivityRunner };
