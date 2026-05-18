'use strict';

const { findRelatedExperiences, recordExperience } = require('../experience/store');
const { defaultContainer } = require('../container');

function getRawDb() {
  const db = defaultContainer.peek('db') || require('../database');
  return typeof db.getDbInstance === 'function' ? db.getDbInstance() : db;
}

function handleFindRelatedExperiences(args = {}) {
  if (!args.task_description || typeof args.task_description !== 'string') {
    return { isError: true, content: [{ type: 'text', text: 'task_description is required' }] };
  }
  const experiences = findRelatedExperiences({
    project: args.project || null,
    task_description: args.task_description,
    limit: args.limit || 3,
  }, getRawDb());
  return {
    content: [{ type: 'text', text: JSON.stringify({ count: experiences.length, experiences }, null, 2) }],
    structuredData: { count: experiences.length, experiences },
  };
}

function handleRecordExperience(args = {}) {
  if (!args.task_description || typeof args.task_description !== 'string') {
    return { isError: true, content: [{ type: 'text', text: 'task_description is required' }] };
  }
  const result = recordExperience(args, getRawDb());
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredData: result,
  };
}

module.exports = {
  handleFindRelatedExperiences,
  handleRecordExperience,
};
