'use strict';

const { findRelatedExperiences } = require('./store');

function buildExperienceBlock(experiences = []) {
  if (!Array.isArray(experiences) || experiences.length === 0) return '';
  const lines = ['## Related past experiences'];
  experiences.forEach((experience, index) => {
    const summary = String(experience.output_summary || experience.task_description || '').replace(/\s+/g, ' ').slice(0, 300);
    const files = (() => {
      try {
        const parsed = JSON.parse(experience.files_modified || '[]');
        return Array.isArray(parsed) && parsed.length ? ` Files: ${parsed.slice(0, 5).join(', ')}.` : '';
      } catch {
        return '';
      }
    })();
    lines.push(`${index + 1}. ${summary}${files}`);
  });
  return lines.join('\n');
}

function injectRelatedExperiences(description, { project = null, task_description = null, db = null, limit = 3 } = {}) {
  const related = findRelatedExperiences({
    project,
    task_description: task_description || description,
    limit,
  }, db);
  const block = buildExperienceBlock(related);
  return block ? `${block}\n\n${description}` : description;
}

module.exports = {
  buildExperienceBlock,
  injectRelatedExperiences,
};
