'use strict';

function assertBackendName(name) {
  if (!name || typeof name !== 'string') {
    throw new Error('backend name must be a non-empty string');
  }
}

function assertBackendShape(backend) {
  if (!backend || typeof backend !== 'object') {
    throw new Error('backend must be an object');
  }
  if (typeof backend.create !== 'function') {
    throw new Error('backend must implement create(options)');
  }
}

function getFsApi(backend) {
  if (!backend.fs || typeof backend.fs !== 'object') {
    throw new Error('backend does not implement fs operations');
  }
  return backend.fs;
}

function createSandboxManager() {
  const backends = new Map();
  const active = new Map();

  function registerBackend(name, backend) {
    assertBackendName(name);
    assertBackendShape(backend);
    backends.set(name, backend);
  }

  async function create({ backend = 'local-process', ...options } = {}) {
    const impl = backends.get(backend);
    if (!impl) {
      throw new Error(`unknown backend: ${backend}`);
    }

    const result = await impl.create(options);
    if (!result || typeof result.sandboxId !== 'string' || !result.sandboxId) {
      throw new Error(`backend ${backend} returned an invalid sandbox result`);
    }

    active.set(result.sandboxId, {
      backend,
      created_at: Date.now(),
      meta: options,
    });
    return result;
  }

  function getBackendFor(sandboxId) {
    const row = active.get(sandboxId);
    if (!row) {
      throw new Error(`sandbox not found: ${sandboxId}`);
    }

    const backend = backends.get(row.backend);
    if (!backend) {
      throw new Error(`unknown backend: ${row.backend}`);
    }

    return backend;
  }

  async function runCommand(sandboxId, opts) {
    return getBackendFor(sandboxId).runCommand(sandboxId, opts);
  }

  async function readFile(sandboxId, targetPath) {
    return getFsApi(getBackendFor(sandboxId)).read(sandboxId, targetPath);
  }

  async function writeFile(sandboxId, targetPath, content) {
    return getFsApi(getBackendFor(sandboxId)).write(sandboxId, targetPath, content);
  }

  async function listDir(sandboxId, targetPath) {
    return getFsApi(getBackendFor(sandboxId)).list(sandboxId, targetPath);
  }

  async function snapshot(sandboxId) {
    return getBackendFor(sandboxId).snapshot(sandboxId);
  }

  async function destroy(sandboxId) {
    await getBackendFor(sandboxId).destroy(sandboxId);
    active.delete(sandboxId);
    return { destroyed: true };
  }

  function list() {
    return Array.from(active.entries()).map(([id, row]) => ({
      sandbox_id: id,
      ...row,
    }));
  }

  return {
    registerBackend,
    create,
    runCommand,
    readFile,
    writeFile,
    listDir,
    snapshot,
    destroy,
    list,
  };
}

module.exports = { createSandboxManager };
