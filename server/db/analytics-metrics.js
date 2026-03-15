'use strict';

// Backward-compatible re-export of analytics sub-modules.
// All children have been merged into task-metadata.js and analytics.js.

const eventTracking = require('./event-tracking');
const taskMetadata = require('./task-metadata');
const analytics = require('./analytics');

function setDb(dbInstance) {
  eventTracking.setDb(dbInstance);
  taskMetadata.setDb(dbInstance);
  analytics.setDb(dbInstance);
}

function setGetTask(fn) {
  eventTracking.setGetTask(fn);
  taskMetadata.setGetTask(fn);
  analytics.setGetTask(fn);
}

function setDbFunctions(fns) {
  eventTracking.setDbFunctions(fns);
  analytics.setDbFunctions(fns);
  analytics.setFindSimilarTasks(taskMetadata.findSimilarTasks);
  analytics.setSetPriorityWeights(analytics.setPriorityWeights);
}

module.exports = {
  ...eventTracking,
  ...taskMetadata,
  ...analytics,
  setDb,
  setGetTask,
  setDbFunctions,
};
