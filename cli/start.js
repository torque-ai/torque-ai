'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process'); // eslint-disable-line security/detect-child-process

const TORQUE_HOME = path.join(process.env.HOME || process.env.USERPROFILE || '~', '.torque');
const PID_FILE = path.join(TORQUE_HOME, 'torque.pid');
const SERVER_PATH = path.resolve(__dirname, '..', 'server', 'index.js');
const API_PORT = parseInt(process.env.TORQUE_API_PORT || '3457', 10);
const API_URL = process.env.TORQUE_API_URL || `http://127.0.0.1:${API_PORT}`;

function ensureTorqueHome() {
  if (!fs.existsSync(TORQUE_HOME)) {
    fs.mkdirSync(TORQUE_HOME, { recursive: true });
  }
}

async function isServerRunning() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${API_URL}/api/status`, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

function readPid() {
  try {
    const content = fs.readFileSync(PID_FILE, 'utf8').trim();
    return parseInt(content, 10) || null;
  } catch {
    return null;
  }
}

function cleanPidFile() {
  try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
}

async function waitForReady(timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isServerRunning()) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function run(args = []) {
  const daemon = args.includes('--daemon') || args.includes('-d');

  // Check if already running
  if (await isServerRunning()) {
    console.log(`TORQUE is already running on port ${API_PORT}`);
    return;
  }

  // Check for stale PID file
  const existingPid = readPid();
  if (existingPid) {
    cleanPidFile();
  }

  // Verify server file exists
  if (!fs.existsSync(SERVER_PATH)) {
    console.error(`Server not found at ${SERVER_PATH}`);
    process.exitCode = 1;
    return;
  }

  ensureTorqueHome();

  if (daemon) {
    console.log('Starting TORQUE in background...');
    const child = spawn('node', [SERVER_PATH], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    child.unref();

    // Write PID file
    fs.writeFileSync(PID_FILE, String(child.pid));

    // Poll for readiness
    const ready = await waitForReady();
    if (ready) {
      console.log(`TORQUE started (PID ${child.pid})`);
      console.log(`  API:       ${API_URL}`);
      console.log(`  Dashboard: http://localhost:${process.env.TORQUE_DASHBOARD_PORT || 3456}`);
    } else {
      console.error('TORQUE started but health check timed out after 10s.');
      console.error('Check server logs for errors.');
      process.exitCode = 1;
    }
  } else {
    // Foreground mode — exec the server directly
    console.log('Starting TORQUE...');
    console.log(`  Server: ${SERVER_PATH}`);
    console.log(`  API:    ${API_URL}\n`);

    const child = spawn('node', [SERVER_PATH], {
      stdio: 'inherit',
      env: { ...process.env },
    });

    // Write PID file
    fs.writeFileSync(PID_FILE, String(child.pid));

    child.on('exit', (code) => {
      cleanPidFile();
      process.exitCode = code || 0;
    });

    // Forward signals
    for (const sig of ['SIGINT', 'SIGTERM']) {
      process.on(sig, () => {
        child.kill(sig);
      });
    }
  }
}

module.exports = { run };
