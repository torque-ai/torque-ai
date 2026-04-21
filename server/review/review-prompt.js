'use strict';

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['verdict', 'issues'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'warn', 'block'] },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'note'],
        properties: {
          severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          file: { type: 'string' },
          line: { type: 'integer' },
          note: { type: 'string' },
        },
      },
    },
    suggestions: { type: 'array', items: { type: 'string' } },
  },
};

function normalizeText(value) {
  return typeof value === 'string' ? value : String(value ?? '');
}

function buildReviewPrompt(diff, contextFiles) {
  const diffText = normalizeText(diff).slice(0, 30000);
  const relatedFiles = Array.isArray(contextFiles) ? contextFiles.slice(0, 5) : [];
  const relatedSection = relatedFiles.length
    ? `RELATED FILES (callers / dependencies):\n${relatedFiles.map((file) => {
      const filePath = normalizeText(file?.path) || '(unknown path)';
      const content = normalizeText(file?.content).slice(0, 4000);
      return `--- ${filePath} ---\n${content}`;
    }).join('\n\n')}\n\n`
    : '';

  return `You are reviewing a code change before it is committed.

DIFF:
${diffText}

${relatedSection}Return a JSON object matching this schema EXACTLY:

{
  "verdict": "pass" | "warn" | "block",
  "issues": [
    { "severity": "low" | "medium" | "high" | "critical", "file": "path/to/file", "line": 42, "note": "what's wrong" }
  ],
  "suggestions": ["actionable improvements"]
}

Verdict guide:
- pass: no significant issues
- warn: minor issues - should ship but worth noting
- block: bugs, security holes, or missing tests that should prevent commit

Be specific. Cite exact lines. Do NOT invent issues - if the diff looks fine, return verdict="pass" with empty issues.`;
}

module.exports = { REVIEW_SCHEMA, buildReviewPrompt };
