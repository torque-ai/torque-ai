'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

describe('REST parity audit', () => {
  test('has no actionable MCP-to-REST gaps or orphaned REST tool metadata', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const output = execFileSync(process.execPath, ['scripts/rest-parity-audit.js', '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    const report = JSON.parse(output);

    expect(report.totals.gaps).toBe(0);
    expect(report.orphaned_routes).toEqual([]);
    expect(report.intentional_omissions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'ack_notification',
        reason: expect.stringContaining('session-scoped'),
      }),
    ]));
  });
});
