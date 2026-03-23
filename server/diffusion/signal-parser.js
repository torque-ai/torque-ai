'use strict';

const { validateDiffusionPlan } = require('./plan-schema');
const logger = require('../logger').child({ component: 'diffusion-signal-parser' });

const SIGNAL_START = '__DIFFUSION_REQUEST__';
const SIGNAL_END = '__DIFFUSION_REQUEST_END__';
const SCAN_LIMIT = 8 * 1024; // Only scan last 8KB

function parseDiffusionSignal(output) {
  if (!output || typeof output !== 'string') return null;

  // Only scan the tail of the output to survive truncation
  const tail = output.length > SCAN_LIMIT
    ? output.slice(-SCAN_LIMIT)
    : output;

  const startIdx = tail.indexOf(SIGNAL_START);
  if (startIdx === -1) return null;

  const endIdx = tail.indexOf(SIGNAL_END, startIdx);
  if (endIdx === -1) return null;

  const jsonStr = tail.slice(startIdx + SIGNAL_START.length, endIdx).trim();

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    logger.info(`[DiffusionSignal] Malformed JSON in diffusion request: ${err.message}`);
    return null;
  }

  const validation = validateDiffusionPlan(parsed);
  if (!validation.valid) {
    logger.info(`[DiffusionSignal] Schema validation failed: ${validation.errors.join('; ')}`);
    return null;
  }

  return parsed;
}

module.exports = { parseDiffusionSignal, SIGNAL_START, SIGNAL_END, SCAN_LIMIT };
