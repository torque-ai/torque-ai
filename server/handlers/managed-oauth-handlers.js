'use strict';

const database = require('../database');
const { createAuthConfigStore } = require('../auth/auth-config-store');
const { createConnectedAccountStore } = require('../auth/connected-account-store');
const { createOAuthController } = require('../auth/oauth-controller');
const { createConnectionRegistry } = require('../connections/registry');
const { BEHAVIORAL_TAG_KEYS, applyBehavioralTags, filterByTags } = require('../tools/behavioral-tags');
const { getAnnotations } = require('../tool-annotations');
const { ErrorCodes, makeError } = require('./error-codes');
const { requireString, optionalString } = require('./shared');

function jsonResponse(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredData: data,
  };
}

function getDbHandle() {
  if (database && typeof database.getDbInstance === 'function') {
    return database.getDbInstance();
  }
  return database && typeof database.prepare === 'function' ? database : null;
}

function buildServices() {
  const db = getDbHandle();
  if (!db) {
    return null;
  }

  const authConfigStore = createAuthConfigStore({ db });
  const connectedAccountStore = createConnectedAccountStore({ db });
  return {
    authConfigStore,
    connectedAccountStore,
    oauthController: createOAuthController({
      authConfigStore,
      connectedAccountStore,
      fetchFn: globalThis.fetch,
    }),
    connectionRegistry: createConnectionRegistry({ db }),
  };
}

function getRegisteredTools() {
  const {
    TOOLS,
    decorateToolDefinition,
    getRuntimeRegisteredToolDefs,
  } = require('../tools');
  const remoteAgentToolDefs = require('../plugins/remote-agents/tool-defs');
  const registeredTools = new Map();

  for (const tool of [
    ...TOOLS,
    ...getRuntimeRegisteredToolDefs(),
    ...remoteAgentToolDefs,
  ]) {
    if (!tool || typeof tool.name !== 'string') {
      continue;
    }

    const decoratedTool = typeof decorateToolDefinition === 'function'
      ? decorateToolDefinition(tool)
      : applyBehavioralTags(tool, tool.annotations || getAnnotations(tool.name));
    registeredTools.set(decoratedTool.name, decoratedTool);
  }

  return [...registeredTools.values()];
}

function buildHintFilter(args = {}) {
  return BEHAVIORAL_TAG_KEYS.reduce((acc, key) => {
    if (typeof args[key] === 'boolean') {
      acc[key] = args[key];
    }
    return acc;
  }, {});
}

function toToolSummary(tool) {
  return {
    name: tool.name,
    description: tool.description || '',
    readOnlyHint: Boolean(tool.readOnlyHint),
    destructiveHint: Boolean(tool.destructiveHint),
    idempotentHint: Boolean(tool.idempotentHint),
    openWorldHint: Boolean(tool.openWorldHint),
    annotations: {
      readOnlyHint: Boolean(tool.readOnlyHint),
      destructiveHint: Boolean(tool.destructiveHint),
      idempotentHint: Boolean(tool.idempotentHint),
      openWorldHint: Boolean(tool.openWorldHint),
    },
  };
}

function handleStartOauthFlow(args) {
  try {
    const toolkitError = requireString(args, 'toolkit');
    if (toolkitError) return toolkitError;

    const userIdError = requireString(args, 'user_id');
    if (userIdError) return userIdError;

    const services = buildServices();
    if (!services) {
      return makeError(ErrorCodes.DB_ERROR, 'Database is not initialized');
    }

    const toolkit = args.toolkit.trim();
    const userId = args.user_id.trim();
    const state = userId;
    const authorizeUrl = services.oauthController.startFlow({ toolkit, state });

    return jsonResponse({
      toolkit,
      user_id: userId,
      state,
      authorize_url: authorizeUrl,
    });
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

async function handleCompleteOauthFlow(args) {
  try {
    const toolkitError = requireString(args, 'toolkit');
    if (toolkitError) return toolkitError;

    const userIdError = requireString(args, 'user_id');
    if (userIdError) return userIdError;

    const codeError = requireString(args, 'code');
    if (codeError) return codeError;

    if (typeof globalThis.fetch !== 'function') {
      return makeError(ErrorCodes.OPERATION_FAILED, 'OAuth token exchange requires global fetch support');
    }

    const services = buildServices();
    if (!services) {
      return makeError(ErrorCodes.DB_ERROR, 'Database is not initialized');
    }

    const toolkit = args.toolkit.trim();
    const userId = args.user_id.trim();
    const result = await services.oauthController.exchangeCode({
      toolkit,
      code: args.code.trim(),
      user_id: userId,
    });

    return jsonResponse({
      toolkit,
      user_id: userId,
      connected_account_id: result.connected_account_id,
    });
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

function handleListConnectedAccounts(args) {
  try {
    const userIdError = requireString(args, 'user_id');
    if (userIdError) return userIdError;

    const toolkitError = optionalString(args, 'toolkit');
    if (toolkitError) return toolkitError;

    const services = buildServices();
    if (!services) {
      return makeError(ErrorCodes.DB_ERROR, 'Database is not initialized');
    }

    const filters = { user_id: args.user_id.trim() };
    if (typeof args.toolkit === 'string' && args.toolkit.trim()) {
      filters.toolkit = args.toolkit.trim();
    }

    const accounts = services.connectionRegistry.listConnectedAccounts(filters);
    return jsonResponse({ count: accounts.length, accounts });
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

function handleDisableAccount(args) {
  try {
    const accountIdError = requireString(args, 'account_id');
    if (accountIdError) return accountIdError;

    const services = buildServices();
    if (!services) {
      return makeError(ErrorCodes.DB_ERROR, 'Database is not initialized');
    }

    const accountId = args.account_id.trim();
    const disabled = services.connectionRegistry.disableAccount(accountId);
    if (!disabled) {
      return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Connected account not found: ${accountId}`);
    }

    return jsonResponse({ ok: true, account_id: accountId, status: 'disabled' });
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

function handleDeleteAccount(args) {
  try {
    const accountIdError = requireString(args, 'account_id');
    if (accountIdError) return accountIdError;

    const services = buildServices();
    if (!services) {
      return makeError(ErrorCodes.DB_ERROR, 'Database is not initialized');
    }

    const accountId = args.account_id.trim();
    const deleted = services.connectionRegistry.deleteAccount(accountId);
    if (!deleted) {
      return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Connected account not found: ${accountId}`);
    }

    return jsonResponse({ ok: true, account_id: accountId });
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

function handleListToolsByHints(args) {
  try {
    const filters = buildHintFilter(args);
    const tools = filterByTags(getRegisteredTools(), filters).map(toToolSummary);
    return jsonResponse({
      count: tools.length,
      filters,
      tools,
    });
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

module.exports = {
  handleStartOauthFlow,
  handleCompleteOauthFlow,
  handleListConnectedAccounts,
  handleDisableAccount,
  handleDeleteAccount,
  handleListToolsByHints,
};
