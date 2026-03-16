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
    bindModel();
    rawDb().prepare('DELETE FROM workstations').run();
  });

  describe('add_workstation', () => {
    it('creates a workstation successfully', async () => {
      const result = await callTool('add_workstation', {
        name: 'builder',
        host: '127.0.0.1',
        secret: 'builder-secret',
      });

      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Created workstation "builder"');
      expect(model.getWorkstationByName('builder')).toBeTruthy();
    });

    it('returns an error when name is missing', async () => {
      const result = await callTool('add_workstation', {
        host: '127.0.0.1',
        secret: 'builder-secret',
      });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Missing required parameter: "name"');
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

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('already exists');
    });
  });

  describe('list_workstations', () => {
    it('returns empty list when no workstations exist', async () => {
      const result = await callTool('list_workstations', {});
      const payload = getJsonText(result);

      expect(result.isError).toBeFalsy();
      expect(payload).toEqual({
        workstations: [],
        count: 0,
      });
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

      expect(result.isError).toBeFalsy();
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

      expect(removed.isError).toBeFalsy();
      expect(getText(removed)).toBe('removed');
      expect(model.getWorkstationByName('removable')).toBeNull();
    });

    it('returns not found for missing workstation', async () => {
      const removed = await callTool('remove_workstation', {
        name: 'missing-workstation',
      });

      expect(removed.isError).toBeFalsy();
      expect(getText(removed)).toBe('not found');
    });
  });
});
