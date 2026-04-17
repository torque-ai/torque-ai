import { createRequire } from 'module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createTranscriptLog } = require('../transcripts/transcript-log');

describe('transcriptLog', () => {
  let dir;
  let log;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-'));
    log = createTranscriptLog({ filePath: path.join(dir, 'transcript.jsonl') });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('append + read roundtrips messages in order', () => {
    log.append({ role: 'user', content: 'hi' });
    log.append({ role: 'assistant', content: 'hello' });

    const messages = log.read();

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[1].content).toBe('hello');
  });

  it('each appended line has timestamp + message_id', () => {
    log.append({ role: 'user', content: 'hi' });

    const [message] = log.read();

    expect(message.message_id).toMatch(/^msg_/);
    expect(new Date(message.timestamp).toString()).not.toBe('Invalid Date');
  });

  it('tool_calls are preserved', () => {
    log.append({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'tc1', name: 'read', args: { path: 'a.js' } }],
    });

    const [message] = log.read();

    expect(message.tool_calls[0].name).toBe('read');
  });

  it('read returns [] when file does not exist', () => {
    const empty = createTranscriptLog({ filePath: path.join(dir, 'missing.jsonl') });

    expect(empty.read()).toEqual([]);
  });

  it('skips malformed lines without throwing', () => {
    const filePath = path.join(dir, 'broken.jsonl');
    fs.writeFileSync(filePath, 'not json\n{"role":"user","content":"ok"}\n', 'utf8');

    const transcriptLog = createTranscriptLog({ filePath });
    const messages = transcriptLog.read();

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('ok');
  });

  it('replace overwrites the full file atomically', () => {
    log.append({ role: 'user', content: 'old' });

    log.replace([
      { role: 'user', content: 'new1' },
      { role: 'assistant', content: 'new2' },
    ]);

    const messages = log.read();

    expect(messages.map(message => message.content)).toEqual(['new1', 'new2']);
  });
});
