'use strict';

function createPythonAdapter() {
  return {
    manager: 'python',
    detect(_errorOutput) { return { detected: false }; },
    async mapModuleToPackage(_opts) { return { package_name: null, confidence: 'low' }; },
    buildResolverPrompt(_opts) { return ''; },
    validateManifestUpdate(_worktreePath, _expectedPackage) { return { valid: false, reason: 'stub' }; },
  };
}

module.exports = { createPythonAdapter };
