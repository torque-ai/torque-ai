'use strict';

const { recordExperience, findRelatedExperiences } = require('../experience/store');

function summarizeResult(result) {
  const provider = typeof result?.provider === 'string' && result.provider.trim()
    ? result.provider
    : 'unknown';
  const description = typeof result?.task_description === 'string'
    ? result.task_description.slice(0, 100)
    : '';
  return `- (sim ${result.similarity}, ${provider}) ${description}`;
}

async function handleFindRelatedExperiences(args) {
  const results = await findRelatedExperiences(args);
  const summary = `${results.length} related experience(s):`;
  const text = results.length > 0
    ? `${summary}\n\n${results.map((result) => summarizeResult(result)).join('\n')}`
    : summary;

  return {
    content: [{ type: 'text', text }],
    structuredData: { results },
  };
}

async function handleRecordExperience(args) {
  await recordExperience(args);
  return {
    content: [{ type: 'text', text: 'Recorded experience' }],
    structuredData: { ok: true },
  };
}

module.exports = { handleFindRelatedExperiences, handleRecordExperience };
