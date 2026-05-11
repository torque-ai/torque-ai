'use strict';

function isUsableDatabaseFacade(candidate, requiredMethods = []) {
  if (!candidate || typeof candidate !== 'object') {
    return false;
  }
  return requiredMethods.every((methodName) => typeof candidate[methodName] === 'function');
}

function resolveDatabaseFacade({
  explicitDb = null,
  requiredMethods = [],
  serviceName = 'database facade',
} = {}) {
  if (explicitDb) {
    if (isUsableDatabaseFacade(explicitDb, requiredMethods)) {
      return explicitDb;
    }
    throw new Error(`${serviceName} requires database facade methods: ${requiredMethods.join(', ') || '(none)'}`);
  }

  try {
    const { defaultContainer } = require('../container');
    if (typeof defaultContainer?.peek === 'function') {
      const candidate = defaultContainer.peek('db');
      if (isUsableDatabaseFacade(candidate, requiredMethods)) {
        return candidate;
      }
    }
    if (
      typeof defaultContainer?.has === 'function'
      && defaultContainer.has('db')
      && typeof defaultContainer.get === 'function'
    ) {
      const candidate = defaultContainer.get('db');
      if (isUsableDatabaseFacade(candidate, requiredMethods)) {
        return candidate;
      }
    }
  } catch {
    // Surface the service-specific error below.
  }

  throw new Error(`${serviceName} requires the database facade to be registered in the DI container`);
}

module.exports = {
  isUsableDatabaseFacade,
  resolveDatabaseFacade,
};
