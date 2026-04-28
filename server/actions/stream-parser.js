'use strict';

const OPEN_RE = /<action\b([^>]*)>/;
const CLOSE_TAG = '</action>';

function parseAttributes(attrString) {
  const attrs = {};
  const re = /(\w+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(attrString)) !== null) attrs[m[1]] = m[2];
  return attrs;
}

function createStreamParser({ onAction }) {
  let buffer = '';
  let state = 'idle';
  let currentAttrs = null;
  let currentContent = '';

  function feed(chunk) {
    buffer += chunk;
    while (true) {
      if (state === 'idle') {
        const m = buffer.match(OPEN_RE);
        if (!m) {
          const idx = buffer.lastIndexOf('<');
          if (idx > 0) buffer = buffer.slice(idx);
          return;
        }
        const attrs = parseAttributes(m[1]);
        if (!attrs.type) {
          buffer = buffer.slice(m.index + m[0].length);
          continue;
        }
        currentAttrs = attrs;
        currentContent = '';
        buffer = buffer.slice(m.index + m[0].length);
        state = 'inside';
      } else {
        const idx = buffer.indexOf(CLOSE_TAG);
        if (idx === -1) {
          const safeEnd = Math.max(0, buffer.length - CLOSE_TAG.length + 1);
          currentContent += buffer.slice(0, safeEnd);
          buffer = buffer.slice(safeEnd);
          return;
        }
        currentContent += buffer.slice(0, idx);
        buffer = buffer.slice(idx + CLOSE_TAG.length);
        onAction?.({ ...currentAttrs, content: currentContent });
        currentAttrs = null;
        currentContent = '';
        state = 'idle';
      }
    }
  }

  function end() {
    state = 'idle';
    currentAttrs = null;
    currentContent = '';
    buffer = '';
  }

  return { feed, end };
}

module.exports = { createStreamParser };
