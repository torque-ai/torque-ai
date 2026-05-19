'use strict';

const { findRelatedExperiences, recordExperience } = require('../experience/store');
const { resolveDatabaseFacade } = require('../db/database-facade-resolver');
const { unwrapDbHandle } = require('../utils/db-accessor');

function getRawDb() {
  const rawDb = unwrapDbHandle(resolveDatabaseFacade({
    serviceName: 'experience handlers',
  }));
  return rawDb && typeof rawDb.prepare === 'function' ? rawDb : null;
}

function databaseUnavailableResponse() {
  return {
    isError: true,
    content: [{ type: 'text', text: 'experience handlers require a registered raw database handle' }],
  };
}

function handleFindRelatedExperiences(args = {}) {
  if (!args.task_description || typeof args.task_description !== 'string') {
    return { isError: true, content: [{ type: 'text', text: 'task_description is required' }] };
  }
  const rawDb = getRawDb();
  if (!rawDb) {
    return databaseUnavailableResponse();
  }
  const experiences = findRelatedExperiences({
    project: args.project || null,
    task_description: args.task_description,
    limit: args.limit || 3,
  }, rawDb);
  return {
    content: [{ type: 'text', text: JSON.stringify({ count: experiences.length, experiences }, null, 2) }],
    structuredData: { count: experiences.length, experiences },
  };
}

function handleRecordExperience(args = {}) {
  if (!args.task_description || typeof args.task_description !== 'string') {
    return { isError: true, content: [{ type: 'text', text: 'task_description is required' }] };
  }
  const rawDb = getRawDb();
  if (!rawDb) {
    return databaseUnavailableResponse();
  }
  const result = recordExperience(args, rawDb);
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredData: result,
  };
}

module.exports = {
  handleFindRelatedExperiences,
  handleRecordExperience,
};
