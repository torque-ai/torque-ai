'use strict';

const DB_SERVICE_NAME = 'db';

function hasRawDbHandleShape(candidate) {
  return Boolean(candidate)
    && (typeof candidate === 'object' || typeof candidate === 'function')
    && (
      typeof candidate.prepare === 'function'
      || typeof candidate.open === 'boolean'
    );
}

function unwrapFromGetter(dbService, getterName) {
  try {
    const candidate = dbService[getterName]();
    return hasRawDbHandleShape(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function unwrapDbHandle(dbService) {
  if (!dbService) return null;
  if (hasRawDbHandleShape(dbService)) return dbService;
  if (typeof dbService.getDbInstance === 'function') {
    return unwrapFromGetter(dbService, 'getDbInstance');
  }
  if (typeof dbService.getDb === 'function') {
    return unwrapFromGetter(dbService, 'getDb');
  }
  return null;
}

function handleLooksClosed(handle) {
  return Boolean(handle)
    && (typeof handle === 'object' || typeof handle === 'function')
    && (handle.open === false || handle.closed === true);
}

function isDbServiceClosed(dbService) {
  if (!dbService) return false;
  if (typeof dbService.isDbClosed === 'function') {
    try {
      if (dbService.isDbClosed()) return true;
    } catch {
      return true;
    }
  }
  return handleLooksClosed(unwrapDbHandle(dbService));
}

function resolveContainerDbService(defaultContainer) {
  if (
    !defaultContainer
    || (typeof defaultContainer !== 'object' && typeof defaultContainer !== 'function')
  ) {
    return null;
  }

  if (typeof defaultContainer.has === 'function') {
    try {
      if (!defaultContainer.has(DB_SERVICE_NAME)) return null;
    } catch {
      // Fall through to get/peek for lightweight test doubles.
    }
  }

  if (typeof defaultContainer.get === 'function') {
    try {
      const dbService = defaultContainer.get(DB_SERVICE_NAME);
      if (unwrapDbHandle(dbService)) return dbService;
    } catch {
      // Pre-boot containers can still expose registered values through peek().
    }
  }

  if (typeof defaultContainer.peek === 'function') {
    try {
      const dbService = defaultContainer.peek(DB_SERVICE_NAME);
      return unwrapDbHandle(dbService) ? dbService : null;
    } catch {
      return null;
    }
  }

  return null;
}

module.exports = {
  unwrapDbHandle,
  isDbServiceClosed,
  resolveContainerDbService,
};
