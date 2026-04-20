const os = require('os');
const { execFileSync } = require('child_process');

const PLATFORM_CONFIG = Object.freeze({
  win32: Object.freeze({
    platform: 'win32',
    name: 'Windows',
    adapter: 'win32',
    lookupCommand: 'where',
    dependencies: Object.freeze([
      Object.freeze({
        name: 'powershell',
        description: 'PowerShell with .NET desktop APIs',
        install: 'Install or enable Windows PowerShell.',
      }),
    ]),
  }),
  darwin: Object.freeze({
    platform: 'darwin',
    name: 'macOS',
    adapter: 'darwin',
    lookupCommand: 'which',
    dependencies: Object.freeze([
      Object.freeze({
        name: 'screencapture',
        description: 'Native screenshot capture utility',
        install: 'Included with macOS.',
      }),
      Object.freeze({
        name: 'osascript',
        description: 'AppleScript automation utility',
        install: 'Included with macOS.',
      }),
    ]),
  }),
  linux: Object.freeze({
    platform: 'linux',
    name: 'Linux',
    adapter: 'linux',
    lookupCommand: 'which',
    dependencies: Object.freeze([
      Object.freeze({
        name: 'xdotool',
        description: 'Window discovery and input automation',
        install: 'Install with your package manager, for example: sudo apt install xdotool.',
      }),
      Object.freeze({
        name: 'xprop',
        description: 'X11 window metadata inspection',
        install: 'Install with your package manager, for example: sudo apt install x11-utils.',
      }),
      Object.freeze({
        name: 'linux-screenshot',
        anyOf: Object.freeze(['maim', 'import']),
        description: 'Screenshot capture utility',
        install: 'Install maim or ImageMagick, for example: sudo apt install maim.',
      }),
    ]),
  }),
});

const BASE_CAPABILITIES = Object.freeze(['launch', 'compare']);

function getPlatformConfig(platform) {
  return PLATFORM_CONFIG[platform] || null;
}

function detectPlatform(options = {}) {
  const platform = typeof options.platform === 'string' && options.platform
    ? options.platform
    : os.platform();
  const config = getPlatformConfig(platform);

  return {
    platform,
    supported: Boolean(config),
    adapter: config ? config.adapter : null,
    name: config ? config.name : platform,
  };
}

function isToolAvailable(tool, lookupCommand, runner) {
  try {
    runner(lookupCommand, [tool], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

function checkDependencies(options = {}) {
  const platformInfo = detectPlatform(options);
  const config = getPlatformConfig(platformInfo.platform);

  if (!config) {
    return {
      ...platformInfo,
      ok: false,
      available: [],
      missing: [],
      checks: [],
      capabilities: [],
      error: `Unsupported platform: ${platformInfo.platform}`,
    };
  }

  const runner = options.execFileSync || execFileSync;
  const available = [];
  const missing = [];
  const checks = config.dependencies.map((dependency) => {
    if (Array.isArray(dependency.anyOf)) {
      const availableAlternatives = dependency.anyOf.filter((tool) =>
        isToolAvailable(tool, config.lookupCommand, runner)
      );
      const isAvailable = availableAlternatives.length > 0;

      available.push(...availableAlternatives);
      if (!isAvailable) missing.push(dependency.anyOf.join(' or '));

      return {
        name: dependency.name,
        anyOf: [...dependency.anyOf],
        description: dependency.description,
        install: dependency.install,
        available: isAvailable,
        availableTools: availableAlternatives,
      };
    }

    const isAvailable = isToolAvailable(dependency.name, config.lookupCommand, runner);
    if (isAvailable) available.push(dependency.name);
    else missing.push(dependency.name);

    return {
      name: dependency.name,
      description: dependency.description,
      install: dependency.install,
      available: isAvailable,
    };
  });

  const result = {
    ...platformInfo,
    ok: missing.length === 0,
    available,
    missing,
    checks,
  };

  return {
    ...result,
    capabilities: getCapabilities(result),
  };
}

function hasAny(available, tools) {
  return tools.some((tool) => available.has(tool));
}

function getCapabilities(input = {}) {
  if (!Array.isArray(input.available)) {
    return checkDependencies(input).capabilities;
  }

  const platformInfo = detectPlatform(input);
  const config = getPlatformConfig(platformInfo.platform);
  if (!config) return [];

  const available = new Set(Array.isArray(input.available) ? input.available : []);
  const capabilities = new Set(BASE_CAPABILITIES);

  if (platformInfo.platform === 'win32') {
    if (available.has('powershell')) {
      capabilities.add('capture');
      capabilities.add('interact');
      capabilities.add('windows');
    }
  } else if (platformInfo.platform === 'darwin') {
    if (available.has('screencapture')) capabilities.add('capture');
    if (available.has('osascript')) {
      capabilities.add('interact');
      capabilities.add('windows');
    }
  } else if (platformInfo.platform === 'linux') {
    if (available.has('xdotool')) capabilities.add('interact');
    if (available.has('xdotool') && available.has('xprop')) capabilities.add('windows');
    if (available.has('xdotool') && hasAny(available, ['maim', 'import'])) {
      capabilities.add('capture');
    }
  }

  return [...capabilities].sort();
}

module.exports = {
  BASE_CAPABILITIES,
  PLATFORM_CONFIG,
  checkDependencies,
  detectPlatform,
  getCapabilities,
};
