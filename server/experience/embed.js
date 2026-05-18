'use strict';

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .filter((token) => token.length > 2);
}

function embedText(text) {
  const tokens = tokenize(text);
  const counts = {};
  for (const token of tokens) counts[token] = (counts[token] || 0) + 1;

  const magnitude = Math.sqrt(Object.values(counts).reduce((sum, value) => sum + value * value, 0));
  if (!magnitude) return {};

  for (const key of Object.keys(counts)) counts[key] = counts[key] / magnitude;
  return counts;
}

function cosineSimilarity(a = {}, b = {}) {
  let dot = 0;
  const [small, large] = Object.keys(a).length < Object.keys(b).length ? [a, b] : [b, a];
  for (const key of Object.keys(small)) {
    if (large[key]) dot += small[key] * large[key];
  }
  return dot;
}

module.exports = { tokenize, embedText, cosineSimilarity };
