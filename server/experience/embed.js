'use strict';

const crypto = require('crypto');

async function embedText(text) {
  return hashVector(text);
}

function hashVector(text, dim = 64) {
  const safeDim = Number.isInteger(dim) && dim > 0 ? dim : 64;
  const vector = new Array(safeDim).fill(0);
  const tokens = String(text || '').toLowerCase().match(/\w+/g) || [];

  for (const token of tokens) {
    const hash = crypto.createHash('sha1').update(token).digest();
    const index = hash.readUInt16BE(0) % safeDim;
    vector[index] += 1;
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + (value * value), 0)) || 1;
  return vector.map((value) => value / norm);
}

function cosineSim(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    return 0;
  }

  let dot = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += (Number(a[index]) || 0) * (Number(b[index]) || 0);
  }
  return dot;
}

module.exports = { embedText, hashVector, cosineSim };
