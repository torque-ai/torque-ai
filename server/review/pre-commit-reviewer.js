'use strict';

const Ajv = require('ajv');
const { REVIEW_SCHEMA, buildReviewPrompt } = require('./review-prompt');
const logger = require('../logger').child({ component: 'pre-commit-review' });

const ajv = new Ajv({ strict: false });
const validateReview = ajv.compile(REVIEW_SCHEMA);
const REVIEWER_PROVIDER_ORDER = ['claude-cli', 'anthropic', 'codex'];

function parseReviewOutput(output) {
  if (typeof output === 'string') {
    return JSON.parse(output);
  }
  if (
    output
    && typeof output === 'object'
    && !Array.isArray(output)
    && typeof output.output === 'string'
    && !Object.prototype.hasOwnProperty.call(output, 'verdict')
  ) {
    return JSON.parse(output.output);
  }
  return output;
}

async function defaultRunLLM(prompt) {
  const providerRegistry = require('../providers/registry');

  for (const providerName of REVIEWER_PROVIDER_ORDER) {
    const provider = providerRegistry.getProviderInstance(providerName);
    if (provider && typeof provider.runPrompt === 'function') {
      return provider.runPrompt({
        prompt,
        format: 'json',
        max_tokens: 2000,
      });
    }
  }

  throw new Error('No reviewer provider available');
}

function errorMessage(error) {
  return error && typeof error.message === 'string' ? error.message : String(error);
}

function fallbackPass(note) {
  return {
    verdict: 'pass',
    issues: [{ severity: 'low', note }],
    suggestions: [],
  };
}

async function reviewDiff({ diff, contextFiles = [], runLLM = defaultRunLLM }) {
  if (!diff || String(diff).trim() === '') {
    return { verdict: 'pass', issues: [], suggestions: [], note: 'empty diff' };
  }

  let rawOutput;
  try {
    rawOutput = await runLLM(buildReviewPrompt(diff, contextFiles));
  } catch (error) {
    const message = errorMessage(error);
    logger.info(`[pre-commit-review] reviewer unavailable: ${message}`);
    return fallbackPass(`reviewer unavailable: ${message}`);
  }

  let raw;
  try {
    raw = parseReviewOutput(rawOutput);
  } catch {
    logger.info('[pre-commit-review] reviewer returned malformed JSON');
    return fallbackPass('reviewer returned malformed JSON; treating as pass');
  }

  if (!validateReview(raw)) {
    logger.info('[pre-commit-review] reviewer returned malformed JSON');
    return fallbackPass('reviewer schema invalid; treating as pass');
  }

  return {
    verdict: raw.verdict,
    issues: raw.issues,
    suggestions: Array.isArray(raw.suggestions) ? raw.suggestions : [],
  };
}

module.exports = { reviewDiff };
