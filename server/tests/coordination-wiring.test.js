'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { randomUUID } = require('crypto');

let testDir;
let origDataDir;
let db;
let coord;
const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
let templateBuffer;

function setup() {
  testDir = path.join(os.tmpdir(), `torque-vtest-coord-wiring-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;

  db = require('../database');
  if (!templateBuffer) templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
  db.resetForTest(templateBuffer);
  if (!db.getDb && db.getDbInstance) db.getDb = db.getDbInstance;
  coord = require('../db/coordination');
  coord.setDb(db.getDb());
  coord.setGetTask(db.getTask);
}

function teardown() {
  if (db) try { db.close(); } catch {}
  if (testDir) {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
    if (origDataDir !== undefined) {
      process.env.TORQUE_DATA_DIR = origDataDir;
    } else {
      delete process.env.TORQUE_DATA_DIR;
    }
  }
}

function rawDb() {
  if (db.getDb) return db.getDb();
  return db.getDbInstance();
}

function resetState() {
  const conn = rawDb();
  const tables = [
    'coordination_events',
    'work_stealing_log',
    'agent_metrics',
    'task_claims',
    'task_routing_rules',
    'agent_group_members',
    'agent_groups',
    'agents',
    'distributed_locks',
  ];
  for (const table of tables) {
    conn.prepare(`DELETE FROM ${table}`).run();
  }
}

describe('coordination wiring — MCP session auto-registration', () => {
  beforeAll(() => { setup(); });
  afterAll(() => { teardown(); });
  beforeEach(() => { resetState(); });

  describe('registerAgent creates mcp-session agent', () => {
    it('registers an agent with mcp-session type and expected fields', () => {
      const sessionId = randomUUID();
      const agent = coord.registerAgent({
        id: sessionId,
        name: 'claude-code@unknown',
        agent_type: 'mcp-session',
        capabilities: ['submit', 'await', 'workflow'],
        max_concurrent: 10,
        priority: 0,
        metadata: { transport: 'sse', connected_at: new Date().toISOString() },
      });

      expect(agent).toBeTruthy();
      expect(agent.id).toBe(sessionId);
      expect(agent.name).toBe('claude-code@unknown');
      expect(agent.agent_type).toBe('mcp-session');
      expect(agent.status).toBe('online');
      expect(agent.max_concurrent).toBe(10);
      expect(agent.capabilities).toEqual(['submit', 'await', 'workflow']);
      expect(agent.metadata).toEqual(expect.objectContaining({ transport: 'sse' }));
    });

    it('agent appears in listAgents with status online', () => {
      const sessionId = randomUUID();
      coord.registerAgent({
        id: sessionId,
        name: 'claude-code@unknown',
        agent_type: 'mcp-session',
        capabilities: ['submit', 'await', 'workflow'],
        max_concurrent: 10,
        priority: 0,
        metadata: { transport: 'sse', connected_at: new Date().toISOString() },
      });

      const agents = coord.listAgents({ status: 'online' });
      const found = agents.find(a => a.id === sessionId);
      expect(found).toBeTruthy();
      expect(found.agent_type).toBe('mcp-session');
    });
  });

  describe('updateAgent updates agent name', () => {
    it('updates name from unknown to project name', () => {
      const sessionId = randomUUID();
      coord.registerAgent({
        id: sessionId,
        name: 'claude-code@unknown',
        agent_type: 'mcp-session',
        capabilities: ['submit'],
        max_concurrent: 10,
        priority: 0,
        metadata: { transport: 'sse' },
      });

      const updated = coord.updateAgent(sessionId, { name: 'claude-code@my-project' });
      expect(updated).toBeTruthy();
      expect(updated.name).toBe('claude-code@my-project');

      // Verify via fresh getAgent
      const fetched = coord.getAgent(sessionId);
      expect(fetched.name).toBe('claude-code@my-project');
    });

    it('updates status to offline', () => {
      const sessionId = randomUUID();
      coord.registerAgent({
        id: sessionId,
        name: 'claude-code@unknown',
        agent_type: 'mcp-session',
        capabilities: [],
        max_concurrent: 10,
        priority: 0,
      });

      coord.updateAgent(sessionId, { status: 'offline' });
      const fetched = coord.getAgent(sessionId);
      expect(fetched.status).toBe('offline');
    });
  });

  describe('recordCoordinationEvent with session events', () => {
    it('records session_connected event', () => {
      const sessionId = randomUUID();
      // Register agent first (FK constraint)
      coord.registerAgent({
        id: sessionId,
        name: 'claude-code@unknown',
        agent_type: 'mcp-session',
        capabilities: [],
        max_concurrent: 10,
        priority: 0,
      });

      coord.recordCoordinationEvent('session_connected', sessionId, null, null);

      const events = rawDb()
        .prepare("SELECT * FROM coordination_events WHERE agent_id = ? AND event_type = 'session_connected'")
        .all(sessionId);
      // registerAgent itself records 'agent_joined', plus our explicit call
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].event_type).toBe('session_connected');
      expect(events[0].agent_id).toBe(sessionId);
    });

    it('records session_disconnected event', () => {
      const sessionId = randomUUID();
      coord.registerAgent({
        id: sessionId,
        name: 'claude-code@unknown',
        agent_type: 'mcp-session',
        capabilities: [],
        max_concurrent: 10,
        priority: 0,
      });

      coord.recordCoordinationEvent('session_disconnected', sessionId, null, null);

      const events = rawDb()
        .prepare("SELECT * FROM coordination_events WHERE agent_id = ? AND event_type = 'session_disconnected'")
        .all(sessionId);
      expect(events.length).toBe(1);
      expect(events[0].agent_id).toBe(sessionId);
    });
  });

  describe('full connect/disconnect lifecycle', () => {
    it('simulates connect → name update → disconnect flow', () => {
      const sessionId = randomUUID();

      // 1. Connect: register agent
      const agent = coord.registerAgent({
        id: sessionId,
        name: 'claude-code@unknown',
        agent_type: 'mcp-session',
        capabilities: ['submit', 'await', 'workflow'],
        max_concurrent: 10,
        priority: 0,
        metadata: { transport: 'sse', connected_at: new Date().toISOString() },
      });
      coord.recordCoordinationEvent('session_connected', sessionId, null, null);
      expect(agent.status).toBe('online');

      // 2. First tool call with working_directory → lazy name update
      const projectName = path.basename('/home/user/projects/my-awesome-project');
      coord.updateAgent(sessionId, { name: `claude-code@${projectName}` });

      const namedAgent = coord.getAgent(sessionId);
      expect(namedAgent.name).toBe('claude-code@my-awesome-project');

      // 3. Disconnect: mark offline
      coord.updateAgent(sessionId, { status: 'offline' });
      coord.recordCoordinationEvent('session_disconnected', sessionId, null, null);

      const offlineAgent = coord.getAgent(sessionId);
      expect(offlineAgent.status).toBe('offline');

      // Verify events recorded
      const allEvents = rawDb()
        .prepare('SELECT event_type FROM coordination_events WHERE agent_id = ? ORDER BY created_at')
        .all(sessionId);
      const types = allEvents.map(e => e.event_type);
      expect(types).toContain('agent_joined');
      expect(types).toContain('session_connected');
      expect(types).toContain('session_disconnected');
    });
  });
});
