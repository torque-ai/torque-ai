'use strict';

const { setupTestDb, teardownTestDb } = require('./vitest-setup');

let db;

beforeAll(() => {
  const setup = setupTestDb('events');
  db = setup.db.getDbInstance();
});

afterAll(() => teardownTestDb());

beforeEach(() => {
  db.prepare('DELETE FROM task_events').run();
});

describe('event-emitter', () => {
  it('persists an event and assigns an id + ts', () => {
    const { emitTaskEvent } = require('../events/event-emitter');
    const evt = emitTaskEvent({
      task_id: 't1',
      type: 'task.created',
      actor: 'test',
      payload: { foo: 'bar' },
    });

    expect(evt.id).toBeGreaterThan(0);
    expect(evt.ts).toMatch(/^\d{4}-\d{2}-\d{2}/);

    const row = db.prepare('SELECT * FROM task_events WHERE id = ?').get(evt.id);
    expect(row.task_id).toBe('t1');
    expect(row.type).toBe('task.created');
    expect(row.event_type).toBe('task.created');
    const payload = JSON.parse(row.payload_json);
    expect(payload.foo).toBe('bar');
  });

  it('lists events for a task in chronological order', () => {
    const { emitTaskEvent, listEvents } = require('../events/event-emitter');
    emitTaskEvent({ task_id: 't1', type: 'task.created', payload: {} });
    emitTaskEvent({ task_id: 't1', type: 'task.queued', payload: {} });
    emitTaskEvent({ task_id: 't1', type: 'task.running', payload: {} });

    const events = listEvents({ task_id: 't1' });
    expect(events.map((event) => event.type)).toEqual(['task.created', 'task.queued', 'task.running']);
  });

  it('filters by event type', () => {
    const { emitTaskEvent, listEvents } = require('../events/event-emitter');
    emitTaskEvent({ task_id: 't1', type: 'task.created', payload: {} });
    emitTaskEvent({ task_id: 't1', type: 'tool.called', payload: { tool: 'shell' } });

    const tools = listEvents({ task_id: 't1', type: 'tool.called' });
    expect(tools).toHaveLength(1);
    expect(tools[0].payload.tool).toBe('shell');
  });

  it('rejects unknown event types', () => {
    const { emitTaskEvent } = require('../events/event-emitter');
    expect(() => emitTaskEvent({ task_id: 't1', type: 'made.up.event', payload: {} }))
      .toThrow(/unknown event type/i);
  });

  it('survives huge payloads by truncating', () => {
    const { emitTaskEvent } = require('../events/event-emitter');
    const huge = 'x'.repeat(200000);
    const evt = emitTaskEvent({ task_id: 't1', type: 'tool.called', payload: { output: huge } });

    const row = db.prepare('SELECT payload_json FROM task_events WHERE id = ?').get(evt.id);
    expect(row.payload_json.length).toBeLessThan(120000);
    expect(JSON.parse(row.payload_json)._truncated).toBe(true);
  });
});
