'use strict';

const { describe, it, expect } = require('vitest');
const { createStreamParser } = require('../actions/stream-parser');

describe('streamParser', () => {
  it('emits a complete action when closing tag arrives', () => {
    const emitted = [];
    const p = createStreamParser({ onAction: (a) => emitted.push(a) });
    p.feed('<action type="file" path="src/foo.js">');
    p.feed('console.log("hi");');
    p.feed('</action>');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual({
      type: 'file', path: 'src/foo.js', content: 'console.log("hi");',
    });
  });

  it('handles multiple actions across chunks', () => {
    const emitted = [];
    const p = createStreamParser({ onAction: (a) => emitted.push(a) });
    p.feed('<action type="shell" cmd="echo" args="hi"></action>');
    p.feed('<action type="file" path="a.txt">hello');
    p.feed('</action>');
    expect(emitted).toHaveLength(2);
    expect(emitted[0].type).toBe('shell');
    expect(emitted[1].type).toBe('file');
  });

  it('ignores text outside action tags', () => {
    const emitted = [];
    const p = createStreamParser({ onAction: (a) => emitted.push(a) });
    p.feed('plain prose. <action type="file" path="x.js">code</action> more prose.');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].path).toBe('x.js');
  });

  it('captures multi-attribute values', () => {
    const emitted = [];
    const p = createStreamParser({ onAction: (a) => emitted.push(a) });
    p.feed('<action type="state_patch" key="round" reducer="numeric_sum">1</action>');
    expect(emitted[0]).toEqual({ type: 'state_patch', key: 'round', reducer: 'numeric_sum', content: '1' });
  });

  it('handles closing tag split across chunks', () => {
    const emitted = [];
    const p = createStreamParser({ onAction: (a) => emitted.push(a) });
    p.feed('<action type="file" path="a">content</ac');
    p.feed('tion>');
    expect(emitted).toHaveLength(1);
  });

  it('ignores malformed tags and continues', () => {
    const emitted = [];
    const p = createStreamParser({ onAction: (a) => emitted.push(a) });
    p.feed('<action invalid="no type">nope</action>');
    p.feed('<action type="file" path="ok.js">ok</action>');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].path).toBe('ok.js');
  });
});
