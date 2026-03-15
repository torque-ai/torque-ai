'use strict';

const LINE_START = '[FILE CONTEXT]';
const CHUNK_CONTEXT_HEADER = '[CHUNK CONTEXT]';
const REVIEW_INSTRUCTIONS_HEADER = '[REVIEW INSTRUCTIONS]';
const RESPONSE_FORMAT_HEADER = '[RESPONSE FORMAT]';
const CODE_HEADER = '[CODE]';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const normalizeImportPaths = (file) => {
  if (!isRecord(file) || !Array.isArray(file.importPaths)) {
    return [];
  }

  return file.importPaths
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean);
};

const normalizeFileContents = (value) => {
  if (!isRecord(value)) {
    return {};
  }

  return value;
};

const getFileSnippet = (fileContents, relativePath) => {
  const safeContents = normalizeFileContents(fileContents);
  const snippet = safeContents[relativePath];

  if (typeof snippet !== 'string') {
    return '';
  }

  return snippet;
};

const buildCategoryInstructions = (categories) => {
  if (!isRecord(categories)) {
    return '';
  }

  const lines = [];

  for (const [categoryKey, category] of Object.entries(categories)) {
    if (!isRecord(category)) {
      continue;
    }

    const label = typeof category.label === 'string' && category.label.trim().length > 0
      ? category.label.trim()
      : categoryKey;
    const guidance = typeof category.prompt_guidance === 'string'
      ? category.prompt_guidance
      : '';

    lines.push(`- ${label}: ${guidance}`);
  }

  return lines.join('\n');
};

const buildResponseFormat = () => [
  RESPONSE_FORMAT_HEADER,
  'Respond with a JSON array.',
  'If no issues are found, return: []',
  '',
  'Each array element must contain exactly these fields:',
  '- file_path (string, relative path of the file where the issue was found)',
  '- category (string)',
  '- subcategory (string)',
  '- severity (critical|high|medium|low|info)',
  '- confidence (high|medium|low)',
  '- title (one-line string)',
  '- description (string)',
  '- suggestion (string)',
  '- line_start (number)',
  '- line_end (number)',
  '- snippet (string)',
  '',
  'Return only JSON. Example:',
  '[{ "file_path": "src/app.js", "category": "...", "subcategory": "...", "severity": "high", "confidence": "medium", "title": "...", "description": "...", "suggestion": "...", "line_start": 1, "line_end": 3, "snippet": "..." }]',
].join('\n');

const buildReviewPrompt = ({ unit, preamble, categories, fileContents } = {}) => {
  if (!isRecord(unit)) {
    throw new TypeError('buildReviewPrompt requires a unit object');
  }

  const files = Array.isArray(unit.files) ? unit.files : [];
  const chunks = [];
  const safePreamble = typeof preamble === 'string' ? preamble : '';
  const safeCategoryInstructions = buildCategoryInstructions(categories);
  const safeChunkContext = typeof unit.chunkContext === 'string' ? unit.chunkContext : '';

  if (safePreamble.length > 0) {
    chunks.push(safePreamble);
  }

  chunks.push(LINE_START);
  if (files.length === 0) {
    chunks.push('No files provided.');
  } else {
    for (const file of files) {
      const relativePath = isRecord(file) && typeof file.relativePath === 'string' ? file.relativePath : '';
      const importPaths = normalizeImportPaths(file).join(', ');
      if (relativePath.length > 0) {
        chunks.push(`- file: ${relativePath}`);
      }
      chunks.push(`This file imports from: ${importPaths}`);
    }
  }

  if (unit.chunked && safeChunkContext.length > 0) {
    chunks.push(CHUNK_CONTEXT_HEADER);
    chunks.push(safeChunkContext);
  }

  chunks.push(REVIEW_INSTRUCTIONS_HEADER);
  if (safeCategoryInstructions.length > 0) {
    chunks.push(safeCategoryInstructions);
  }

  chunks.push(buildResponseFormat());

  chunks.push(CODE_HEADER);
  if (unit.chunked) {
    const chunkContent = typeof unit.chunkContent === 'string' ? unit.chunkContent : '';
    chunks.push(chunkContent);
  } else {
    for (const file of files) {
      const relativePath = isRecord(file) && typeof file.relativePath === 'string'
        ? file.relativePath
        : '';
      const header = relativePath.length > 0
        ? `--- file: ${relativePath} ---`
        : '--- file: unknown ---';
      const snippet = getFileSnippet(fileContents, relativePath);

      chunks.push(header);
      chunks.push(snippet);
    }
  }

  return chunks.join('\n');
};

module.exports = {
  buildReviewPrompt,
  buildCategoryInstructions,
  buildResponseFormat,
};
