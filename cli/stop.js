'use strict';

const { API_URL, readPid, cleanPidFile } = require('./shared');

function killPid(pid) {
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

/** Poll for up to `waitMs` to confirm that `pid` has exited. */
async function waitForExit(pid, waitMs = 5000, intervalMs = 250) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0); // signal 0 = probe only; throws if process is gone
    } catch {
      return true; // process no longer exists
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return false; // still alive after timeout
}

async function run() {
  // 1. Try graceful REST API shutdown
  let graceful = false;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${API_URL}/api/shutdown`, {
      method: 'POST',
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (res.ok) {
      console.log('TORQUE shutting down...');
      graceful = true;
    }
  } catch {
    // API not reachable, fall through to PID-based shutdown
  }

  // 2. If API shutdown failed, try PID file
  if (!graceful) {
    const pid = readPid();
    if (pid) {
      console.log(`API unreachable. Sending SIGTERM to PID ${pid}...`);
      if (killPid(pid)) {
        console.log('TORQUE shutting down...');
        // Verify the process actually exits within 5 seconds
        const exited = await waitForExit(pid, 5000);
        if (!exited) {
          console.error(`Warning: PID ${pid} did not exit within 5s after SIGTERM.`);
        }
      } else {
        console.error(`Could not signal PID ${pid}. Process may have already exited.`);
      }
    } else {
      console.error('Could not connect to TORQUE server and no PID file found. Is it running?');
      process.exitCode = 1;
      return;
    }
  }

  // 3. Clean up PID file
  cleanPidFile();
}

module.exports = { run };
