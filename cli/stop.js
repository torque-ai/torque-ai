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
