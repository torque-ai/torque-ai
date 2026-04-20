'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_EXEC_TIMEOUT_MS = 30000;
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;
const DEFAULT_PROJECT_SCAN_DEPTH = 2;
const DEFAULT_PROJECT_SCAN_LIMIT = 100;
const DEFAULT_BUILD_TIMEOUT_MS = 120000;
const PROJECT_DIR_IGNORES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.turbo',
  '.cache',
  'bin',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'obj',
  'target',
]);
const EXECUTABLE_SEARCH_DIRS = Object.freeze([
  'bin',
  'build',
  'dist',
  'out',
  'release',
  'releases',
  'target',
]);
const WINDOWS_EXECUTABLE_EXTENSIONS = new Set(['.bat', '.cmd', '.com', '.exe']);
const POSIX_EXECUTABLE_EXTENSIONS = new Set(['.app', '.command', '.run', '.sh']);

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

function optionalPositiveInteger(value, name, fallback, options = {}) {
  if (value === undefined || value === null || value === '') return fallback;

  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }

  return options.max ? Math.min(number, options.max) : number;
}

function safeStatSync(filePath) {
  try {
    return fs.statSync(filePath);
  } catch (_error) {
    return null;
  }
}

function safeReadDirSync(dirPath, options = {}) {
  try {
    return fs.readdirSync(dirPath, options);
  } catch (_error) {
    return [];
  }
}

function fileExists(filePath) {
  const stat = safeStatSync(filePath);
  return Boolean(stat && stat.isFile());
}

function directoryExists(dirPath) {
  const stat = safeStatSync(dirPath);
  return Boolean(stat && stat.isDirectory());
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
}

function expandHome(value) {
  const text = String(value || '').trim();
  if (text === '~') return os.homedir();
  if (text.startsWith(`~${path.sep}`) || text.startsWith('~/') || text.startsWith('~\\')) {
    return path.join(os.homedir(), text.slice(2));
  }
  return text;
}

function normalizePathInput(value) {
  const expanded = expandHome(value);
  return expanded ? path.resolve(expanded) : null;
}

function normalizeStringArray(value) {
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value)) return value.map((entry) => String(entry)).filter(Boolean);
  return [String(value)];
}

function defaultProjectRoots() {
  const home = os.homedir();
  return [
    path.join(home, 'Projects'),
    path.join(home, 'projects'),
    path.join(home, 'source', 'repos'),
  ];
}

function getProjectRoots(options = {}) {
  const roots = [
    ...normalizeStringArray(options.root),
    ...normalizeStringArray(options.roots),
    ...normalizeStringArray(options.base_dir),
    ...normalizeStringArray(options.baseDir),
    ...normalizeStringArray(options.search_dir),
    ...normalizeStringArray(options.searchDir),
  ];
  const candidates = roots.length > 0 ? roots : defaultProjectRoots();
  const normalized = [];
  const seen = new Set();

  for (const candidate of candidates) {
    const root = normalizePathInput(candidate);
    const key = root ? root.toLowerCase() : null;
    if (!root || !directoryExists(root) || seen.has(key)) continue;
    seen.add(key);
    normalized.push(root);
  }

  return normalized;
}

function hasFileWithExtension(dirPath, extensions) {
  return safeReadDirSync(dirPath, { withFileTypes: true }).some((entry) =>
    entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())
  );
}

function hasProjectMarker(dirPath) {
  return fileExists(path.join(dirPath, 'package.json'))
    || fileExists(path.join(dirPath, 'Cargo.toml'))
    || hasFileWithExtension(dirPath, new Set(['.csproj', '.sln']));
}

function shouldSkipDirectory(name) {
  return PROJECT_DIR_IGNORES.has(String(name || '').toLowerCase());
}

function collectProjectDirectories(root, options = {}) {
  const maxDepth = options.maxDepth;
  const limit = options.limit;
  const projects = [];
  const seen = new Set();

  function visit(dirPath, depth) {
    if (projects.length >= limit) return;

    const key = dirPath.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);

    if (hasProjectMarker(dirPath)) {
      projects.push(dirPath);
    }

    if (depth >= maxDepth) return;

    for (const entry of safeReadDirSync(dirPath, { withFileTypes: true })) {
      if (projects.length >= limit) return;
      if (!entry.isDirectory() || shouldSkipDirectory(entry.name)) continue;
      visit(path.join(dirPath, entry.name), depth + 1);
    }
  }

  visit(root, 0);
  return projects;
}

function mergeDependencies(packageJson = {}) {
  return {
    ...(packageJson.dependencies || {}),
    ...(packageJson.devDependencies || {}),
    ...(packageJson.optionalDependencies || {}),
  };
}

function detectPackageType(packageJson = {}) {
  const dependencies = mergeDependencies(packageJson);
  const scripts = packageJson.scripts || {};
  const scriptText = Object.values(scripts).join('\n').toLowerCase();

  if (dependencies.electron || scriptText.includes('electron')) return 'electron';
  if (dependencies.vite || scriptText.includes('vite')) return 'vite';
  return 'node';
}

function firstFileWithExtension(dirPath, extensions) {
  return safeReadDirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(dirPath, entry.name))
    .sort((a, b) => a.localeCompare(b))[0] || null;
}

function detectProject(dirPath) {
  const packageJsonPath = path.join(dirPath, 'package.json');
  const packageJson = fileExists(packageJsonPath) ? readJsonFile(packageJsonPath) : null;
  if (packageJson) {
    return {
      name: typeof packageJson.name === 'string' && packageJson.name.trim()
        ? packageJson.name.trim()
        : path.basename(dirPath),
      path: dirPath,
      type: detectPackageType(packageJson),
      manifest: packageJsonPath,
      package_json: packageJson,
    };
  }

  const dotnetManifest = firstFileWithExtension(dirPath, new Set(['.sln', '.csproj']));
  if (dotnetManifest) {
    return {
      name: path.basename(dotnetManifest, path.extname(dotnetManifest)),
      path: dirPath,
      type: 'dotnet',
      manifest: dotnetManifest,
    };
  }

  const cargoManifest = path.join(dirPath, 'Cargo.toml');
  if (fileExists(cargoManifest)) {
    return {
      name: path.basename(dirPath),
      path: dirPath,
      type: 'rust',
      manifest: cargoManifest,
    };
  }

  return null;
}

function isLikelyExecutable(filePath, stat, platform) {
  if (!stat || !stat.isFile()) return false;

  const ext = path.extname(filePath).toLowerCase();
  if (platform === 'win32') return WINDOWS_EXECUTABLE_EXTENSIONS.has(ext);
  if (WINDOWS_EXECUTABLE_EXTENSIONS.has(ext) || POSIX_EXECUTABLE_EXTENSIONS.has(ext)) return true;
  return Boolean(stat.mode & 0o111);
}

function basenameWithoutExecutableExtension(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return WINDOWS_EXECUTABLE_EXTENSIONS.has(ext) || POSIX_EXECUTABLE_EXTENSIONS.has(ext)
    ? path.basename(filePath, ext)
    : path.basename(filePath);
}

function scoreExecutableCandidate(filePath, projectName) {
  const name = basenameWithoutExecutableExtension(filePath).toLowerCase();
  const target = String(projectName || '').toLowerCase();
  if (target && name === target) return 0;
  if (target && name.includes(target)) return 1;
  if (/test|spec|setup|uninstall|helper/.test(name)) return 10;
  return 5;
}

function findExecutableInDirectory(dirPath, projectName, platform, options = {}) {
  if (!directoryExists(dirPath)) return null;

  const maxDepth = options.maxDepth || 4;
  const candidates = [];

  function visit(current, depth) {
    if (depth > maxDepth) return;

    for (const entry of safeReadDirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipDirectory(entry.name)) visit(entryPath, depth + 1);
        continue;
      }

      const stat = safeStatSync(entryPath);
      if (isLikelyExecutable(entryPath, stat, platform)) {
        candidates.push(entryPath);
      }
    }
  }

  visit(dirPath, 0);
  return candidates
    .sort((a, b) => {
      const scoreDiff = scoreExecutableCandidate(a, projectName) - scoreExecutableCandidate(b, projectName);
      return scoreDiff || a.localeCompare(b);
    })[0] || null;
}

function candidateSearchRoots(projectPath, type) {
  const roots = EXECUTABLE_SEARCH_DIRS.map((name) => path.join(projectPath, name));

  if (type === 'rust') {
    roots.unshift(path.join(projectPath, 'target', 'release'));
    roots.unshift(path.join(projectPath, 'target', 'debug'));
  }

  if (type === 'dotnet') {
    roots.unshift(path.join(projectPath, 'bin', 'Release'));
    roots.unshift(path.join(projectPath, 'bin', 'Debug'));
  }

  return [...new Set(roots)];
}

function addLaunchMetadata(project, platform) {
  const executable = candidateSearchRoots(project.path, project.type)
    .map((root) => findExecutableInDirectory(root, project.name, platform))
    .find(Boolean);

  const result = {
    name: project.name,
    path: project.path,
    type: project.type,
  };

  if (project.manifest) result.manifest = project.manifest;
  if (executable) result.executable = executable;
  return result;
}

function getBuildCommand(project) {
  if (!project) return null;

  if (project.type === 'dotnet') {
    return {
      command: 'dotnet',
      args: ['build', project.manifest || project.path],
    };
  }

  if (project.type === 'rust') {
    return {
      command: 'cargo',
      args: ['build'],
    };
  }

  if (project.package_json && project.package_json.scripts && project.package_json.scripts.build) {
    return {
      command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
      args: ['run', 'build'],
    };
  }

  return null;
}

function getPackageStartCommand(project) {
  if (!project || !project.package_json || !project.package_json.scripts) return null;
  if (!project.package_json.scripts.start) return null;

  return {
    command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args: ['run', 'start'],
  };
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeWaitTimeoutMs(input = {}) {
  const seconds = optionalPositiveInteger(
    input.timeout ?? input.wait_timeout ?? input.waitTimeout,
    'timeout',
    15,
    { max: 30 }
  );
  return seconds * 1000;
}

function normalizeComparable(value) {
  return String(value || '').trim().toLowerCase();
}

function launchProcessName(command) {
  const basename = path.basename(String(command || ''));
  const ext = path.extname(basename);
  return normalizeComparable(ext ? basename.slice(0, -ext.length) : basename);
}

function launchedWindowMatches(windowInfo, launched) {
  if (!isPlainObject(windowInfo)) return false;

  if (Number.isInteger(launched.pid) && Number(windowInfo.pid) === launched.pid) {
    return true;
  }

  const processName = launchProcessName(launched.command);
  if (!processName) return false;

  return [
    windowInfo.process,
    windowInfo.process_name,
    windowInfo.name,
  ].some((candidate) => {
    const normalized = normalizeComparable(candidate);
    return normalized === processName || normalized === `${processName}.exe`;
  });
}

function extractWindowLaunchMetadata(windowInfo) {
  const metadata = {
    window_found: true,
  };

  if (windowInfo.title !== undefined) metadata.title = windowInfo.title;
  if (windowInfo.process !== undefined) metadata.process = windowInfo.process;
  if (windowInfo.pid !== undefined) metadata.window_pid = windowInfo.pid;
  if (windowInfo.hwnd !== undefined) metadata.hwnd = windowInfo.hwnd;
  if (windowInfo.window_id !== undefined) metadata.window_id = windowInfo.window_id;
  if (windowInfo.id !== undefined && metadata.window_id === undefined) metadata.window_id = windowInfo.id;
  if (windowInfo.geometry !== undefined) metadata.geometry = windowInfo.geometry;
  return metadata;
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

  async buildAndLaunchProcess(input = {}) {
    if (!isPlainObject(input)) {
      throw new TypeError('build_and_launch options must be a JSON object');
    }

    const projectPath = normalizePathInput(input.path || input.project || input.cwd);
    if (!projectPath || !directoryExists(projectPath)) {
      throw new TypeError('build_and_launch path must be an existing project directory');
    }

    const project = detectProject(projectPath);
    if (!project) {
      throw new Error(`Unable to identify project build system: ${projectPath}`);
    }

    const buildCommand = getBuildCommand(project);
    if (buildCommand) {
      await this.execToolAsync(buildCommand.command, buildCommand.args, {
        cwd: project.path,
        timeout: optionalPositiveInteger(
          input.build_timeout_ms ?? input.buildTimeoutMs,
          'build_timeout_ms',
          DEFAULT_BUILD_TIMEOUT_MS
        ),
      });
    }

    const launchable = addLaunchMetadata(project, this.platform);
    const launchOptions = { ...input };
    delete launchOptions.command;
    delete launchOptions.executable;
    delete launchOptions.file;
    delete launchOptions.project;

    if (launchable.executable) {
      return this.launchProcess({
        ...launchOptions,
        action: 'launch',
        path: launchable.executable,
        cwd: path.dirname(launchable.executable),
      });
    }

    const startCommand = getPackageStartCommand(project);
    if (startCommand) {
      return this.launchProcess({
        ...launchOptions,
        action: 'launch',
        command: startCommand.command,
        args: startCommand.args,
        cwd: project.path,
      });
    }

    throw new Error(`No launchable executable found after build: ${projectPath}`);
  }

  async waitForLaunchedWindow(launched, input = {}) {
    if (!isPlainObject(input) || input.wait_for_window === false || input.waitForWindow === false) {
      return launched;
    }

    if (input.wait_for_window !== true && input.waitForWindow !== true) {
      return launched;
    }

    const deadline = Date.now() + normalizeWaitTimeoutMs(input);

    while (Date.now() <= deadline) {
      let windows;
      try {
        windows = await this.listWindows({});
      } catch (_error) {
        return launched;
      }

      const list = Array.isArray(windows)
        ? windows
        : isPlainObject(windows) && Array.isArray(windows.windows)
          ? windows.windows
          : [];
      const match = list.find((windowInfo) => launchedWindowMatches(windowInfo, launched));
      if (match) {
        return {
          ...launched,
          ...extractWindowLaunchMetadata(match),
        };
      }

      await delay(250);
    }

    return {
      ...launched,
      window_found: false,
    };
  }

  async launchProcess(input = {}) {
    if (isPlainObject(input) && input.action === 'build_and_launch') {
      return this.buildAndLaunchProcess(input);
    }

    const command = assertNonEmptyString(this.getLaunchCommand(input), 'command');
    const args = normalizeArgs(isPlainObject(input) ? input.args : []);
    const spawnOptions = this.getSpawnOptions(input);
    const child = this.childProcess.spawn(command, args, spawnOptions);

    if (spawnOptions.detached && typeof child.unref === 'function') {
      child.unref();
    }

    if (Number.isInteger(child.pid)) {
      return this.waitForLaunchedWindow({
        success: true,
        pid: child.pid,
        command,
        args,
      }, input);
    }

    return new Promise((resolve, reject) => {
      child.once('spawn', () => {
        this.waitForLaunchedWindow({
          success: true,
          pid: child.pid,
          command,
          args,
        }, input).then(resolve, reject);
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
    const options = isPlainObject(_options) ? _options : {};
    const maxDepth = optionalPositiveInteger(
      options.depth ?? options.max_depth ?? options.maxDepth,
      'depth',
      DEFAULT_PROJECT_SCAN_DEPTH,
      { max: 6 }
    );
    const limit = optionalPositiveInteger(
      options.limit,
      'limit',
      DEFAULT_PROJECT_SCAN_LIMIT,
      { max: 500 }
    );
    const projects = [];
    const seen = new Set();

    for (const root of getProjectRoots(options)) {
      for (const projectPath of collectProjectDirectories(root, { maxDepth, limit })) {
        if (projects.length >= limit) break;

        const key = projectPath.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        const project = detectProject(projectPath);
        if (project) {
          projects.push(addLaunchMetadata(project, this.platform));
        }
      }
    }

    return projects;
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
