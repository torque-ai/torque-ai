'use strict';

/**
 * Converts rough task text into structured format.
 */

/**
 * Polishes raw task text into structured fields.
 * @param {string} rawText - The raw task description.
 * @returns {Object} Structured task with title, description, and acceptanceCriteria.
 */
function polishTaskDescription(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return {
      title: '',
      description: '',
      acceptanceCriteria: []
    };
  }

  rawText = rawText.trim();

  // Extract title: first sentence (up to sentence terminator) or first 80 chars
  const sentenceEnd = rawText.search(/[.!?]/);
  const titleEnd = sentenceEnd !== -1 ? sentenceEnd + 1 : Math.min(80, rawText.length);
  let title = rawText.slice(0, titleEnd).trim();

  // Capitalize first letter of each word
  title = title.replace(/\b\w/g, l => l.toUpperCase());

  // Description: remaining text after title, up to 500 chars
  let description = rawText.slice(titleEnd).trim();
  description = description.length > 500 ? description.slice(0, 500).trim() + '...' : description;

  // Acceptance criteria: lines starting with '- ', '* ', or numbered lists (e.g., '1. ', '2) ')
  const criteriaLines = rawText.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line =>
      /^[-*]\s+/.test(line) ||
      /^\d+[.)]\s+/.test(line)
    )
    .map(line => line.replace(/^[-*\d.)\s]+/, '').trim())
  ;

  let acceptanceCriteria = criteriaLines.length > 0
    ? criteriaLines
    : generateDefaultCriteria(title);

  return {
    title,
    description,
    acceptanceCriteria
  };
}

/**
 * Generates default acceptance criteria from the title.
 * @param {string} title - Task title.
 * @returns {string[]} Array of generated criteria.
 */
function generateDefaultCriteria(title) {
  const actions = [
    'Works correctly in all supported environments',
    'No regression in existing functionality',
    'Meets performance requirements',
    'Passes all tests'
  ];

  // Use first two as generic
  return actions.slice(0, 2).map(base =>
    base.replace('correctly', `${title} works correctly`)
  );
}

/**
 * Checks if a task description is rough (short and no newlines).
 * @param {string} text - Input text.
 * @returns {boolean} True if rough.
 */
function isRoughDescription(text) {
  if (!text || typeof text !== 'string') return false;
  return text.length < 50 && !text.includes('\n');
}

module.exports = {
  polishTaskDescription,
  isRoughDescription
};
