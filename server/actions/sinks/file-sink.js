'use strict';

const fs = require('fs');
const path = require('path');

function isPathInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function createFileSink({ workingDir }) {
  if (!workingDir) throw new Error('file sink requires workingDir');
  const root = path.resolve(workingDir);

  return async ({ attrs, content }) => {
    if (!attrs.path) throw new Error('file action requires path attribute');
    const abs = path.resolve(root, attrs.path);
    if (!isPathInside(root, abs)) throw new Error('path escapes working dir');

    const body = content == null ? '' : String(content);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
    return { ok: true, path: attrs.path, bytes: Buffer.byteLength(body) };
  };
}

module.exports = { createFileSink };
