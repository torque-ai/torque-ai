'use strict';

const INTERACTION_ACTIONS = Object.freeze([
  'click',
  'drag',
  'type',
  'scroll',
  'hotkey',
  'focus',
  'resize',
  'move',
  'maximize',
  'minimize',
  'clipboard',
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function resolveInteractionAdapter(adapter) {
  if (!adapter) return null;
  return INTERACTION_ACTIONS.some((action) => typeof adapter[action] === 'function')
    ? adapter
    : adapter.adapter || null;
}

function normalizeInteractionBody(body) {
  if (body === undefined || body === null) return {};
  if (!isPlainObject(body)) {
    throw createHttpError(400, 'Interaction request body must be a JSON object');
  }
  return { ...body };
}

function normalizeInteractionResult(action, result) {
  if (result === undefined || result === null) {
    return {
      success: true,
      action,
    };
  }

  if (!isPlainObject(result)) {
    return {
      success: true,
      action,
      result,
    };
  }

  return {
    ...result,
    success: true,
    action,
  };
}

function createInteractionHandler(adapter, action) {
  const interactionAdapter = resolveInteractionAdapter(adapter);

  if (!interactionAdapter || typeof interactionAdapter[action] !== 'function') {
    throw new TypeError(`createInteractionHandler requires an adapter with ${action}(options)`);
  }

  return async function handleInteraction(ctx) {
    const body = normalizeInteractionBody(ctx.body);
    const result = await interactionAdapter[action](body);
    return normalizeInteractionResult(action, result);
  };
}

function createInteractionHandlers(adapter) {
  const interactionAdapter = resolveInteractionAdapter(adapter);
  if (!interactionAdapter) return {};

  return INTERACTION_ACTIONS.reduce((handlers, action) => {
    if (typeof interactionAdapter[action] === 'function') {
      handlers[action] = createInteractionHandler(interactionAdapter, action);
    }
    return handlers;
  }, {});
}

module.exports = {
  INTERACTION_ACTIONS,
  createInteractionHandler,
  createInteractionHandlers,
  normalizeInteractionBody,
  normalizeInteractionResult,
};
