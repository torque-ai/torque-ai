'use strict';

/**
 * Scorer primitives for the Experiment SDK.
 *
 * Scorers are plain reusable functions with the signature:
 *   async (sample, result, context?) => { value: number, ...metadata }
 *
 * Three creation paths:
 *   1. createScorer({ kind, target, grade }) — built-in match/choice/model_graded
 *   2. fromFunction(fn, kind?)               — wrap any (sample, result, context) => score function
 *   3. fromTraceScorer(fn, kind?)            — wrap a function that accepts the production trace
 *                                              shape { input, output, expected, metadata, trace }
 *
 * All three return the same { kind, score } interface consumed by runSample,
 * runExperiment, and composeScorers.
 */

function createScorer({ kind, target, grade }) {
  const score = async (sample, result, context) => {
    const tgt = typeof target === 'function' ? await target(sample, context) : target;
    switch (kind) {
      case 'match':
        return { value: result.output === tgt ? 1 : 0, kind, target: tgt };
      case 'choice':
        return { value: result.output === tgt ? 1 : 0, kind, target: tgt };
      case 'model_graded':
        if (typeof grade !== 'function') throw new Error('model_graded scorer requires grade(sample,result)');
        return { ...(await grade(sample, result, context)), kind };
      default:
        throw new Error(`unknown scorer kind: ${kind}`);
    }
  };
  return { kind, score };
}

/**
 * Wrap a plain function into a scorer.
 *
 * The function receives the same (sample, result, context) triple that
 * runSample passes to every scorer. It must return either:
 *   - a number (interpreted as the score value), or
 *   - an object with at least { value: number }
 *
 * @param {Function} fn - (sample, result, context?) => number | { value, ... }
 * @param {string}   [kind='custom'] - scorer kind label
 * @returns {{ kind: string, score: Function }}
 */
function fromFunction(fn, kind = 'custom') {
  if (typeof fn !== 'function') {
    throw new Error('fromFunction: fn must be a function');
  }

  const score = async (sample, result, context) => {
    const raw = await fn(sample, result, context);
    if (typeof raw === 'number') {
      return { value: raw, kind };
    }
    if (raw && typeof raw === 'object' && typeof raw.value === 'number') {
      return { ...raw, kind: raw.kind || kind };
    }
    throw new Error(`Scorer "${kind}" returned invalid result: expected number or { value: number }`);
  };

  return { kind, score };
}

/**
 * Wrap a trace-shaped scorer function into a standard scorer.
 *
 * Production traces (Plan 78 shape) carry { input, output, expected, metadata, trace }.
 * This adapter maps the (sample, result, context) eval triple into that trace
 * shape so the same scoring function works in both production telemetry and
 * the experiment SDK without modification.
 *
 * @param {Function} fn - ({ input, output, expected, metadata, trace }) => number | { value, ... }
 * @param {string}   [kind='trace'] - scorer kind label
 * @returns {{ kind: string, score: Function }}
 */
function fromTraceScorer(fn, kind = 'trace') {
  if (typeof fn !== 'function') {
    throw new Error('fromTraceScorer: fn must be a function');
  }

  const score = async (sample, result, context) => {
    const traceRecord = {
      input: sample.input !== undefined ? sample.input : sample,
      output: result && result.output !== undefined ? result.output : result,
      expected: sample.expected !== undefined ? sample.expected : undefined,
      metadata: {
        ...(sample.metadata || {}),
        ...(context && context.task ? { task_name: context.task.name } : {}),
      },
      trace: result && result.trace !== undefined ? result.trace : undefined,
    };

    const raw = await fn(traceRecord);
    if (typeof raw === 'number') {
      return { value: raw, kind };
    }
    if (raw && typeof raw === 'object' && typeof raw.value === 'number') {
      return { ...raw, kind: raw.kind || kind };
    }
    throw new Error(`Trace scorer "${kind}" returned invalid result: expected number or { value: number }`);
  };

  return { kind, score };
}

module.exports = { createScorer, fromFunction, fromTraceScorer };
