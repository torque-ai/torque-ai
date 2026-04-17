'use strict';

import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { parseMentions } = require('../repo-graph/mention-parser');

describe('parseMentions', () => {
  it('extracts file mention', () => {
    const r = parseMentions('fix bug in @file:server/app.js please');
    expect(r.mentions).toEqual([{ kind: 'file', value: 'server/app.js', raw: '@file:server/app.js', original_kind: 'file' }]);
  });

  it('extracts symbol mention with dotted path', () => {
    const r = parseMentions('use @symbol:Logger.info for logging');
    expect(r.mentions[0]).toEqual(expect.objectContaining({ kind: 'symbol', value: 'Logger.info' }));
  });

  it('extracts repo mention', () => {
    const r = parseMentions('compare with @repo:torque-core');
    expect(r.mentions[0].kind).toBe('repo');
  });

  it('extracts multiple mentions', () => {
    const r = parseMentions('update @file:a.js and @file:b.js using @symbol:Helper');
    expect(r.mentions).toHaveLength(3);
  });

  it('extracts url mentions', () => {
    const r = parseMentions('see @url:https://example.com/docs');
    expect(r.mentions[0].kind).toBe('url');
    expect(r.mentions[0].value).toBe('https://example.com/docs');
  });

  it('strippedText has mentions replaced with placeholders', () => {
    const r = parseMentions('fix @file:a.js bug');
    expect(r.strippedText).toBe('fix [[MENTION:0]] bug');
  });

  it('ignores plain @ without kind:', () => {
    const r = parseMentions('email @alice about @file:x.js');
    expect(r.mentions).toHaveLength(1);
    expect(r.mentions[0].kind).toBe('file');
  });

  it('unknown mention kinds marked as kind=unknown', () => {
    const r = parseMentions('@custom:something');
    expect(r.mentions[0].kind).toBe('unknown');
  });
});
