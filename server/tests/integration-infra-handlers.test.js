'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const { ErrorCodes } = require('../handlers/error-codes');

const HANDLER_MODULE = '../handlers/integration/infra';
const MODULE_PATHS = [
  HANDLER_MODULE,
  '../database',
  '../task-manager',
  '../logger',
  '../config',
  '../db/backup-core',
  '../db/config-core',
  '../db/email-peek',
  '../db/host-management',
  '../db/provider-routing-core',
];
const ENV_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'TORQUE_DATA_DIR'];

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function clearLoadedModules() {
  vi.resetModules();
  for (const modulePath of MODULE_PATHS) {
    try {
      delete require.cache[require.resolve(modulePath)];
    } catch {
      // Ignore modules that are not loaded yet.
    }
  }
}

function createConfigMock(values = {}) {
  const state = { ...values };

  return {
    __values: state,
    getInt: vi.fn((key, fallback) => {
      if (!Object.prototype.hasOwnProperty.call(state, key)) {
        return fallback !== undefined ? fallback : 0;
      }
      const value = state[key];
      if (typeof value === 'number') {
        return value;
      }
      const parsed = parseInt(value, 10);
      return Number.isNaN(parsed) ? (fallback !== undefined ? fallback : 0) : parsed;
    }),
    getBool: vi.fn((key, fallback) => {
      if (!Object.prototype.hasOwnProperty.call(state, key)) {
        return Boolean(fallback);
      }
      const value = state[key];
      return value === true || value === '1' || value === 'true';
    }),
    isOptIn: vi.fn((key) => {
      if (!Object.prototype.hasOwnProperty.call(state, key)) {
        return false;
      }
      const value = state[key];
      return value === true || value === '1' || value === 'true';
    }),
  };
}

function createModules(options = {}) {
  const config = createConfigMock(options.configValues);
  const loggerChild = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    ...(options.loggerChild || {}),
  };
  const db = {
    saveIntegrationConfig: vi.fn(),
    listOllamaHosts: vi.fn(() => []),
    setHostPriority: vi.fn(),
    setConfig: vi.fn((key, value) => {
      config.__values[key] = String(value);
    }),
    routeTask: vi.fn(() => null),
    backupDatabase: vi.fn((destPath) => ({
      path: destPath,
      size: 1024,
      created_at: '2026-03-12T00:00:00.000Z',
    })),
    restoreDatabase: vi.fn(async (srcPath) => ({
      restored_from: srcPath,
      restored_at: '2026-03-12T00:00:00.000Z',
    })),
    listBackups: vi.fn(() => []),
    getBackupsDir: vi.fn(() => path.resolve(os.tmpdir(), 'torque-test-backups')),
    recordEmailNotification: vi.fn(),
    listEmailNotifications: vi.fn(() => []),
    getEmailNotification: vi.fn(() => null),
    ...(options.db || {}),
  };
  const taskManager = {
    processQueue: vi.fn(),
    ...(options.taskManager || {}),
  };
  const loggerModule = {
    child: vi.fn(() => loggerChild),
  };

  return { config, db, taskManager, loggerChild, loggerModule };
}

function loadHandlers(options = {}) {
  clearLoadedModules();

  const modules = createModules(options);
  installCjsModuleMock('../database', modules.db);
  installCjsModuleMock('../task-manager', modules.taskManager);
  installCjsModuleMock('../logger', modules.loggerModule);
  installCjsModuleMock('../config', modules.config);
  installCjsModuleMock('../db/backup-core', modules.db);
  installCjsModuleMock('../db/config-core', modules.db);
  installCjsModuleMock('../db/email-peek', modules.db);
  installCjsModuleMock('../db/host-management', modules.db);
  installCjsModuleMock('../db/provider-routing-core', modules.db);

  return {
    handlers: require(HANDLER_MODULE),
    mocks: modules,
  };
}

function getText(result) {
  return result?.content?.[0]?.text || '';
}

function expectError(result, errorCode, textFragment) {
  expect(result.isError).toBe(true);
  expect(result.error_code).toBe(errorCode);
  if (textFragment) {
    expect(getText(result)).toContain(textFragment);
  }
}

function interceptModuleLoad(overrides = {}) {
  const originalLoad = Module._load;
  return vi.spyOn(Module, '_load').mockImplementation(function mockedLoad(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(overrides, request)) {
      const value = overrides[request];
      if (value instanceof Error) {
        throw value;
      }
      return value;
    }
    return originalLoad.call(this, request, parent, isMain);
  });
}

function restoreEnv(snapshot) {
  for (const key of ENV_KEYS) {
    if (snapshot[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = snapshot[key];
    }
  }
}

function setSmtpEnv(overrides = {}) {
  process.env.SMTP_HOST = overrides.SMTP_HOST || 'smtp.example.test';
  process.env.SMTP_PORT = overrides.SMTP_PORT || '587';
  process.env.SMTP_USER = overrides.SMTP_USER || 'smtp-user';
  process.env.SMTP_PASS = overrides.SMTP_PASS || 'smtp-pass';
  process.env.SMTP_FROM = overrides.SMTP_FROM || 'noreply@example.test';
}

function makeTempDir(prefix, tempDirs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function buildScanFixture(tempDirs) {
  const projectDir = makeTempDir('torque-integration-infra-', tempDirs);

  writeFile(path.join(projectDir, 'src', 'alpha.js'), [
    'function alpha() {',
    '  return 1; // TODO add coverage',
    '}',
    '',
  ].join('\n'));
  writeFile(path.join(projectDir, 'src', 'beta.ts'), [
    'export function beta() {',
    '  return 2;',
    '}',
    '',
  ].join('\n'));
  writeFile(path.join(projectDir, 'src', 'index.js'), 'module.exports = {};\n');
  writeFile(path.join(projectDir, 'src', 'types.d.ts'), 'export type Id = string;\n');
  writeFile(path.join(projectDir, 'tests', 'alpha.test.ts'), 'test("alpha", () => {});\n');
  writeFile(path.join(projectDir, 'config', 'settings.js'), [
    '{',
    'id: "cfg-1",',
    '}',
    '// FIXME revisit defaults',
    '',
  ].join('\n'));
  writeFile(path.join(projectDir, 'data', 'items.js'), [
    '{',
    'id: "item-1",',
    '}',
    '{',
    'id: "item-2",',
    '}',
    '',
  ].join('\n'));
  writeFile(path.join(projectDir, 'constants', 'values.js'), 'export const VALUE = 1;\n');
  writeFile(path.join(projectDir, 'package.json'), JSON.stringify({
    name: 'sample-app',
    version: '1.2.3',
    scripts: {
      test: 'vitest run',
      lint: 'eslint .',
    },
    dependencies: {
      zod: '^3.0.0',
      express: '^4.0.0',
    },
    devDependencies: {
      vitest: '^2.0.0',
      eslint: '^9.0.0',
    },
  }, null, 2));
  writeFile(path.join(projectDir, 'node_modules', 'ignored.js'), 'console.log("ignore");\n');
  writeFile(path.join(projectDir, '.git', 'ignored.txt'), 'ignore\n');

  return projectDir;
}

function buildCustomScanFixture(tempDirs) {
  const projectDir = makeTempDir('torque-integration-infra-custom-', tempDirs);

  writeFile(path.join(projectDir, 'app', 'main.js'), 'export const main = () => true;\n');
  writeFile(path.join(projectDir, 'spec', 'main.spec.js'), 'test("main", () => {});\n');
  writeFile(path.join(projectDir, 'ignored', 'skip.js'), '// TODO ignored\n');

  return projectDir;
}

describe('integration/infra handlers', () => {
  let handlers;
  let mocks;
  let tempDirs;
  let envSnapshot;

  function reload(options = {}) {
    ({ handlers, mocks } = loadHandlers(options));
  }

  beforeEach(() => {
    tempDirs = [];
    envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    vi.useRealTimers();
    reload();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    restoreEnv(envSnapshot);
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    clearLoadedModules();
  });

  describe('handleConfigureIntegration', () => {
    it('rejects unsupported integration types', () => {
      const result = handlers.handleConfigureIntegration({
        integration_type: 'teams',
        config: {},
      });

      expectError(result, ErrorCodes.INVALID_PARAM.code, 'integration_type must be "slack", "discord", "s3", or "prometheus"');
      expect(mocks.db.saveIntegrationConfig).not.toHaveBeenCalled();
    });

    it('rejects non-object config values', () => {
      const result = handlers.handleConfigureIntegration({
        integration_type: 'slack',
        config: 'not-an-object',
      });

      expectError(result, ErrorCodes.INVALID_PARAM.code, 'config must be an object');
    });

    it('requires webhook_url for slack integrations', () => {
      const result = handlers.handleConfigureIntegration({
        integration_type: 'slack',
        config: { channel: '#ops' },
      });

      expectError(result, ErrorCodes.MISSING_REQUIRED_PARAM.code, 'Slack integration requires webhook_url');
    });

    it('rejects non-HTTPS webhook URLs', () => {
      const result = handlers.handleConfigureIntegration({
        integration_type: 'discord',
        config: { webhook_url: 'http://hooks.example.test/discord' },
      });

      expectError(result, ErrorCodes.INVALID_URL.code, 'Webhook URL must use HTTPS');
    });

    it('saves valid integration configs and reports the config keys', () => {
      const result = handlers.handleConfigureIntegration({
        integration_type: 'slack',
        config: {
          webhook_url: 'https://hooks.example.test/slack',
          channel: '#ops',
        },
      });
      const text = getText(result);

      expect(mocks.db.saveIntegrationConfig).toHaveBeenCalledWith({
        id: 'slack_config',
        integration_type: 'slack',
        config: {
          webhook_url: 'https://hooks.example.test/slack',
          channel: '#ops',
        },
        enabled: true,
      });
      expect(text).toContain('## Integration Configured');
      expect(text).toContain('**Type:** slack');
      expect(text).toContain('**Enabled:** true');
      expect(text).toContain('**Config Keys:** webhook_url, channel');
    });
  });

  describe('handleSetHostPriority', () => {
    it('requires a non-empty host_id', () => {
      const result = handlers.handleSetHostPriority({
        host_id: '',
        priority: 2,
      });

      expectError(result, ErrorCodes.MISSING_REQUIRED_PARAM.code, 'host_id must be a non-empty string');
    });

    it('requires a positive numeric priority', () => {
      const result = handlers.handleSetHostPriority({
        host_id: 'host-1',
        priority: 0,
      });

      expectError(result, ErrorCodes.INVALID_PARAM.code, 'priority must be a positive number');
    });

    it('returns RESOURCE_NOT_FOUND when the host does not exist', () => {
      mocks.db.listOllamaHosts.mockReturnValue([{ id: 'host-1', name: 'primary' }]);

      const result = handlers.handleSetHostPriority({
        host_id: 'missing-host',
        priority: 3,
      });

      expectError(result, ErrorCodes.RESOURCE_NOT_FOUND.code, 'Host not found: missing-host');
      expect(mocks.db.setHostPriority).not.toHaveBeenCalled();
    });

    it('updates the host priority when the host is found by name', () => {
      mocks.db.listOllamaHosts.mockReturnValue([{ id: 'host-1', name: 'primary' }]);

      const result = handlers.handleSetHostPriority({
        host_id: 'primary',
        priority: 2,
      });

      expect(mocks.db.setHostPriority).toHaveBeenCalledWith('primary', 2);
      expect(getText(result)).toContain('Host primary priority set to **2**.');
    });
  });

  describe('handleConfigureReviewWorkflow', () => {
    it('persists provided settings and renders the updated values', () => {
      const result = handlers.handleConfigureReviewWorkflow({
        review_interval_minutes: 15,
        auto_approve_simple: true,
        require_review_for_complex: false,
      });
      const text = getText(result);

      expect(mocks.db.setConfig).toHaveBeenNthCalledWith(1, 'review_interval_minutes', '15');
      expect(mocks.db.setConfig).toHaveBeenNthCalledWith(2, 'auto_approve_simple', '1');
      expect(mocks.db.setConfig).toHaveBeenNthCalledWith(3, 'require_review_for_complex', '0');
      expect(text).toContain('| Review Interval | 15 minutes |');
      expect(text).toContain('| Auto-approve Simple | Yes |');
      expect(text).toContain('| Require Review for Complex | No |');
    });

    it('returns the current config when no changes are requested', () => {
      reload({
        configValues: {
          review_interval_minutes: '7',
          auto_approve_simple: '0',
          require_review_for_complex: '1',
        },
      });

      const result = handlers.handleConfigureReviewWorkflow({});
      const text = getText(result);

      expect(mocks.db.setConfig).not.toHaveBeenCalled();
      expect(text).toContain('| Review Interval | 7 minutes |');
      expect(text).toContain('| Auto-approve Simple | No |');
      expect(text).toContain('| Require Review for Complex | Yes |');
    });
  });

  describe('handleGetReviewWorkflowConfig', () => {
    it('renders review settings, host priorities, and complexity routing', () => {
      const routeTask = vi.fn((level) => {
        if (level === 'simple') return { provider: 'codex' };
        if (level === 'complex') return { provider: 'ollama', hostId: 'host-2' };
        return null;
      });

      reload({
        configValues: {
          review_interval_minutes: '12',
          auto_approve_simple: '1',
          require_review_for_complex: '0',
        },
        db: {
          listOllamaHosts: vi.fn(() => [
            { id: 'host-1', name: 'alpha', priority: 2, enabled: true },
            { id: 'host-2', enabled: false },
          ]),
          routeTask,
        },
      });

      const text = getText(handlers.handleGetReviewWorkflowConfig({}));

      expect(text).toContain('| Review Interval | 12 minutes |');
      expect(text).toContain('| alpha | 2 | Enabled |');
      expect(text).toContain('| host-2 | 10 | Disabled |');
      expect(text).toContain('| simple | codex |');
      expect(text).toContain('| normal | Not configured |');
      expect(text).toContain('| complex | ollama (host-2) |');
      expect(mocks.db.routeTask).toHaveBeenNthCalledWith(1, 'simple');
      expect(mocks.db.routeTask).toHaveBeenNthCalledWith(2, 'normal');
      expect(mocks.db.routeTask).toHaveBeenNthCalledWith(3, 'complex');
    });

    it('tolerates missing host listings and still renders routing defaults', () => {
      reload({
        db: {
          listOllamaHosts: undefined,
          routeTask: vi.fn(() => null),
        },
      });

      const text = getText(handlers.handleGetReviewWorkflowConfig({}));

      expect(text).toContain('### Host Priorities');
      expect(text).toContain('| simple | Not configured |');
      expect(text).toContain('| normal | Not configured |');
      expect(text).toContain('| complex | Not configured |');
    });
  });

  describe('database backup and restore handlers', () => {
    it('backs up the database to an explicit destination path', () => {
      const destPath = process.platform === 'win32'
        ? path.join('C:\\', 'backups', 'manual-backup.db')
        : '/tmp/backups/manual-backup.db';
      mocks.db.backupDatabase.mockReturnValue({
        path: destPath,
        size: 4096,
        created_at: '2026-03-12T10:00:00.000Z',
      });

      const result = handlers.handleBackupDatabase({ dest_path: destPath });
      const text = getText(result);

      expect(mocks.db.backupDatabase).toHaveBeenCalledWith(destPath);
      expect(text).toContain(`**Path:** ${destPath}`);
      expect(text).toContain('**Size:** 4.0 KB');
      expect(text).toContain('**Created:** 2026-03-12T10:00:00.000Z');
    });

    it('builds the default backup path from TORQUE_DATA_DIR and the current time', () => {
      const dataDir = makeTempDir('torque-backup-data-', tempDirs);
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-12T12:34:56.789Z'));
      process.env.TORQUE_DATA_DIR = dataDir;

      handlers.handleBackupDatabase({});

      expect(mocks.db.backupDatabase).toHaveBeenCalledWith(
        path.join(dataDir, 'backups', 'torque-backup-2026-03-12T12-34-56-789Z.db')
      );
    });

    it('maps backup failures to OPERATION_FAILED', () => {
      mocks.db.backupDatabase.mockImplementation(() => {
        throw new Error('disk full');
      });

      const result = handlers.handleBackupDatabase({});

      expectError(result, ErrorCodes.OPERATION_FAILED.code, 'Backup failed: disk full');
    });

    it('requires src_path when restoring a backup', async () => {
      const result = await handlers.handleRestoreDatabase({ confirm: true });

      expectError(result, ErrorCodes.MISSING_REQUIRED_PARAM.code, 'Source path is required');
    });

    it('requires confirm: true for destructive restores', async () => {
      const result = await handlers.handleRestoreDatabase({
        src_path: 'backup.db',
        confirm: false,
      });

      expectError(result, ErrorCodes.INVALID_PARAM.code, 'Destructive operation requires confirm: true');
    });

    it('rejects restore paths that traverse outside the backups directory', async () => {
      for (const srcPath of ['../outside.db', 'nested/../../outside.db']) {
        const result = await handlers.handleRestoreDatabase({
          src_path: srcPath,
          confirm: true,
        });

        expectError(result, ErrorCodes.INVALID_PARAM.code, 'src_path must resolve to a path inside the backups directory');
      }

      expect(mocks.db.restoreDatabase).not.toHaveBeenCalled();
    });

    it('rejects absolute restore paths outside the backups directory', async () => {
      const outsidePath = path.resolve(os.tmpdir(), 'torque-restore-outside.db');

      const result = await handlers.handleRestoreDatabase({
        src_path: outsidePath,
        confirm: true,
      });

      expectError(result, ErrorCodes.INVALID_PARAM.code, 'src_path must resolve to a path inside the backups directory');
      expect(mocks.db.restoreDatabase).not.toHaveBeenCalled();
    });

    it('restores the database and reports the restore metadata', async () => {
      mocks.db.restoreDatabase.mockResolvedValue({
        restored_from: 'backup.db',
        restored_at: '2026-03-12T11:00:00.000Z',
      });

      const result = await handlers.handleRestoreDatabase({
        src_path: 'backup.db',
        confirm: true,
      });
      const text = getText(result);

      const expectedPath = path.resolve(mocks.db.getBackupsDir(), 'backup.db');
      expect(mocks.db.restoreDatabase).toHaveBeenCalledWith(expectedPath, true, { force: false });
      expect(text).toContain('## Database Restored');
      expect(text).toContain('**From:**');
      expect(text).toContain('**At:** 2026-03-12T11:00:00.000Z');
      expect(text).toContain('Server restart recommended after restore');
    });

    it('maps restore operation failures to OPERATION_FAILED', async () => {
      mocks.db.restoreDatabase.mockRejectedValue(new Error('permission denied'));

      const result = await handlers.handleRestoreDatabase({
        src_path: 'backup.db',
        confirm: true,
      });

      expectError(result, ErrorCodes.OPERATION_FAILED.code, 'Restore failed: permission denied');
    });

    it('returns INTERNAL_ERROR for unexpected restore failures', async () => {
      const args = {
        get src_path() {
          throw new Error('unexpected getter failure');
        },
      };

      const result = await handlers.handleRestoreDatabase(args);

      expectError(result, ErrorCodes.INTERNAL_ERROR.code, 'unexpected getter failure');
    });

    it('returns a no-backups message when none exist', () => {
      mocks.db.listBackups.mockReturnValue([]);

      const result = handlers.handleListDatabaseBackups({});

      expect(mocks.db.listBackups).toHaveBeenCalled();
      expect(getText(result)).toContain('No backups found.');
    });

    it('renders the available backups in a table', () => {
      mocks.db.listBackups.mockReturnValue([
        { name: 'first.db', size: 1024, created_at: '2026-03-12T08:00:00.000Z' },
        { name: 'second.db', size: 2048, created_at: '2026-03-12T09:00:00.000Z' },
      ]);

      const result = handlers.handleListDatabaseBackups({});
      const text = getText(result);

      expect(mocks.db.listBackups).toHaveBeenCalled();
      expect(text).toContain('## Database Backups (2)');
      expect(text).toContain('| first.db | 1.0 KB | 2026-03-12T08:00:00.000Z |');
      expect(text).toContain('| second.db | 2.0 KB | 2026-03-12T09:00:00.000Z |');
    });

    it('maps backup listing failures to OPERATION_FAILED', () => {
      mocks.db.listBackups.mockImplementation(() => {
        throw new Error('cannot read backup directory');
      });

      const result = handlers.handleListDatabaseBackups({
        directory: 'C:\\backups',
      });

      expectError(result, ErrorCodes.OPERATION_FAILED.code, 'List backups failed: cannot read backup directory');
    });
  });

  describe('email notification handlers', () => {
    it('requires recipient, subject, and body when sending emails', async () => {
      const result = await handlers.handleSendEmailNotification({
        recipient: 'user@example.com',
        subject: '',
        body: 'hello',
      });

      expectError(result, ErrorCodes.MISSING_REQUIRED_PARAM.code, 'recipient, subject, and body are required');
    });

    it('rejects invalid email addresses', async () => {
      const result = await handlers.handleSendEmailNotification({
        recipient: 'not-an-email',
        subject: 'Build',
        body: 'hello',
      });

      expectError(result, ErrorCodes.INVALID_PARAM.code, 'Invalid email address: not-an-email');
    });

    it('records pending notifications when SMTP is not configured', async () => {
      vi.spyOn(crypto, 'randomUUID').mockReturnValue('notif-pending');
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-12T09:15:00.000Z'));

      const result = await handlers.handleSendEmailNotification({
        recipient: 'user@example.com',
        subject: 'Build status',
        body: 'All good',
      });
      const text = getText(result);

      expect(mocks.db.recordEmailNotification).toHaveBeenCalledWith({
        id: 'notif-pending',
        task_id: null,
        recipient: 'user@example.com',
        subject: 'Build status',
        status: 'pending',
        error: null,
        sent_at: '2026-03-12T09:15:00.000Z',
      });
      expect(text).toContain('## Email Notification (Pending)');
      expect(text).toContain('SMTP is not configured.');
    });

    it('records pending notifications when nodemailer is unavailable', async () => {
      setSmtpEnv();
      vi.spyOn(crypto, 'randomUUID').mockReturnValue('notif-no-mailer');
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-12T09:20:00.000Z'));
      interceptModuleLoad({
        nodemailer: new Error('Cannot find module nodemailer'),
      });

      const result = await handlers.handleSendEmailNotification({
        recipient: 'user@example.com',
        subject: 'Build status',
        body: 'All good',
        task_id: 'task-1',
      });
      const text = getText(result);

      expect(mocks.db.recordEmailNotification).toHaveBeenCalledWith({
        id: 'notif-no-mailer',
        task_id: 'task-1',
        recipient: 'user@example.com',
        subject: 'Build status',
        status: 'pending',
        error: 'nodemailer not installed',
        sent_at: '2026-03-12T09:20:00.000Z',
      });
      expect(text).toContain('nodemailer is not installed.');
      expect(text).toContain('npm install nodemailer');
    });

    it('sends email notifications when SMTP and nodemailer are available', async () => {
      const sendMail = vi.fn().mockResolvedValue({ messageId: 'm-1' });
      const createTransport = vi.fn(() => ({ sendMail }));

      setSmtpEnv({ SMTP_PORT: '465' });
      vi.spyOn(crypto, 'randomUUID').mockReturnValue('notif-sent');
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-12T09:30:00.000Z'));
      interceptModuleLoad({
        nodemailer: { createTransport },
      });

      const result = await handlers.handleSendEmailNotification({
        recipient: 'user@example.com',
        subject: 'Alert',
        body: 'Please investigate',
        task_id: 'task-9',
      });
      const text = getText(result);

      expect(createTransport).toHaveBeenCalledWith({
        host: 'smtp.example.test',
        port: 465,
        secure: true,
        auth: {
          user: 'smtp-user',
          pass: 'smtp-pass',
        },
      });
      expect(sendMail).toHaveBeenCalledWith({
        from: 'noreply@example.test',
        to: 'user@example.com',
        subject: 'Alert',
        text: 'Please investigate',
      });
      expect(mocks.db.recordEmailNotification).toHaveBeenCalledWith({
        id: 'notif-sent',
        task_id: 'task-9',
        recipient: 'user@example.com',
        subject: 'Alert',
        status: 'sent',
        error: null,
        sent_at: '2026-03-12T09:30:00.000Z',
      });
      expect(text).toContain('## Email Notification Sent');
      expect(text).toContain('- **Status:** sent');
    });

    it('records failed notifications when sendMail rejects', async () => {
      const sendMail = vi.fn().mockRejectedValue(new Error('SMTP rejected the message'));
      const createTransport = vi.fn(() => ({ sendMail }));

      setSmtpEnv();
      vi.spyOn(crypto, 'randomUUID').mockReturnValue('notif-failed');
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-12T09:35:00.000Z'));
      interceptModuleLoad({
        nodemailer: { createTransport },
      });

      const result = await handlers.handleSendEmailNotification({
        recipient: 'user@example.com',
        subject: 'Alert',
        body: 'Please investigate',
      });
      const text = getText(result);

      expect(mocks.db.recordEmailNotification).toHaveBeenCalledWith({
        id: 'notif-failed',
        task_id: null,
        recipient: 'user@example.com',
        subject: 'Alert',
        status: 'failed',
        error: 'SMTP rejected the message',
        sent_at: '2026-03-12T09:35:00.000Z',
      });
      expect(text).toContain('## Email Notification Failed');
      expect(text).toContain('- **Error:** SMTP rejected the message');
    });
  });

  describe('email notification listing and lookup handlers', () => {
    it('forwards list filters and reports empty notification sets', () => {
      const result = handlers.handleListEmailNotifications({
        status: 'failed',
      });

      expect(mocks.db.listEmailNotifications).toHaveBeenCalledWith({
        status: 'failed',
        task_id: undefined,
        limit: 100,
      });
      expect(getText(result)).toContain('No email notifications found.');
    });

    it('renders notification tables with truncated subjects and default subjects', () => {
      mocks.db.listEmailNotifications.mockReturnValue([
        {
          id: '1234567890abcdef',
          recipient: 'user@example.com',
          subject: '123456789012345678901234567890EXTRA',
          status: 'sent',
          sent_at: '2026-03-12T10:00:00.000Z',
        },
        {
          id: 'fedcba0987654321',
          recipient: 'user@example.com',
          subject: '',
          status: 'pending',
          sent_at: '2026-03-12T10:05:00.000Z',
        },
      ]);

      const result = handlers.handleListEmailNotifications({
        task_id: 'task-1',
        limit: 2,
      });
      const text = getText(result);

      expect(mocks.db.listEmailNotifications).toHaveBeenCalledWith({
        status: undefined,
        task_id: 'task-1',
        limit: 2,
      });
      expect(text).toContain('**Count:** 2');
      expect(text).toContain('| 12345678 | user@example.com | 123456789012345678901234567890... | sent | 2026-03-12T10:00:00.000Z |');
      expect(text).toContain('| fedcba09 | user@example.com | (no subject) | pending | 2026-03-12T10:05:00.000Z |');
    });

    it('requires an id to fetch a single notification', () => {
      const result = handlers.handleGetEmailNotification({});

      expectError(result, ErrorCodes.MISSING_REQUIRED_PARAM.code, 'id is required');
    });

    it('returns RESOURCE_NOT_FOUND when the notification is missing', () => {
      mocks.db.getEmailNotification.mockReturnValue(null);

      const result = handlers.handleGetEmailNotification({ id: 'missing-id' });

      expectError(result, ErrorCodes.RESOURCE_NOT_FOUND.code, 'Email notification not found: missing-id');
    });

    it('renders notification details including optional task and error fields', () => {
      mocks.db.getEmailNotification.mockReturnValue({
        id: 'notif-1',
        recipient: 'user@example.com',
        subject: 'Deploy failed',
        status: 'failed',
        sent_at: '2026-03-12T10:10:00.000Z',
        task_id: 'task-88',
        error: 'SMTP rejected the message',
      });

      const result = handlers.handleGetEmailNotification({ id: 'notif-1' });
      const text = getText(result);

      expect(text).toContain('- **ID:** notif-1');
      expect(text).toContain('- **Recipient:** user@example.com');
      expect(text).toContain('- **Task ID:** task-88');
      expect(text).toContain('- **Error:** SMTP rejected the message');
    });
  });

  describe('handleScanProject', () => {
    it('returns RESOURCE_NOT_FOUND when the project path does not exist', () => {
      const missingPath = path.join('C:\\', 'missing', 'project');

      const result = handlers.handleScanProject({ path: missingPath });

      expectError(result, ErrorCodes.RESOURCE_NOT_FOUND.code, `Project path does not exist: ${missingPath}`);
    });

    it('builds the full scan report for a mixed project fixture', () => {
      const projectDir = buildScanFixture(tempDirs);

      const result = handlers.handleScanProject({ path: projectDir });
      const text = getText(result);

      expect(text).toContain(`## Project Scan: ${path.basename(projectDir)}`);
      expect(text).toContain('**Total files:** 9');
      expect(text).toContain('| src | 4 |');
      expect(text).toContain('| .js | 5 |');
      expect(text).toContain('**0/2 source files have tests (0%)**');
      expect(text).toContain(`- ${path.join('src', 'beta.ts')} (4 lines)`);
      expect(text).toContain('**2 found**');
      expect(text).toContain(`**FIXME** ${path.join('config', 'settings.js')}:4`);
      expect(text).toContain(`**TODO** ${path.join('src', 'alpha.js')}:2`);
      expect(text).toContain('### File Sizes');
      expect(text).toContain(`| ${path.join('data', 'items.js')} | 7 | 2 |`);
      expect(text).toContain('**sample-app** v1.2.3');
      expect(text).toContain('**Dependencies (2):** express, zod');
      expect(text).toContain('**Dev dependencies (2):** eslint, vitest');
      expect(text).not.toContain('ignored.js');
    });

    it('honors custom source_dirs, test_pattern, ignore_dirs, and selected checks', () => {
      const projectDir = buildCustomScanFixture(tempDirs);

      const result = handlers.handleScanProject({
        path: projectDir,
        checks: ['summary', 'missing_tests'],
        source_dirs: ['app'],
        test_pattern: '.spec.js',
        ignore_dirs: ['ignored'],
      });
      const text = getText(result);

      expect(text).toContain('**Total files:** 2');
      expect(text).toContain('**1/1 source files have tests (100%)**');
      expect(text).not.toContain('### TODOs/FIXMEs');
      expect(text).not.toContain('skip.js');
    });

    it('logs non-critical directory walk errors and continues scanning', () => {
      const projectDir = makeTempDir('torque-integration-infra-empty-', tempDirs);
      const realReaddirSync = fs.readdirSync;

      vi.spyOn(fs, 'readdirSync').mockImplementation((...args) => {
        if (args[0] === projectDir) {
          throw new Error('blocked by test');
        }
        return realReaddirSync(...args);
      });

      const result = handlers.handleScanProject({
        path: projectDir,
        checks: ['summary'],
      });
      const text = getText(result);

      expect(mocks.loggerChild.debug).toHaveBeenCalledWith(
        '[integration-infra] non-critical error walking directory tree:',
        'blocked by test'
      );
      expect(text).toContain('**Total files:** 0');
    });
  });
});
