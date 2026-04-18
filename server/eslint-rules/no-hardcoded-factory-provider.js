'use strict';

const HARDCODED_PROVIDER_RE = /^(codex|codex-spark|claude-cli|anthropic|ollama|ollama-cloud|deepinfra|hyperbolic|cerebras|groq|google-ai|openrouter|<git-user>|<git-user>-spark)$/;

function normalizeFilename(context) {
  const filename = typeof context.filename === 'string' ? context.filename : context.getFilename();
  return typeof filename === 'string' ? filename.replace(/\\/g, '/') : '';
}

function isScopedFile(filename) {
  return filename.includes('server/factory/') || filename.includes('server/handlers/');
}

function isProviderKey(key) {
  if (!key) return false;
  if (key.type === 'Identifier') return key.name === 'provider';
  if (key.type === 'Literal') return key.value === 'provider';
  return false;
}

function hasAllowComment(sourceCode, node) {
  const comments = sourceCode.getCommentsBefore(node);
  if (!comments.length || !node.loc) return false;

  const lastComment = comments[comments.length - 1];
  if (!lastComment.loc || lastComment.loc.end.line !== node.loc.start.line - 1) {
    return false;
  }

  return /allow-factory-provider:\s*\S/.test(lastComment.value.trim());
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow hardcoded provider literals in factory code paths that should route through templates.',
    },
    messages: {
      hardcodedProvider: 'Hardcoded provider "{{name}}" bypasses the routing template system. Use handleSmartSubmitTask and let plan_generation/default categories route via templates.',
    },
    schema: [],
  },
  create(context) {
    const filename = normalizeFilename(context);
    if (!isScopedFile(filename)) {
      return {};
    }

    const sourceCode = context.sourceCode || context.getSourceCode();

    return {
      Property(node) {
        if (!isProviderKey(node.key)) return;
        if (!node.value || node.value.type !== 'Literal' || typeof node.value.value !== 'string') return;
        if (!HARDCODED_PROVIDER_RE.test(node.value.value)) return;
        if (hasAllowComment(sourceCode, node)) return;

        context.report({
          node,
          messageId: 'hardcodedProvider',
          data: {
            name: node.value.value,
          },
        });
      },
    };
  },
};
