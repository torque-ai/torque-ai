'use strict';

const path = require('path');
const fs = require('fs');

const TORQUE_HOME = path.join(process.env.HOME || process.env.USERPROFILE || '~', '.torque');
const PID_FILE = path.join(TORQUE_HOME, 'torque.pid');
const API_PORT = parseInt(process.env.TORQUE_API_PORT || '3457', 10);
const API_URL = process.env.TORQUE_API_URL || `http://127.0.0.1:${API_PORT}`;

function readPid() {
  try {
    const content = fs.readFileSync(PID_FILE, 'utf8').trim();
    const pid = parseInt(content, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function cleanPidFile() {
  try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
}

module.exports = { TORQUE_HOME, PID_FILE, API_PORT, API_URL, readPid, cleanPidFile };
