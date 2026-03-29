'use strict';

const ACTION_VERBS = [
  'fix',
  'add',
  'remove',
  'update',
  'change',
  'create',
  'delete',
  'implement',
  'refactor',
  'test',
  'verify',
  'ensure',
  'check',
];

const ACTION_VERB_PATTERN = new RegExp(`\\b(?:${ACTION_VERBS.join('|')})\\b`, 'i');
const ACTION_SPLIT_PATTERN = new RegExp(
  `\\b(?:and|then|also)\\s+(?=(?:${ACTION_VERBS.join('|')})\\b)|,\\s*(?=(?:${ACTION_VERBS.join('|')})\\b)`,
  'i'
);

function normalizeWhitespace(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function collapseWhitespace(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function capitalizeFirst(text) {
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function truncateAtWordBoundary(text, maxLength) {
  const collapsed = collapseWhitespace(text);
  if (collapsed.length <= maxLength) {
    return collapsed;
  }

  const candidate = collapsed.slice(0, maxLength).trimEnd();
  const lastSpace = candidate.lastIndexOf(' ');
  if (lastSpace > 0) {
    return candidate.slice(0, lastSpace).trim();
  }

  return candidate;
}

function splitTitleAndDescription(text) {
  const firstPeriodIndex = text.indexOf('.');

  if (firstPeriodIndex !== -1) {
    return {
      titleSource: truncateAtWordBoundary(text.slice(0, firstPeriodIndex), 80),
      descriptionSource: text.slice(firstPeriodIndex + 1),
    };
  }

  const titleSource = truncateAtWordBoundary(text, 80);
  return {
    titleSource,
    descriptionSource: text.slice(titleSource.length),
  };
}

function cleanDescription(text, fallbackTitle) {
  const description = collapseWhitespace(String(text || '').replace(/^[\s:;,-]+/, ''));
  return description || fallbackTitle;
}

function cleanCriterion(text) {
  return capitalizeFirst(
    collapseWhitespace(String(text || '').replace(/[;:.,!?]+$/g, '').replace(/\b(?:and|then|also)\s*$/i, ''))
  );
}

function generateDefaultCriteria(title) {
  const normalizedTitle = collapseWhitespace(title);
  if (!normalizedTitle) {
    return [];
  }

  const words = normalizedTitle.split(' ');
  const [verb = '', ...rest] = words;
  if (ACTION_VERBS.includes(verb.toLowerCase()) && rest.length > 0) {
    return [`${capitalizeFirst(verb)} ${rest.join(' ')} works correctly`];
  }

  return [`Ensure ${normalizedTitle.charAt(0).toLowerCase()}${normalizedTitle.slice(1)} works correctly`];
}

function extractAcceptanceCriteria(text, title) {
  const segments = normalizeWhitespace(text)
    .split(/\n+/)
    .flatMap(segment => segment.split(/[.!?]+/))
    .map(segment => segment.replace(/^[-*]\s+/, '').replace(/^\d+[.)]\s+/, '').trim())
    .filter(Boolean);

  const criteria = [];
  const seen = new Set();

  for (const segment of segments) {
    const match = segment.match(ACTION_VERB_PATTERN);
    if (!match || match.index == null) {
      continue;
    }

    const actionable = segment.slice(match.index);
    const pieces = actionable
      .split(ACTION_SPLIT_PATTERN)
      .map(cleanCriterion)
      .filter(Boolean);

    for (const piece of pieces) {
      const key = piece.toLowerCase();
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      criteria.push(piece);
    }
  }

  return criteria.length > 0 ? criteria : generateDefaultCriteria(title);
}

function polishTaskDescription(rawText) {
  if (typeof rawText !== 'string') {
    return {
      title: '',
      description: '',
      acceptance_criteria: [],
      acceptanceCriteria: [],
      original: rawText,
      polished: true,
    };
  }

  const normalized = normalizeWhitespace(rawText);
  if (!normalized) {
    return {
      title: '',
      description: '',
      acceptance_criteria: [],
      acceptanceCriteria: [],
      original: rawText,
      polished: true,
    };
  }

  const { titleSource, descriptionSource } = splitTitleAndDescription(normalized);
  const title = capitalizeFirst(titleSource);
  const description = cleanDescription(descriptionSource, title);
  const acceptanceCriteria = extractAcceptanceCriteria(normalized, title);

  return {
    title,
    description,
    acceptance_criteria: acceptanceCriteria,
    acceptanceCriteria,
    original: rawText,
    polished: true,
  };
}

function shouldPolish(rawText) {
  if (typeof rawText !== 'string') {
    return false;
  }

  const normalized = normalizeWhitespace(rawText);
  if (!normalized) {
    return false;
  }

  const under50Chars = normalized.length < 50;
  const hasNoPunctuation = !/[.!?,;:]/.test(normalized);
  const isAllLowercase = /[a-z]/.test(normalized) && normalized === normalized.toLowerCase();
  const isSingleSentenceFragment =
    !/[\n.!?]/.test(normalized) && normalized.split(/\s+/).length <= 12;

  const roughSignals = [
    under50Chars,
    hasNoPunctuation,
    isAllLowercase,
    isSingleSentenceFragment,
  ].filter(Boolean).length;

  return roughSignals >= 3;
}

const isRoughDescription = shouldPolish;

module.exports = {
  polishTaskDescription,
  generateDefaultCriteria,
  shouldPolish,
  isRoughDescription,
};
