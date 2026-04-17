'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

function createTranscriptLog({ filePath }) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  function append(message) {
    const row = {
      message_id: message.message_id || `msg_${randomUUID().slice(0, 12)}`,
      timestamp: message.timestamp || new Date().toISOString(),
      ...message,
    };
    fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
    return row.message_id;
  }

  function read() {
    if (!fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    const out = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line));
      } catch {
        // Skip malformed rows so the remaining transcript stays readable.
      }
    }
    return out;
  }

  function replace(messages) {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, `${messages.map(message => JSON.stringify(message)).join('\n')}\n`, 'utf8');
    fs.renameSync(tmp, filePath);
  }

  return { append, read, replace, filePath };
}

module.exports = { createTranscriptLog };
