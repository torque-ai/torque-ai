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
    return { title: '', description: '', acceptanceCriteria: [] };
  }

  const trimmed = rawText.trim();
  const lines = trimmed.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  // Title: first non-empty line, capitalize first letter of each word, max 80 chars
  let title = (lines[0] || '').slice(0, 80);
  title = title.replace(/\b\w/g, l => l.toUpperCase());

  // Acceptance criteria: lines starting with '- ', '* ', or numbered lists
  const criteriaLines = lines
    .filter(line => /^[-*]\s+/.test(line) || /^\d+[.)]\s+/.test(line))
    .map(line => line.replace(/^[-*\d.)\s]+/, '').trim());

  // Description: non-title, non-criteria lines joined, max 500 chars
  const descLines = lines.slice(1).filter(line =>
    !(/^[-*]\s+/.test(line) || /^\d+[.)]\s+/.test(line))
  );
  let description = descLines.join(' ').trim();
  if (description.length > 500) description = description.slice(0, 500).trim() + '...';

  const acceptanceCriteria = criteriaLines.length > 0
    ? criteriaLines
    : generateDefaultCriteria(title);

  return { title, description, acceptanceCriteria };
}

/**
 * Generates default acceptance criteria from the title.
 * @param {string} title - Task title.
 * @returns {string[]} Array of generated criteria.
 */
function generateDefaultCriteria(title) {
  return [
    `${title} works correctly`,
    'No regression in existing functionality',
  ];
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
  isRoughDescription,
};
