'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

function createSessionStore({ rootDir }) {
  fs.mkdirSync(rootDir, { recursive: true });

  function create({ name = null, metadata = null } = {}) {
    const id = `sess_${randomUUID().slice(0, 12)}`;
    const dir = path.join(rootDir, id);
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, 'meta.json'),
      JSON.stringify({ name, metadata, created_at: new Date().toISOString() }),
      'utf8',
    );
    fs.writeFileSync(path.join(dir, 'messages.jsonl'), '', 'utf8');
    return id;
  }

  function append(id, message) {
    const messagesPath = path.join(rootDir, id, 'messages.jsonl');
    fs.appendFileSync(messagesPath, `${JSON.stringify(message)}\n`, 'utf8');
  }

  function readAll(id) {
    const messagesPath = path.join(rootDir, id, 'messages.jsonl');
    if (!fs.existsSync(messagesPath)) return [];
    const content = fs.readFileSync(messagesPath, 'utf8').trim();
    if (!content) return [];
    return content.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  }

  function fork(sourceId, { name = null } = {}) {
    const messages = readAll(sourceId);
    const newId = create({
      name: name || `fork-of-${sourceId}`,
      metadata: { parent_session_id: sourceId },
    });
    for (const message of messages) append(newId, message);
    return newId;
  }

  function exists(id) {
    return fs.existsSync(path.join(rootDir, id, 'meta.json'));
  }

  function list() {
    if (!fs.existsSync(rootDir)) return [];
    return fs.readdirSync(rootDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.startsWith('sess_'))
      .map(entry => ({
        session_id: entry.name,
        meta: JSON.parse(fs.readFileSync(path.join(rootDir, entry.name, 'meta.json'), 'utf8')),
      }));
  }

  return { create, append, readAll, fork, exists, list };
}

module.exports = { createSessionStore };
