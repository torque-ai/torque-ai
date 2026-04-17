import { createRequire } from 'module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createSessionStore } = require('../providers/claude-code/session-store');

describe('claude-code session store', () => {
  const tempDirs = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  function makeStore() {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-claude-session-store-'));
    tempDirs.push(rootDir);
    return {
      rootDir,
      store: createSessionStore({ rootDir }),
    };
  }

  it('creates sessions with metadata and lists them', () => {
    const { rootDir, store } = makeStore();

    const sessionId = store.create({
      name: 'primary-session',
      metadata: { project: 'torque' },
    });

    expect(sessionId).toMatch(/^sess_[a-f0-9-]{12}$/);
    expect(store.exists(sessionId)).toBe(true);

    const metaPath = path.join(rootDir, sessionId, 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

    expect(meta).toMatchObject({
      name: 'primary-session',
      metadata: { project: 'torque' },
      created_at: expect.any(String),
    });
    expect(store.list()).toEqual([{ session_id: sessionId, meta }]);
  });

  it('appends messages and reads them back in order', () => {
    const { store } = makeStore();
    const sessionId = store.create();

    store.append(sessionId, { role: 'user', content: 'hello' });
    store.append(sessionId, { role: 'assistant', content: 'world' });

    expect(store.readAll(sessionId)).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ]);
  });

  it('returns an empty array when a session has no messages yet', () => {
    const { store } = makeStore();
    const sessionId = store.create();

    expect(store.readAll(sessionId)).toEqual([]);
  });

  it('forks a session with copied messages and parent metadata', () => {
    const { rootDir, store } = makeStore();
    const sourceId = store.create({
      name: 'source',
      metadata: { branch: 'main' },
    });
    store.append(sourceId, { role: 'user', content: 'original' });

    const forkId = store.fork(sourceId, { name: 'forked-session' });
    const forkMeta = JSON.parse(fs.readFileSync(path.join(rootDir, forkId, 'meta.json'), 'utf8'));

    expect(forkId).not.toBe(sourceId);
    expect(store.readAll(forkId)).toEqual([{ role: 'user', content: 'original' }]);
    expect(forkMeta).toMatchObject({
      name: 'forked-session',
      metadata: { parent_session_id: sourceId },
    });
  });
});
