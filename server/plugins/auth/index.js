'use strict';

const fs = require('fs');
const path = require('path');

const { createKeyManager } = require('./key-manager');
const { createUserManager } = require('./user-manager');
const { createSessionManager } = require('./session-manager');
const { createAuthMiddleware } = require('./middleware');
const { createResolvers } = require('./resolvers');
const { createRoleGuard } = require('./role-guard');
const { createSseAuth } = require('./sse-auth');
const { createConfigInjector } = require('./config-injector');
const { AuthRateLimiter } = require('./rate-limiter');

const PLUGIN_NAME = 'auth';
const PLUGIN_VERSION = '1.0.0';
const KEY_FILENAME = '.torque-api-key';

function createAuthPlugin() {
  let keyManager = null;
  let userManager = null;
  let sessionManager = null;
  let sseAuth = null;
  let roleGuard = null;
  let rateLimiter = null;
  let resolvers = null;
  let authMiddleware = null;
  let configInjector = null;
  let installed = false;

  function install(container) {
    const db = container.get('db');
    const serverConfig = container.get('serverConfig');
    const eventBus = container.get('eventBus');

    const rawDb = typeof db.getDbInstance === 'function' ? db.getDbInstance() : db;

    keyManager = createKeyManager({ db: rawDb });
    userManager = createUserManager({ db: rawDb });
    sessionManager = createSessionManager();
    sseAuth = createSseAuth();
    roleGuard = createRoleGuard();
    rateLimiter = new AuthRateLimiter();
    configInjector = createConfigInjector({ logger: { info() {} } });

    resolvers = createResolvers({ keyManager, sseAuth, sessionManager });
    authMiddleware = createAuthMiddleware({ keyManager, userManager, resolvers });

    // Bootstrap key flow: create first admin key if none exist
    if (!keyManager.hasAnyKeys()) {
      // Attempt migration of legacy config-based API key first
      const migratedId = keyManager.migrateConfigApiKey();

      if (!migratedId) {
        const result = keyManager.createKey({ name: 'Bootstrap Admin Key', role: 'admin' });

        // Write plaintext key to .torque-api-key file
        const dataDir = typeof db.getDataDir === 'function' ? db.getDataDir() : null;
        if (dataDir) {
          try {
            const keyPath = path.join(dataDir, KEY_FILENAME);
            fs.writeFileSync(keyPath, result.key, { mode: 0o600 });
          } catch {
            // best effort — key was already returned from createKey
          }

          // Inject MCP config so Claude Code sessions can connect
          const ssePort = serverConfig && typeof serverConfig.getInt === 'function'
            ? serverConfig.getInt('sse_port', 3458)
            : 3458;
          configInjector.ensureGlobalMcpConfig(result.key, { ssePort });
        }
      }
    }

    installed = true;
  }

  function uninstall() {
    keyManager = null;
    userManager = null;
    sessionManager = null;
    sseAuth = null;
    roleGuard = null;
    rateLimiter = null;
    resolvers = null;
    authMiddleware = null;
    configInjector = null;
    installed = false;
  }

  function middleware() {
    if (!installed || !authMiddleware) return [];
    return authMiddleware.authenticate;
  }

  function mcpTools() {
    if (!installed) return [];

    return [
      {
        name: 'create_api_key',
        description: 'Create a new TORQUE API key',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Human-readable key name' },
            role: {
              type: 'string',
              enum: ['admin', 'operator'],
              default: 'admin',
              description: 'Key role (admin or operator)',
            },
          },
          required: ['name'],
        },
        handler(params) {
          const { name, role = 'admin' } = params || {};
          if (!name || typeof name !== 'string') {
            throw new Error('name is required');
          }
          const result = keyManager.createKey({ name, role });
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  id: result.id,
                  key: result.key,
                  name: result.name,
                  role: result.role,
                }, null, 2),
              },
            ],
          };
        },
      },
      {
        name: 'list_api_keys',
        description: 'List all TORQUE API keys (hashes are never exposed)',
        inputSchema: {
          type: 'object',
          properties: {},
        },
        handler() {
          const keys = keyManager.listKeys();
          const safe = keys.map((k) => ({
            id: k.id,
            name: k.name,
            role: k.role,
            created_at: k.created_at,
            last_used_at: k.last_used_at,
            revoked_at: k.revoked_at,
            user_id: k.user_id,
          }));
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(safe, null, 2),
              },
            ],
          };
        },
      },
      {
        name: 'revoke_api_key',
        description: 'Revoke a TORQUE API key by ID',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Key ID to revoke' },
          },
          required: ['id'],
        },
        handler(params) {
          const { id } = params || {};
          if (!id || typeof id !== 'string') {
            throw new Error('id is required');
          }
          keyManager.revokeKey(id);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ revoked: true, id }),
              },
            ],
          };
        },
      },
    ];
  }

  function eventHandlers() {
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
          description: 'Authentication mode: open (no auth), api_key (key-only), full (keys + users + sessions)',
        },
      },
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

module.exports = { createAuthPlugin };
