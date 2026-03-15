/**
 * Webhook Tests
 */

const { setupTestDb, teardownTestDb, safeTool } = require('./vitest-setup');
const { uniqueId } = require('./test-helpers');

describe('Webhooks', () => {
  beforeAll(() => { setupTestDb('webhooks'); });
  afterAll(() => { teardownTestDb(); });

  describe('Webhook Creation', () => {
    it('add_webhook creates webhook', async () => {
      const result = await safeTool('add_webhook', {
        name: uniqueId('webhook'),
        url: 'https://example.com/webhook',
        events: ['completed', 'failed']
      });
      expect(result.isError).toBeFalsy();
    });

    it('add_webhook rejects invalid URL', async () => {
      const result = await safeTool('add_webhook', {
        name: uniqueId('bad'),
        url: 'not-a-url',
        events: ['completed']
      });
      expect(result.isError).toBe(true);
    });

    it('add_webhook rejects non-HTTPS URL', async () => {
      const result = await safeTool('add_webhook', {
        name: uniqueId('http'),
        url: 'http://example.com/webhook',
        events: ['completed']
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('Webhook Management', () => {
    it('list_webhooks returns webhooks', async () => {
      const result = await safeTool('list_webhooks', {});
      expect(result.isError).toBeFalsy();
    });
  });
});
