'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  RAW_DEFAULT_VERIFY_COMMAND,
  defaultVerifyCommandForProject,
  normalizeRootScopedRequirePaths,
  normalizeVerifyCommandForTestLane,
  wrapVerifyCommandForTestLane,
} = require('../factory/test-lane-verify');

function makeProjectWithLauncher() {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-lane-project-'));
  fs.mkdirSync(path.join(projectPath, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(projectPath, 'scripts', 'test-lane.js'), "'use strict';\n");
  return projectPath;
}

function decodeWrappedCommand(command) {
  const match = command.match(/--command-base64\s+([A-Za-z0-9+/=]+)/);
  return match ? Buffer.from(match[1], 'base64').toString('utf8') : null;
}

describe('factory test lane verify command wrapping', () => {
  test('wraps raw verify commands when the project has the lane launcher', () => {
    const projectPath = makeProjectWithLauncher();
    const command = wrapVerifyCommandForTestLane('cd server && npx vitest run', { projectPath });

    expect(command).toMatch(/^node scripts\/test-lane\.js --lane auto --command-base64 /);
    expect(decodeWrappedCommand(command)).toBe('cd server && npx vitest run');
  });

  test('does not wrap projects without the lane launcher', () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-no-lane-project-'));

    expect(wrapVerifyCommandForTestLane('npm test', { projectPath })).toBe('npm test');
  });

  test('does not double-wrap lane or torque-remote commands', () => {
    const projectPath = makeProjectWithLauncher();
    const laneCommand = 'node scripts/test-lane.js --lane auto --preset server-smoke';
    const remoteCommand = 'torque-remote bash -lc "cd server && npx vitest run"';

    expect(wrapVerifyCommandForTestLane(laneCommand, { projectPath })).toBe(laneCommand);
    expect(wrapVerifyCommandForTestLane(remoteCommand, { projectPath })).toBe(remoteCommand);
  });

  test('defaults to a lane-wrapped server verify command when available', () => {
    const projectPath = makeProjectWithLauncher();
    const command = defaultVerifyCommandForProject(projectPath);

    expect(decodeWrappedCommand(command)).toBe(RAW_DEFAULT_VERIFY_COMMAND);
  });

  test('normalizes root-scoped server vitest commands before lane wrapping', () => {
    const projectPath = makeProjectWithLauncher();
    const raw = 'npx vitest run server/tests/tool-mapping.test.js --coverage';
    const command = wrapVerifyCommandForTestLane(raw, { projectPath });

    expect(normalizeVerifyCommandForTestLane(raw)).toBe(
      'cd server && npx vitest run tests/tool-mapping.test.js --coverage'
    );
    expect(decodeWrappedCommand(command)).toBe(
      'cd server && npx vitest run tests/tool-mapping.test.js --coverage'
    );
  });

  test('normalizes root-scoped node require probes before lane wrapping', () => {
    const projectPath = makeProjectWithLauncher();
    const raw = 'node -e "require(\'server/db/adversarial-reviews.js\')" && npx vitest run server/tests/retrospectives.test.js';
    const command = wrapVerifyCommandForTestLane(raw, { projectPath });

    expect(normalizeRootScopedRequirePaths(raw)).toBe(
      'node -e "require(\'./server/db/adversarial-reviews.js\')" && npx vitest run server/tests/retrospectives.test.js'
    );
    expect(decodeWrappedCommand(command)).toBe(
      'node -e "require(\'./server/db/adversarial-reviews.js\')" && npx vitest run server/tests/retrospectives.test.js'
    );
  });

  test('does not rewrite full-suite coverage commands', () => {
    const projectPath = makeProjectWithLauncher();
    const raw = 'npx vitest run --coverage';
    const command = wrapVerifyCommandForTestLane(raw, { projectPath });

    expect(normalizeVerifyCommandForTestLane(raw)).toBe(raw);
    expect(decodeWrappedCommand(command)).toBe(raw);
  });
});
