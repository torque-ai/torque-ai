'use strict';

const logger = require('../logger').child({ component: 'elicitation' });

/**
 * Request structured input from the human user via MCP elicitation.
 * Gracefully degrades: returns { action: 'decline' } when elicitation is unavailable.
 *
 * @param {object|string} sessionOrId - MCP session object or session_id string
 * @param {object} params - { message: string, requestedSchema: object }
 * @returns {Promise<{ action: 'accept'|'decline'|'cancel', content?: object }>}
 */
async function elicit(sessionOrId, params) {
  // Resolve session
  let session = null;
  if (sessionOrId && typeof sessionOrId === 'object' && sessionOrId.supportsElicitation !== undefined) {
    session = sessionOrId;
  } else if (typeof sessionOrId === 'string') {
    // Look up live session from SSE sessions Map
    try {
      const { getSession } = require('../mcp-sse');
      session = getSession(sessionOrId);
    } catch {
      // mcp-sse not available (e.g., stdio-only mode)
    }
  }

  if (!session) {
    logger.debug('[elicit] No session available — declining');
    return { action: 'decline' };
  }

  if (!session.supportsElicitation) {
    logger.debug('[elicit] Client does not support elicitation — declining');
    return { action: 'decline' };
  }

  try {
    const { sendClientRequest } = require('../mcp-sse');
    const result = await sendClientRequest(session.__sessionId || session.sessionId, 'elicitation/create', {
      message: params.message,
      requestedSchema: params.requestedSchema,
    });
    logger.info(`[elicit] Elicitation resolved: action=${result?.action}`);
    return result || { action: 'cancel' };
  } catch (err) {
    logger.warn(`[elicit] Elicitation failed: ${err.message}`);
    return { action: 'cancel' };
  }
}

module.exports = { elicit };
