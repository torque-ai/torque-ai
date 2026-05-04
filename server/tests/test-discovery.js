/**
 * Ollama Discovery & Failover Tests
 */

const os = require('os');
const discovery = require('../providers/ollama-mdns-discovery');
const { setupTestDb, teardownTestDb, safeTool } = require('./vitest-setup');

describe('Ollama Discovery & Failover', () => {
  beforeAll(() => { setupTestDb('discovery'); });
  afterAll(() => { teardownTestDb(); });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Private subnet detection', () => {
    it.each([
      ['10/8', '10.0.0.9', '10.42.7'],
      ['172.16/12', '172.16.0.200', '172.20.15'],
      ['192.168/16', '192.0.2.7', '192.168.50'],
    ])('includes %s addresses in local subnet discovery', (_range, address, subnet) => {
      vi.spyOn(os, 'networkInterfaces').mockReturnValue({
        Ethernet: [
          { family: 'IPv4', internal: false, address },
        ],
      });

      expect(discovery.getLocalSubnets()).toEqual([subnet]);
    });

    it('excludes 172.x addresses outside the RFC1918 172.16/12 block', () => {
      vi.spyOn(os, 'networkInterfaces').mockReturnValue({
        Ethernet: [
          { family: 'IPv4', internal: false, address: '172.15.0.9' },
          { family: 'IPv4', internal: false, address: '172.32.0.9' },
        ],
      });

      expect(discovery.getLocalSubnets()).toEqual([]);
    });
  });

  describe('check_ollama_health', () => {
    it('returns a result', async () => {
      const result = await safeTool('check_ollama_health', { force_check: true });
      expect(result).toBeDefined();
    });
  });

  describe('Ollama Host Management', () => {
    it('list_ollama_hosts succeeds when empty', async () => {
      const result = await safeTool('list_ollama_hosts', { enabled_only: false });
      expect(result.isError).toBeFalsy();
      expect(result.content).toBeDefined();
    });

    it('add_ollama_host succeeds', async () => {
      const result = await safeTool('add_ollama_host', {
        id: 'test-host',
        name: 'Test',
        url: 'http://localhost:59999'
      });
      expect(result.isError).toBeFalsy();
    });

    it('list_ollama_hosts shows added host', async () => {
      const result = await safeTool('list_ollama_hosts', { enabled_only: false });
      expect(result.isError).toBeFalsy();
      expect(result.content).toBeDefined();
    });

    it('enable_ollama_host succeeds', async () => {
      const result = await safeTool('enable_ollama_host', { host_id: 'test-host' });
      expect(result.isError).toBeFalsy();
    });

    it('disable_ollama_host succeeds', async () => {
      const result = await safeTool('disable_ollama_host', { host_id: 'test-host' });
      expect(result.isError).toBeFalsy();
    });

    it('recover_ollama_host errors for nonexistent host', async () => {
      const result = await safeTool('recover_ollama_host', { host_id: 'nonexistent-host' });
      expect(result.isError).toBe(true);
    });

    it('recover_ollama_host succeeds for existing host', async () => {
      const result = await safeTool('recover_ollama_host', { host_id: 'test-host' });
      expect(result.isError).toBeFalsy();
    });

    it('remove_ollama_host succeeds', async () => {
      const result = await safeTool('remove_ollama_host', { host_id: 'test-host' });
      expect(result.isError).toBeFalsy();
    });
  });

  describe('Discovery Config', () => {
    it('get_discovery_status succeeds', async () => {
      const result = await safeTool('get_discovery_status', {});
      expect(result.isError).toBeFalsy();
      expect(result.content).toBeDefined();
    });

    it('set_discovery_config succeeds', async () => {
      const result = await safeTool('set_discovery_config', {
        discovery_enabled: true,
        discovery_advertise: false,
        discovery_browse: true
      });
      expect(result.isError).toBeFalsy();
    });
  });
});
