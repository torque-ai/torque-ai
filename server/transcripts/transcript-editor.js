'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const TOML = require('@iarna/toml');
const { spawn } = require('child_process');
const { validateTranscript } = require('./transcript-validator');

// Open messages as TOML in $EDITOR, validate on save, return updated messages.
function toTomlDocument(messages) {
  return TOML.stringify({ messages });
}

function fromTomlDocument(text) {
  const parsed = TOML.parse(text);
  return parsed.messages || [];
}

async function editTranscript({ messages, editor = process.env.EDITOR || 'vi' }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-edit-'));
  const tmpFile = path.join(tmpDir, 'transcript.toml');
  fs.writeFileSync(tmpFile, toTomlDocument(messages), 'utf8');

  try {
    await new Promise((resolve, reject) => {
      const proc = spawn(editor, [tmpFile], { stdio: 'inherit' });
      proc.on('exit', code => (code === 0 ? resolve() : reject(new Error(`editor exited with ${code}`))));
      proc.on('error', reject);
    });

    const edited = fs.readFileSync(tmpFile, 'utf8');
    const newMessages = fromTomlDocument(edited);
    const validation = validateTranscript(newMessages);
    if (!validation.ok) return { ok: false, messages: null, errors: validation.errors };
    return { ok: true, messages: newMessages, errors: [] };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = { editTranscript, toTomlDocument, fromTomlDocument };
