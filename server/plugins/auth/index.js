'use strict';

const fs = require('fs');
const path = require('path');

const { createKeyManager } = require('./key-manager');
const { createUserManager } = require('./user-manager');
const { createSessionManager } = require('./session-manager');
const { createAuthMiddleware } = require('./middleware');
const { createResolvers } = require('./resolvers');
const { createRoleGuard, ROLE_HIERARCHY } = require('./role-guard');
const { createSseAuth } = require('./sse-auth');
const { createConfigInjector } = require('./config-injector');
const { AuthRateLimiter } = require('./rate-limiter');

const PLUGIN_NAME = 'auth';
const PLUGIN_VERSION = '1.0.0';
const KEY_FILENAME = '.torque-api-key';
const BOOTSTRAP_KEY_NAME = 'Bootstrap Admin Key';
const DEFAULT_SSE_PORT = 3458;

function getContainerService(container, name) {
  if (!container || typeof container.get !== 'function') {
    return null;
  }

  try {
    return container.get(name);
  } catch {
    return null;
  }
}

function resolveLogger(logger) {
  return {
    info: logger && typeof logger.info === 'function' ? logger.info.bind(logger) : () => {},
    warn: logger && typeof logger.warn === 'function' ? logger.warn.bind(logger) : () => {},
  };
}

function resolveRawDb(dbService) {
  const rawDb = dbService && typeof dbService.getDbInstance === 'function'
    ? dbService.getDbInstance()
    : dbService;

  if (!rawDb || typeof rawDb.prepare !== 'function') {
    throw new Error('auth plugin requires container db service with prepare() or getDbInstance()');
  }

  return rawDb;
}

function resolveSsePort(serverConfig) {
  if (serverConfig && typeof serverConfig.getInt === 'function') {
    return serverConfig.getInt('sse_port', DEFAULT_SSE_PORT);
  }

  if (serverConfig && typeof serverConfig.get === 'function') {
    const rawValue = serverConfig.get('sse_port');
    const parsed = Number.parseInt(rawValue, 10);
    return Number.isFinite(parsed) ? parsed : DEFAULT_SSE_PORT;
  }

  return DEFAULT_SSE_PORT;
}

function writeBootstrapKeyFile(dataDir, key, logger) {
  if (!dataDir || typeof dataDir !== 'string' || !key) {
    return null;
  }

  const keyPath = path.join(dataDir, KEY_FILENAME);
  try {
    fs.writeFileSync(keyPath, key, { mode: 0o600 });
    return keyPath;
  } catch (error) {
    logger.warn(`[auth-plugin] Failed to write bootstrap key file ${keyPath}: ${error.message}`);
    return null;
  }
}

function createAuthPlugin() {
  let db = null;
  let keyManager = null;
  let userManager = null;
  let sessionManager = null;
  let sseAuth = null;
  let roleGuard = null;
  let rateLimiter = null;
  let resolvers = null;
  let authMiddleware = null;
  let configInjector = null;
  let eventBus = null;
  let logger = resolveLogger(null);
  let installed = false;

  function install(container) {
    const dbService = getContainerService(container, 'db');
    const serverConfig = getContainerService(container, 'serverConfig');

    db = resolveRawDb(dbService);
    eventBus = getContainerService(container, 'eventBus');
    logger = resolveLogger(getContainerService(container, 'logger'));

    keyManager = createKeyManager({ db });
    userManager = createUserManager({ db });
    sessionManager = createSessionManager();
    sseAuth = createSseAuth();
    roleGuard = createRoleGuard();
    rateLimiter = new AuthRateLimiter();
    resolvers = createResolvers({ keyManager, sseAuth, sessionManager, roleGuard });
    authMiddleware = createAuthMiddleware({ keyManager, userManager, resolvers, roleGuard, rateLimiter });
    configInjector = createConfigInjector({ logger });

    let bootstrapKey = null;
    if (!keyManager.hasAnyKeys()) {
      const migratedKeyId = keyManager.migrateConfigApiKey();
      if (!migratedKeyId) {
        const createdKey = keyManager.createKey({ name: BOOTSTRAP_KEY_NAME, role: 'admin' });
        bootstrapKey = createdKey.key;
        logger.info(`[auth-plugin] Bootstrap admin API key created: ${createdKey.key} (id: ${createdKey.id}). Key written to bootstrap file.`);

        const dataDir = dbService && typeof dbService.getDataDir === 'function'
          ? dbService.getDataDir()
          : null;
        writeBootstrapKeyFile(dataDir, createdKey.key, logger);
      }
    }

    const dataDir = dbService && typeof dbService.getDataDir === 'function'
      ? dbService.getDataDir()
      : null;
    const injectionKey = bootstrapKey || (configInjector ? configInjector.readKeyFromFile(dataDir) : null);

    // Only rewrite ~/.claude/.mcp.json when auth is actually the enforced mode.
    // The loader already gates this plugin to enterprise mode in practice, but
    // if the plugin is ever loaded otherwise (tests, diagnostics, future
    // plugin-manager UI) we should not stomp the user's MCP config with a
    // keyed URL that nothing on the HTTP layer will validate anyway.
    const envAuthMode = process.env.TORQUE_AUTH_MODE;
    const dbAuthMode = dbService && typeof dbService.getConfig === 'function'
      ? dbService.getConfig('auth_mode')
      : null;
    const authMode = envAuthMode || dbAuthMode || 'local';
    if (configInjector && authMode === 'enterprise') {
      configInjector.ensureGlobalMcpConfig(injectionKey, {
        ssePort: resolveSsePort(serverConfig),
      });
    } else if (configInjector) {
      logger.info(`[auth-plugin] Skipping MCP config injection (auth_mode=${authMode}).`);
    }

    installed = true;
  }

  function uninstall() {
    db = null;
    keyManager = null;
    userManager = null;
    sessionManager = null;
    sseAuth = null;
    roleGuard = null;
    rateLimiter = null;
    resolvers = null;
    authMiddleware = null;
    configInjector = null;
    eventBus = null;
    logger = resolveLogger(null);
    installed = false;
  }

  function middleware() {
    if (!installed || !authMiddleware) {
      return [];
    }

    return authMiddleware.authenticate;
  }

  function mcpTools() {
    if (!installed || !keyManager) {
      return [];
    }

    return [
      {
        name: 'create_api_key',
        description: 'Create a new TORQUE API key and return the raw key once.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Human-readable key name.' },
            role: {
              type: 'string',
              enum: ROLE_HIERARCHY,
              default: 'admin',
              description: 'Role granted to the new API key.',
            },
          },
          required: ['name'],
          additionalProperties: false,
        },
        handler(args = {}) {
          const { name, role = 'admin' } = args;
          const createdKey = keyManager.createKey({ name, role });
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  id: createdKey.id,
                  name: createdKey.name,
                  role: createdKey.role,
                  key: createdKey.key,
                }, null, 2),
              },
            ],
          };
        },
      },
      {
        name: 'list_api_keys',
        description: 'List API keys without exposing raw keys or hashes.',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        handler() {
          const keys = keyManager.listKeys().map((key) => ({
            id: key.id,
            name: key.name,
            role: key.role,
            created_at: key.created_at,
            last_used_at: key.last_used_at,
            revoked_at: key.revoked_at,
            user_id: key.user_id,
          }));

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(keys, null, 2),
              },
            ],
          };
        },
      },
      {
        name: 'revoke_api_key',
        description: 'Revoke an API key by key ID.',
        inputSchema: {
          type: 'object',
          properties: {
            key_id: { type: 'string', description: 'API key ID to revoke.' },
          },
          required: ['key_id'],
          additionalProperties: false,
        },
        handler(args = {}) {
          const keyId = args.key_id || args.id;
          if (!keyId || typeof keyId !== 'string') {
            throw new Error('key_id is required');
          }

          keyManager.revokeKey(keyId);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ revoked: true, key_id: keyId }, null, 2),
              },
            ],
          };
        },
      },
    ];
  }

  function eventHandlers() {
    if (!installed || !eventBus) {
      return {};
    }

    return {};
  }

  function configSchema() {
    return {
      type: 'object',
      properties: {
        auth_mode: {
          type: 'string',
          enum: ['open', 'api_key', 'full'],
          default: 'api_key',
          description: 'Authentication mode for HTTP, SSE, and MCP requests.',
        },
        bootstrap_admin_key_name: {
          type: 'string',
          default: BOOTSTRAP_KEY_NAME,
          description: 'Display name used when the first bootstrap admin key is created.',
        },
      },
      additionalProperties: true,
    };
  }

  return {
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    install,
    uninstall,
    middleware,
    mcpTools,
    eventHandlers,
    configSchema,
  };
}

const authPlugin = createAuthPlugin();

module.exports = authPlugin;
module.exports.createAuthPlugin = createAuthPlugin;
