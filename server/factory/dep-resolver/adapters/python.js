'use strict';

const PYTHON_MISS_PATTERNS = [
  { re: /ModuleNotFoundError: No module named ['"]([\w.]+)['"]/, signal: 'ModuleNotFoundError' },
  { re: /ImportError: cannot import name ['"]([\w.]+)['"] from ['"]([\w.]+)['"]/, signal: 'ImportError', groupIndex: 2 },
  { re: /ImportError: No module named ([\w.]+)/, signal: 'ImportError' },
];

function detect(errorOutput) {
  if (typeof errorOutput !== 'string' || errorOutput.length === 0) {
    return { detected: false };
  }
  for (const { re, signal, groupIndex } of PYTHON_MISS_PATTERNS) {
    const m = errorOutput.match(re);
    if (m) {
      const moduleName = m[groupIndex || 1];
      return {
        detected: true,
        manager: 'python',
        module_name: moduleName,
        signals: [signal],
      };
    }
  }
  return { detected: false };
}

function createPythonAdapter() {
  return {
    manager: 'python',
    detect,
    async mapModuleToPackage(_opts) { return { package_name: null, confidence: 'low' }; },
    buildResolverPrompt(_opts) { return ''; },
    validateManifestUpdate(_worktreePath, _expectedPackage) { return { valid: false, reason: 'stub' }; },
  };
}

module.exports = { createPythonAdapter, PYTHON_MISS_PATTERNS };
