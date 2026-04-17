'use strict';

const Module = require('module');
const path = require('path');

const SHIM_PATHS = {
  'better-sqlite3': path.join(__dirname, 'better-sqlite3.js'),
  uuid: path.join(__dirname, 'uuid.js'),
};

function installBetterSqlite3Shim() {
  if (global.__torqueBetterSqlite3ShimInstalled) {
    return;
  }

  const originalResolveFilename = Module._resolveFilename;
  Module._resolveFilename = function patchedResolveFilename(request, parent, isMain, options) {
    if (Object.prototype.hasOwnProperty.call(SHIM_PATHS, request)) {
      return SHIM_PATHS[request];
    }
    return originalResolveFilename.call(this, request, parent, isMain, options);
  };

  global.__torqueBetterSqlite3ShimInstalled = true;
}

module.exports = { installBetterSqlite3Shim };
