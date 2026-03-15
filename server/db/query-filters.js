'use strict';

/**
 * Shared query filter builder for task listing/counting.
 *
 * Extracted from database.js to DRY the duplicate WHERE clause logic
 * in listTasks() and countTasks().
 */

const MAX_TAG_LENGTH = 100;
const MAX_TAGS = 20;

/**
 * Build WHERE conditions and parameter values from a task query options object.
 *
 * @param {Object} options - Query filter options
 * @param {boolean} [options.archivedOnly] - Show only archived tasks
 * @param {boolean} [options.includeArchived] - Include archived tasks
 * @param {string} [options.project] - Filter by project name
 * @param {string} [options.workingDirectory] - Filter by working directory path
 * @param {string} [options.status] - Filter by single status
 * @param {string[]} [options.statuses] - Filter by multiple statuses (IN clause)
 * @param {string[]} [options.tags] - Filter by tags (any match)
 * @param {string} [options.tag] - Filter by single tag
 * @param {string} [options.provider] - Filter by provider
 * @param {string} [options.project_id] - Filter by plan project ID
 * @param {string} [options.from_date] - created_at >= date
 * @param {string} [options.to_date] - created_at < date
 * @param {string} [options.completed_from] - completed_at >= date
 * @param {string} [options.completed_to] - completed_at < date
 * @param {string} [options.search] - Search in task_description (LIKE)
 * @param {Function} escapeLikePattern - Escapes LIKE metacharacters
 * @returns {{ conditions: string[], values: any[] }}
 */
function buildTaskFilterConditions(options, escapeLikePattern) {
  const conditions = [];
  const values = [];

  // Archived filtering
  if (options.archivedOnly) {
    conditions.push('archived = 1');
  } else if (!options.includeArchived) {
    conditions.push('archived = 0');
  }

  // Project filter
  if (options.project) {
    conditions.push('project = ?');
    values.push(options.project);
  }

  // Working directory filter
  if (options.workingDirectory) {
    conditions.push('working_directory = ?');
    values.push(options.workingDirectory);
  }

  // Single status
  if (options.status) {
    conditions.push('status = ?');
    values.push(options.status);
  }

  // Multiple statuses
  if (options.statuses && Array.isArray(options.statuses)) {
    conditions.push(`status IN (${options.statuses.map(() => '?').join(', ')})`);
    values.push(...options.statuses);
  }

  // Tags (any match) with length limits
  if (options.tags && Array.isArray(options.tags) && options.tags.length > 0) {
    const limitedTags = options.tags.slice(0, MAX_TAGS);
    const validTags = limitedTags
      .filter(tag => typeof tag === 'string' && tag.length > 0 && tag.length <= MAX_TAG_LENGTH);
    if (validTags.length > 0) {
      const tagConditions = validTags.map(() => "tags LIKE ? ESCAPE '\\'");
      conditions.push(`(${tagConditions.join(' OR ')})`);
      validTags.forEach(tag => values.push(`%"${escapeLikePattern(tag)}"%`));
    }
  }

  // Single tag
  if (options.tag && typeof options.tag === 'string' && options.tag.length > 0 && options.tag.length <= MAX_TAG_LENGTH) {
    conditions.push("tags LIKE ? ESCAPE '\\'");
    values.push(`%"${escapeLikePattern(options.tag)}"%`);
  }

  // Provider filter
  if (options.provider) {
    conditions.push('provider = ?');
    values.push(options.provider);
  }

  // Plan project filter
  if (options.project_id) {
    conditions.push('id IN (SELECT task_id FROM plan_project_tasks WHERE project_id = ?)');
    values.push(options.project_id);
  }

  // Date range (created_at)
  if (options.from_date) {
    conditions.push('created_at >= ?');
    values.push(options.from_date);
  }
  if (options.to_date) {
    conditions.push('created_at < ?');
    values.push(options.to_date);
  }

  // Date range (completed_at)
  if (options.completed_from) {
    conditions.push('completed_at >= ?');
    values.push(options.completed_from);
  }
  if (options.completed_to) {
    conditions.push('completed_at < ?');
    values.push(options.completed_to);
  }

  // Search in description
  if (options.search && typeof options.search === 'string' && options.search.length > 0) {
    conditions.push("task_description LIKE ? ESCAPE '\\'");
    values.push(`%${escapeLikePattern(options.search)}%`);
  }

  return { conditions, values };
}

/**
 * Append WHERE clause to a query string from conditions array.
 *
 * @param {string} query - Base SQL query
 * @param {string[]} conditions - WHERE conditions
 * @returns {string} Query with WHERE clause appended (if any conditions)
 */
function appendWhereClause(query, conditions) {
  if (conditions.length > 0) {
    return query + ' WHERE ' + conditions.join(' AND ');
  }
  return query;
}

module.exports = {
  buildTaskFilterConditions,
  appendWhereClause,
  MAX_TAG_LENGTH,
  MAX_TAGS,
};
