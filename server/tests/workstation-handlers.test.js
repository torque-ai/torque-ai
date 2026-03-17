const {
  setupTestDb,
  teardownTestDb,
  rawDb,
  getText,
} = require('./vitest-setup');

const model = require('../workstation/model');

let handleToolCall;

async function callTool(name, args) {
  try {
    return await handleToolCall(name, args);
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: error?.message || String(error),
        },
      ],
    };
  }
}

function bindModel() {
  model.setDb(rawDb());
}

function getJsonText(result) {
  const text = getText(result);
  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

describe('workstation handlers', () => {
  beforeAll(() => {
    ({ handleToolCall } = setupTestDb('workstation-handlers'));
    bindModel();
  });

  afterAll(() => {
    teardownTestDb();
  });

  beforeEach(() => {
    // Re-bind model to current test db handle — critical when running alongside
    // other test files that may have loaded the model singleton with a different db
    const db = require('../database');
    const dbHandle = db.getDb ? db.getDb() : db.getDbInstance();
    model.setDb(dbHandle);
    rawDb().prepare('DELETE FROM workstations').run();
  });

  describe('add_workstation', () => {
    it('creates a workstation successfully', async () => {
      const result = await callTool('add_workstation', {
        name: 'builder',
        host: '127.0.0.1',
        secret: 'builder-secret',
      });

      const text = getText(result);
      if (result.isError) throw new Error(`Handler error: ${text}`);
      expect(text).toMatch(/registered|created/i);
      expect(model.getWorkstationByName('builder')).toBeTruthy();
    });

    it('returns an error when name is missing', async () => {
      const result = await callTool('add_workstation', {
        host: '127.0.0.1',
        secret: 'builder-secret',
      });

      // Schema validation or handler catches missing name
      const text = getText(result);
      expect(text.toLowerCase()).toMatch(/error|required|missing|name/);
    });

    it('returns an error on duplicate workstation names', async () => {
      await callTool('add_workstation', {
        name: 'dupe-me',
        host: '127.0.0.1',
        secret: 'dupe-secret',
      });

      const result = await callTool('add_workstation', {
        name: 'dupe-me',
        host: '127.0.0.2',
        secret: 'dupe-secret-2',
      });

      const text = getText(result);
      expect(text).toContain('already exists');
    });
  });

  describe('list_workstations', () => {
    it('returns empty list when no workstations exist', async () => {
      const result = await callTool('list_workstations', {});
      const payload = getJsonText(result);

      expect(payload).toBeTruthy();
      expect(payload.count).toBe(0);
      expect(payload.workstations).toEqual([]);
    });

    it('returns all workstations after add', async () => {
      await callTool('add_workstation', {
        name: 'one',
        host: '127.0.0.1',
        secret: 's',
      });
      await callTool('add_workstation', {
        name: 'two',
        host: '127.0.0.2',
        secret: 's',
      });

      const result = await callTool('list_workstations', {});
      const payload = getJsonText(result);

      expect(payload.count).toBe(2);
      expect(payload.workstations.map((ws) => ws.name).sort()).toEqual(['one', 'two']);
    });
  });

  describe('remove_workstation', () => {
    it('removes an existing workstation by name', async () => {
      await callTool('add_workstation', {
        name: 'removable',
        host: '127.0.0.1',
        secret: 'remove-secret',
      });

      const removed = await callTool('remove_workstation', {
        name: 'removable',
      });

      expect(getText(removed)).toContain('removed');
      expect(model.getWorkstationByName('removable')).toBeNull();
    });

    it('returns not found for missing workstation', async () => {
      const removed = await callTool('remove_workstation', {
        name: 'missing-workstation',
      });

      expect(getText(removed)).toContain('not found');
    });
  });
});
