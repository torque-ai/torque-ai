'use strict';

const childProcess = require('child_process');

const DEFAULT_EXEC_TIMEOUT_MS = 30000;
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string`);
  }

  return value;
}

function normalizeArgs(args, name = 'args') {
  if (args === undefined || args === null) return [];
  if (!Array.isArray(args)) {
    throw new TypeError(`${name} must be an array`);
  }

  return args.map((arg, index) => {
    if (typeof arg === 'string') return arg;
    if (typeof arg === 'number' || typeof arg === 'boolean') return String(arg);
    throw new TypeError(`${name}[${index}] must be a string, number, or boolean`);
  });
}

function normalizeUrlInput(input) {
  const url = isPlainObject(input) ? input.url : input;
  assertNonEmptyString(url, 'url');

  try {
    return new URL(url).toString();
  } catch (_error) {
    throw new TypeError(`url must be an absolute URL: ${url}`);
  }
}

function createNotImplementedError(platform, methodName) {
  const error = new Error(`Not implemented on this platform: ${methodName}`);
  error.code = 'ERR_PEEK_NOT_IMPLEMENTED';
  error.platform = platform;
  error.method = methodName;
  return error;
}

class BasePlatformAdapter {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.name = options.name || this.platform;
    this.capabilities = Array.isArray(options.capabilities) ? [...options.capabilities] : [];
    this.childProcess = options.childProcess || childProcess;
    this.defaultExecTimeoutMs = Number.isFinite(options.defaultExecTimeoutMs)
      ? options.defaultExecTimeoutMs
      : DEFAULT_EXEC_TIMEOUT_MS;
  }

  notImplemented(methodName) {
    throw createNotImplementedError(this.platform, methodName);
  }

  getExecOptions(options = {}) {
    if (options.shell) {
      throw new Error('Shell execution is not allowed');
    }

    return {
      encoding: 'utf8',
      maxBuffer: DEFAULT_MAX_BUFFER,
      timeout: this.defaultExecTimeoutMs,
      windowsHide: true,
      ...options,
      shell: false,
    };
  }

  execTool(command, args = [], options = {}) {
    assertNonEmptyString(command, 'command');

    return this.childProcess.execFileSync(
      command,
      normalizeArgs(args),
      this.getExecOptions(options)
    );
  }

  execToolAsync(command, args = [], options = {}) {
    assertNonEmptyString(command, 'command');
    const normalizedArgs = normalizeArgs(args);
    const execOptions = this.getExecOptions(options);

    return new Promise((resolve, reject) => {
      this.childProcess.execFile(command, normalizedArgs, execOptions, (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }

        resolve({ stdout, stderr });
      });
    });
  }

  getOpenUrlCommand(url) {
    if (this.platform === 'win32') {
      return {
        command: 'rundll32.exe',
        args: ['url.dll,FileProtocolHandler', url],
      };
    }

    if (this.platform === 'darwin') {
      return {
        command: 'open',
        args: [url],
      };
    }

    return {
      command: 'xdg-open',
      args: [url],
    };
  }

  async openUrl(input, options = {}) {
    const url = normalizeUrlInput(input);
    const { command, args } = this.getOpenUrlCommand(url);
    await this.execToolAsync(command, args, options);

    return {
      success: true,
      url,
    };
  }

  'open-url'(input, options = {}) {
    return this.openUrl(input, options);
  }

  getLaunchCommand(input) {
    if (typeof input === 'string') return input;

    if (!isPlainObject(input)) {
      throw new TypeError('launchProcess options must be an object or command string');
    }

    return input.command || input.path || input.file || input.executable;
  }

  getSpawnOptions(input) {
    if (!isPlainObject(input)) {
      return {
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      };
    }

    if (input.shell) {
      throw new Error('Shell execution is not allowed');
    }

    return {
      cwd: input.cwd,
      detached: Boolean(input.detached),
      env: input.env ? { ...process.env, ...input.env } : process.env,
      shell: false,
      stdio: input.stdio || 'ignore',
      windowsHide: input.windowsHide !== false,
    };
  }

  async launchProcess(input = {}) {
    const command = assertNonEmptyString(this.getLaunchCommand(input), 'command');
    const args = normalizeArgs(isPlainObject(input) ? input.args : []);
    const spawnOptions = this.getSpawnOptions(input);
    const child = this.childProcess.spawn(command, args, spawnOptions);

    if (spawnOptions.detached && typeof child.unref === 'function') {
      child.unref();
    }

    if (Number.isInteger(child.pid)) {
      return {
        success: true,
        pid: child.pid,
        command,
        args,
      };
    }

    return new Promise((resolve, reject) => {
      child.once('spawn', () => {
        resolve({
          success: true,
          pid: child.pid,
          command,
          args,
        });
      });
      child.once('error', reject);
    });
  }

  process(options = {}) {
    return this.launchProcess(options);
  }

  capture(_options = {}) {
    return this.notImplemented('capture');
  }

  peek(options = {}) {
    return this.capture(options);
  }

  listWindows(_options = {}) {
    return this.notImplemented('listWindows');
  }

  list(options = {}) {
    return this.listWindows(options);
  }

  windows(options = {}) {
    return this.listWindows(options);
  }

  click(_options = {}) {
    return this.notImplemented('click');
  }

  drag(_options = {}) {
    return this.notImplemented('drag');
  }

  type(_options = {}) {
    return this.notImplemented('type');
  }

  scroll(_options = {}) {
    return this.notImplemented('scroll');
  }

  hotkey(_options = {}) {
    return this.notImplemented('hotkey');
  }

  focus(_options = {}) {
    return this.notImplemented('focus');
  }

  resize(_options = {}) {
    return this.notImplemented('resize');
  }

  move(_options = {}) {
    return this.notImplemented('move');
  }

  maximize(_options = {}) {
    return this.notImplemented('maximize');
  }

  minimize(_options = {}) {
    return this.notImplemented('minimize');
  }

  clipboard(_options = {}) {
    return this.notImplemented('clipboard');
  }

  discoverProjects(_options = {}) {
    return this.notImplemented('discoverProjects');
  }

  projects(options = {}) {
    return this.discoverProjects(options);
  }

  compare(_options = {}) {
    return this.notImplemented('compare');
  }

  snapshot(_options = {}) {
    return this.notImplemented('snapshot');
  }

  elements(_options = {}) {
    return this.notImplemented('elements');
  }

  wait(_options = {}) {
    return this.notImplemented('wait');
  }

  ocr(_options = {}) {
    return this.notImplemented('ocr');
  }

  assert(_options = {}) {
    return this.notImplemented('assert');
  }

  hitTest(_options = {}) {
    return this.notImplemented('hitTest');
  }

  'hit-test'(options = {}) {
    return this.hitTest(options);
  }

  color(_options = {}) {
    return this.notImplemented('color');
  }

  table(_options = {}) {
    return this.notImplemented('table');
  }

  summary(_options = {}) {
    return this.notImplemented('summary');
  }

  cdp(_options = {}) {
    return this.notImplemented('cdp');
  }

  diagnose(_options = {}) {
    return this.notImplemented('diagnose');
  }

  semanticDiff(_options = {}) {
    return this.notImplemented('semanticDiff');
  }

  'semantic-diff'(options = {}) {
    return this.semanticDiff(options);
  }

  actionSequence(_options = {}) {
    return this.notImplemented('actionSequence');
  }

  'action-sequence'(options = {}) {
    return this.actionSequence(options);
  }

  isAllowedRecoveryAction(_options = {}) {
    return this.notImplemented('isAllowedRecoveryAction');
  }

  executeRecovery(_options = {}) {
    return this.notImplemented('executeRecovery');
  }

  getRecoveryStatus(_options = {}) {
    return this.notImplemented('getRecoveryStatus');
  }
}

module.exports = BasePlatformAdapter;
