const path = require('path');

const ACTIVE_SCRIPTS = [
  'check-live-rest-readiness.js',
  'gpu-metrics-server.js',
  'mcp-dual-agent-smoke.js',
  'mcp-launch-readiness.js',
  'mcp-readiness-pack.js',
  'run-live-rest-local.js',
  'smoke-dashboard-mutations.js',
];

describe('server/scripts active smoke imports', () => {
  for (const scriptName of ACTIVE_SCRIPTS) {
    it(`${scriptName} imports without throwing`, () => {
      const scriptPath = path.join(__dirname, '..', 'scripts', scriptName);
      delete require.cache[require.resolve(scriptPath)];
      expect(() => require(scriptPath)).not.toThrow();
    });
  }
});
