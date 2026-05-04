'use strict';

const logger = require('../logger').child({ component: 'sampling' });

const SAMPLING_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes (shorter than elicitation)

/**
 * Request an LLM completion from the host client via MCP sampling.
 * Gracefully degrades: returns { action: 'decline' } when sampling is unavailable.
 *
 * @param {object|string} sessionOrId - MCP session object or session_id string
 * @param {object} params - { messages: Array, maxTokens?: number, temperature?: number, modelPreferences?: object }
 * @returns {Promise<{ content?: object, model?: string, action?: string }>}
 */
async function sample(sessionOrId, params) {
  let session = null;
  if (sessionOrId && typeof sessionOrId === 'object' && sessionOrId.supportsSampling !== undefined) {
    session = sessionOrId;
  } else if (typeof sessionOrId === 'string') {
    try {
      const { getSession } = require('./sse');
      session = getSession(sessionOrId);
    } catch {
      // mcp-sse not available
    }
  }

  if (!session) {
    logger.debug('[sample] No session available — declining');
    return { action: 'decline' };
  }

  if (!session.supportsSampling) {
    logger.debug('[sample] Client does not support sampling — declining');
    return { action: 'decline' };
  }

  try {
    const { sendClientRequest } = require('./sse');
    const result = await sendClientRequest(
      session.__sessionId || session.sessionId,
      'sampling/createMessage',
      {
        messages: params.messages || [],
        maxTokens: params.maxTokens || 4096,
        ...(params.temperature != null ? { temperature: params.temperature } : {}),
        ...(params.modelPreferences ? { modelPreferences: params.modelPreferences } : {}),
      },
      SAMPLING_TIMEOUT_MS
    );
    logger.info(`[sample] Sampling resolved: model=${result?.model || 'unknown'}`);
    return result || { action: 'cancel' };
  } catch (err) {
    logger.warn(`[sample] Sampling failed: ${err.message}`);
    return { action: 'cancel' };
  }
}

module.exports = { sample, SAMPLING_TIMEOUT_MS };
