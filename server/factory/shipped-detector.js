'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FILE_REFERENCE_REGEX = /(server|dashboard|docs|scripts|tests)\/[\w.\-/]+\.(tsx|jsx|json|html|sql|css|md|ts|js)/g;
const TITLE_STOPWORDS = new Set([
  'implementation',
  'plan',
  'phase',
  'a',
  'the',
  'for',
  'of',
  '—',
  '-',
  ':',
]);

function escapeForRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}

function normalizeTitleTokens(title) {
  const original = String(title || '');
  const unique = [];
  const seen = new Set();

  // Primary pass: alphanumeric tokens of length >= 4, stopwords excluded.
  for (const token of original.toLowerCase().match(/[a-z0-9]+/g) || []) {
    if (token.length < 4 || TITLE_STOPWORDS.has(token) || seen.has(token)) {
      continue;
    }
    seen.add(token);
    unique.push(token);
  }

  // Acronym pass: 3-4 letter ALL-CAPS tokens from the ORIGINAL (pre-lowercase)
  // title catch domain acronyms like PII, API, MCP, XML, SQL, XSS that the
  // min-4-char filter otherwise strips. Matches only standalone caps tokens,
  // so Title-Case words ("Guard") and lowercased words don't leak in.
  for (const acronym of original.match(/\b[A-Z]{3,4}\b/g) || []) {
    const lower = acronym.toLowerCase();
    if (TITLE_STOPWORDS.has(lower) || seen.has(lower)) {
      continue;
    }
    seen.add(lower);
    unique.push(lower);
  }

  return unique;
}

function extractFileReferences(content) {
  const matches = String(content || '').match(FILE_REFERENCE_REGEX) || [];
  return [...new Set(matches)];
}

function resolveFileReference(repoRoot, relativePath) {
  return path.resolve(repoRoot, ...relativePath.split('/'));
}

function defaultRunGitLog(repoRoot, { grep, limit = 50 }) {
  if (!repoRoot || !grep) {
    return [];
  }

  try {
    const output = execFileSync('git', [
      '-C',
      repoRoot,
      'log',
      '--extended-regexp',
      `--grep=${grep}`,
      '--format=%s',
      '-n',
      String(limit),
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function createShippedDetector({ repoRoot, runGitLog } = {}) {
  function detectShipped({ content, title }) {
    const fileReferences = extractFileReferences(content);
    let existingCount = 0;

    if (repoRoot) {
      for (const relativePath of fileReferences) {
        if (fs.existsSync(resolveFileReference(repoRoot, relativePath))) {
          existingCount += 1;
        }
      }
    }

    const fileExistenceRatio = fileReferences.length > 0
      ? existingCount / fileReferences.length
      : null;

    const titleTokens = normalizeTitleTokens(title);
    const grep = titleTokens.join('|');

    // Require at least two meaningful tokens so generic single-word titles
    // do not get marked as already shipped by broad commit subject matches.
    const canScoreGitMatches = titleTokens.length >= 2;
    const subjects = canScoreGitMatches
      ? (runGitLog || ((args) => defaultRunGitLog(repoRoot, args)))({ grep, limit: 50 })
      : [];

    let maxOverlap = 0;
    let bestSubject = null;
    for (const subject of subjects) {
      let overlap = 0;
      for (const token of titleTokens) {
        const tokenPattern = new RegExp(`\\b${escapeForRegExp(token)}\\b`, 'i');
        if (tokenPattern.test(subject)) {
          overlap += 1;
        }
      }
      if (overlap > maxOverlap) {
        maxOverlap = overlap;
        bestSubject = subject;
      }
    }

    const gitMatchScore = canScoreGitMatches && titleTokens.length > 0
      ? maxOverlap / titleTokens.length
      : 0;
    const topTokens = titleTokens.slice(0, 2);
    const commitKeywordHit = topTokens.length === 2 && subjects.some((subject) => (
      topTokens.every((token) => {
        const tokenPattern = new RegExp(`\\b${escapeForRegExp(token)}\\b`, 'i');
        return tokenPattern.test(subject);
      })
    ));

    let confidence = 'low';
    let shipped = false;
    if (gitMatchScore >= 0.6 || (commitKeywordHit && fileExistenceRatio !== null && fileExistenceRatio >= 0.8)) {
      confidence = 'high';
      shipped = true;
    } else if (fileExistenceRatio !== null && fileExistenceRatio >= 0.8 && gitMatchScore >= 0.3) {
      confidence = 'medium';
      shipped = true;
    }

    return {
      shipped,
      confidence,
      signals: {
        file_reference_total: fileReferences.length,
        existing_file_count: existingCount,
        file_existence_ratio: fileExistenceRatio,
        title_tokens: titleTokens,
        git_subject_match: {
          grep: canScoreGitMatches ? grep : null,
          subject_count: subjects.length,
          max_overlap: maxOverlap,
          best_subject: bestSubject,
        },
        git_match_score: gitMatchScore,
        commit_keyword_hit: commitKeywordHit,
      },
    };
  }

  return { detectShipped };
}

module.exports = { createShippedDetector };
