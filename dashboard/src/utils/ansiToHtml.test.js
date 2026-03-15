import { parseAnsi, hasAnsi } from './ansiToHtml';

describe('parseAnsi', () => {
  it('returns plain text unchanged', () => {
    const result = parseAnsi('hello world');
    expect(result).toEqual([{ text: 'hello world', style: {} }]);
  });

  it('returns single empty-style segment for null/empty input', () => {
    expect(parseAnsi('')).toEqual([{ text: '', style: {} }]);
    expect(parseAnsi(null)).toEqual([{ text: '', style: {} }]);
    expect(parseAnsi(undefined)).toEqual([{ text: '', style: {} }]);
  });

  it('parses green text', () => {
    const result = parseAnsi('\u001b[32mOK\u001b[0m');
    expect(result[0]).toEqual({ text: 'OK', style: { color: '#8cc265' } });
    // After reset, any trailing text would have empty style
  });

  it('parses red text', () => {
    const result = parseAnsi('\u001b[31mERROR\u001b[0m');
    expect(result[0]).toEqual({ text: 'ERROR', style: { color: '#e55561' } });
  });

  it('parses blue text', () => {
    const result = parseAnsi('\u001b[34minfo\u001b[0m');
    expect(result[0]).toEqual({ text: 'info', style: { color: '#4d9ee3' } });
  });

  it('parses bold text', () => {
    const result = parseAnsi('\u001b[1mBOLD\u001b[0m');
    expect(result[0]).toEqual({ text: 'BOLD', style: { fontWeight: 'bold' } });
  });

  it('parses dim text', () => {
    const result = parseAnsi('\u001b[2mfaded\u001b[0m');
    expect(result[0]).toEqual({ text: 'faded', style: { opacity: '0.6' } });
  });

  it('parses italic text', () => {
    const result = parseAnsi('\u001b[3mitalic\u001b[0m');
    expect(result[0]).toEqual({ text: 'italic', style: { fontStyle: 'italic' } });
  });

  it('parses underline text', () => {
    const result = parseAnsi('\u001b[4munderlined\u001b[0m');
    expect(result[0]).toEqual({ text: 'underlined', style: { textDecoration: 'underline' } });
  });

  it('parses background color', () => {
    const result = parseAnsi('\u001b[41mred bg\u001b[0m');
    expect(result[0]).toEqual({ text: 'red bg', style: { backgroundColor: '#e55561' } });
  });

  it('parses combined styles (bold green)', () => {
    const result = parseAnsi('\u001b[1;32mSUCCESS\u001b[0m');
    expect(result[0]).toEqual({
      text: 'SUCCESS',
      style: { fontWeight: 'bold', color: '#8cc265' }
    });
  });

  it('parses bright colors (90-97)', () => {
    const result = parseAnsi('\u001b[91mBRIGHT RED\u001b[0m');
    expect(result[0]).toEqual({ text: 'BRIGHT RED', style: { color: '#ff6b6b' } });
  });

  it('handles reset in the middle', () => {
    const result = parseAnsi('\u001b[31mred\u001b[0m normal \u001b[32mgreen\u001b[0m');
    expect(result).toEqual([
      { text: 'red', style: { color: '#e55561' } },
      { text: ' normal ', style: {} },
      { text: 'green', style: { color: '#8cc265' } },
    ]);
  });

  it('handles text before first escape', () => {
    const result = parseAnsi('prefix \u001b[32mgreen\u001b[0m');
    expect(result[0]).toEqual({ text: 'prefix ', style: {} });
    expect(result[1]).toEqual({ text: 'green', style: { color: '#8cc265' } });
  });

  it('handles text after last escape with no trailing reset', () => {
    const result = parseAnsi('\u001b[33myellow text');
    expect(result[0]).toEqual({ text: 'yellow text', style: { color: '#d18f52' } });
  });

  it('handles default foreground reset (39)', () => {
    const result = parseAnsi('\u001b[31mred\u001b[39mdefault');
    expect(result[0]).toEqual({ text: 'red', style: { color: '#e55561' } });
    expect(result[1]).toEqual({ text: 'default', style: {} });
  });

  it('handles default background reset (49)', () => {
    const result = parseAnsi('\u001b[41mred bg\u001b[49mnormal');
    expect(result[0]).toEqual({ text: 'red bg', style: { backgroundColor: '#e55561' } });
    expect(result[1]).toEqual({ text: 'normal', style: {} });
  });

  it('handles empty SGR (bare reset)', () => {
    const result = parseAnsi('\u001b[31mred\u001b[mnormal');
    expect(result[0]).toEqual({ text: 'red', style: { color: '#e55561' } });
    expect(result[1]).toEqual({ text: 'normal', style: {} });
  });

  it('strips escape sequences that produce no visible text', () => {
    const result = parseAnsi('\u001b[32m\u001b[0m');
    // No text segments with actual content
    expect(result.every(p => p.text === '')).toBe(true);
  });
});

describe('hasAnsi', () => {
  it('returns true for strings with ANSI escapes', () => {
    expect(hasAnsi('\u001b[32mgreen\u001b[0m')).toBe(true);
  });

  it('returns false for plain strings', () => {
    expect(hasAnsi('plain text')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(hasAnsi('')).toBe(false);
  });
});
