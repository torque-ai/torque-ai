/**
 * ANSI SGR escape sequence parser.
 * Converts terminal output with ANSI color codes into an array of
 * { text, style } objects suitable for React rendering.
 *
 * Supports: 8 basic colors (30-37 fg, 40-47 bg), bright colors (90-97 fg, 100-107 bg),
 * bold (1), dim (2), italic (3), underline (4), reset (0).
 */

const FG_COLORS = {
  30: '#1e1e1e', // black
  31: '#e55561', // red
  32: '#8cc265', // green
  33: '#d18f52', // yellow
  34: '#4d9ee3', // blue
  35: '#c162de', // magenta
  36: '#42b3c2', // cyan
  37: '#d4d4d4', // white
  90: '#6b737c', // bright black (gray)
  91: '#ff6b6b', // bright red
  92: '#98d867', // bright green
  93: '#e5c07b', // bright yellow
  94: '#61afef', // bright blue
  95: '#d682f0', // bright magenta
  96: '#56d6e4', // bright cyan
  97: '#ffffff', // bright white
};

const BG_COLORS = {
  40: '#1e1e1e',
  41: '#e55561',
  42: '#8cc265',
  43: '#d18f52',
  44: '#4d9ee3',
  45: '#c162de',
  46: '#42b3c2',
  47: '#d4d4d4',
  100: '#6b737c',
  101: '#ff6b6b',
  102: '#98d867',
  103: '#e5c07b',
  104: '#61afef',
  105: '#d682f0',
  106: '#56d6e4',
  107: '#ffffff',
};

// Matches ESC [ <params> m  (SGR sequences)
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[([0-9;]*)m/g;

/**
 * Parse a string containing ANSI escape codes into styled segments.
 * @param {string} text - Raw text with ANSI escape codes
 * @returns {Array<{ text: string, style: object }>} Styled segments
 */
export function parseAnsi(text) {
  if (!text) return [{ text: '', style: {} }];

  const parts = [];
  let currentStyle = {};
  let lastIndex = 0;

  ANSI_RE.lastIndex = 0;
  let match;

  while ((match = ANSI_RE.exec(text)) !== null) {
    // Push text before this escape sequence
    if (match.index > lastIndex) {
      parts.push({ text: text.slice(lastIndex, match.index), style: { ...currentStyle } });
    }
    lastIndex = match.index + match[0].length;

    // Parse SGR parameters
    const params = match[1] ? match[1].split(';').map(Number) : [0];

    for (const code of params) {
      if (code === 0) {
        currentStyle = {};
      } else if (code === 1) {
        currentStyle.fontWeight = 'bold';
      } else if (code === 2) {
        currentStyle.opacity = '0.6';
      } else if (code === 3) {
        currentStyle.fontStyle = 'italic';
      } else if (code === 4) {
        currentStyle.textDecoration = 'underline';
      } else if (FG_COLORS[code]) {
        currentStyle.color = FG_COLORS[code];
      } else if (BG_COLORS[code]) {
        currentStyle.backgroundColor = BG_COLORS[code];
      } else if (code === 39) {
        // Default foreground
        delete currentStyle.color;
      } else if (code === 49) {
        // Default background
        delete currentStyle.backgroundColor;
      }
    }
  }

  // Push remaining text
  if (lastIndex < text.length) {
    parts.push({ text: text.slice(lastIndex), style: { ...currentStyle } });
  }

  // If no escape sequences found (lastIndex still 0), return the whole string unstyled
  if (parts.length === 0 && lastIndex === 0) {
    return [{ text, style: {} }];
  }

  // If escape sequences were found but produced no visible text
  if (parts.length === 0) {
    return [{ text: '', style: {} }];
  }

  return parts;
}

/**
 * Check if a string contains any ANSI escape sequences.
 * @param {string} text
 * @returns {boolean}
 */
export function hasAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return /\u001b\[/.test(text);
}
