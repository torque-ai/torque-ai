'use strict';

const { execFile } = require('child_process'); // eslint-disable-line security/detect-child-process

async function run() {
  const rawPort = process.env.TORQUE_DASHBOARD_PORT;
  const port = rawPort && /^\d+$/.test(rawPort.trim()) ? parseInt(rawPort.trim(), 10) : 3456;
  const url = `http://localhost:${port}`;

  console.log(`Opening dashboard: ${url}`);

  // Cross-platform browser open using execFile (no shell injection risk)
  let cmd;
  let args;
  switch (process.platform) {
    case 'darwin':
      cmd = 'open';
      args = [url];
      break;
    case 'win32':
      cmd = 'cmd';
      args = ['/c', 'start', '', url];
      break;
    default:
      cmd = 'xdg-open';
      args = [url];
      break;
  }

  execFile(cmd, args, (err) => {
    if (err) {
      console.error(`Could not open browser. Visit manually: ${url}`);
    }
  });
}

module.exports = { run };
