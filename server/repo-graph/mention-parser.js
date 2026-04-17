'use strict';

const KNOWN_KINDS = new Set(['file', 'symbol', 'repo', 'dir', 'url']);
const MENTION_RE = /@(\w+):([^\s)]+)/g;

function parseMentions(text) {
  if (typeof text !== 'string') {
    return { mentions: [], strippedText: text };
  }

  const mentions = [];
  let strippedText = '';
  let lastIndex = 0;
  let match;

  while ((match = MENTION_RE.exec(text)) !== null) {
    const kind = KNOWN_KINDS.has(match[1]) ? match[1] : 'unknown';
    const index = mentions.length;

    mentions.push({
      kind,
      value: match[2],
      raw: match[0],
      original_kind: match[1],
    });

    strippedText += text.slice(lastIndex, match.index) + `[[MENTION:${index}]]`;
    lastIndex = match.index + match[0].length;
  }

  strippedText += text.slice(lastIndex);
  return { mentions, strippedText };
}

module.exports = { parseMentions };
