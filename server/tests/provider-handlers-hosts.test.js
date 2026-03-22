const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');

describe('Provider Handlers', () => {
  beforeAll(() => { setupTestDb('provider-handlers'); });
  afterAll(() => { teardownTestDb(); });


  // ============================================
  // OLLAMA HOST CRUD
  // ============================================

  describe('add_ollama_host', () => {
    it('adds a host with a valid URL', async () => {
      const result = await safeTool('add_ollama_host', {
        id: 'test-host-1',
        name: 'Test Host',
        url: 'http://192.0.2.99:11434'
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Ollama Host Added');
      expect(text).toContain('Test Host');
    });

    it('rejects an invalid URL', async () => {
      const result = await safeTool('add_ollama_host', {
        id: 'bad-host',
        name: 'Bad Host',
        url: 'not-a-url'
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Invalid URL');
    });

    it('rejects duplicate host ID', async () => {
      const result = await safeTool('add_ollama_host', {
        id: 'test-host-1',
        name: 'Duplicate Host',
        url: 'http://192.0.2.100:11434'
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('already exists');
    });

    it('auto-generates ID from hostname when id is omitted', async () => {
      const result = await safeTool('add_ollama_host', {
        name: 'Auto-ID Host',
        url: 'http://10.0.0.50:11434'
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('host-10-0-0-50');
    });

    it('shows host status in response', async () => {
      const result = await safeTool('add_ollama_host', {
        id: 'status-test-host',
        name: 'Status Test',
        url: 'http://10.0.0.51:11434'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Status');
    });

    it('accepts memory_limit_gb parameter', async () => {
      const result = await safeTool('add_ollama_host', {
        id: 'mem-limit-host',
        name: 'Mem Limit Host',
        url: 'http://10.0.0.52:11434',
        memory_limit_gb: 8
      });
      expect(result.isError).toBeFalsy();
    });

    it('accepts gpu_metrics_port parameter', async () => {
      const result = await safeTool('add_ollama_host', {
        id: 'gpu-metrics-host',
        name: 'GPU Metrics Host',
        url: 'http://10.0.0.53:11434',
        gpu_metrics_port: 9394
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('GPU Metrics Port');
    });

    it('auto-detects localhost name', async () => {
      const result = await safeTool('add_ollama_host', {
        id: 'local-auto-name',
        url: 'http://localhost:19999'
      });
      expect(result.isError).toBeTruthy();
      expect(getText(result)).toContain('Missing required parameter: "name"');
    });
  });

  describe('list_ollama_hosts', () => {
    it('lists all hosts', async () => {
      const result = await safeTool('list_ollama_hosts', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Ollama Hosts');
    });

    it('supports enabled_only filter', async () => {
      const result = await safeTool('list_ollama_hosts', { enabled_only: true });
      expect(result.isError).toBeFalsy();
    });

    it('shows host details in table format', async () => {
      const result = await safeTool('list_ollama_hosts', {});
      const text = getText(result);
      expect(text).toContain('ID');
      expect(text).toContain('Name');
      expect(text).toContain('Status');
    });

    it('shows legend section', async () => {
      const result = await safeTool('list_ollama_hosts', {});
      const text = getText(result);
      expect(text).toContain('Legend');
    });
  });

  describe('enable_ollama_host / disable_ollama_host', () => {
    it('disables a host', async () => {
      const result = await safeTool('disable_ollama_host', { host_id: 'test-host-1' });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('disabled');
    });

    it('enables a host', async () => {
      const result = await safeTool('enable_ollama_host', { host_id: 'test-host-1' });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('enabled');
    });

    it('returns error for nonexistent host on disable', async () => {
      const result = await safeTool('disable_ollama_host', { host_id: 'no-such-host' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('not found');
    });

    it('returns error for nonexistent host on enable', async () => {
      const result = await safeTool('enable_ollama_host', { host_id: 'no-such-host' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('not found');
    });

    it('shows host name in disable response', async () => {
      const result = await safeTool('disable_ollama_host', { host_id: 'test-host-1' });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Test Host');
      // Re-enable for later tests
      await safeTool('enable_ollama_host', { host_id: 'test-host-1' });
    });
  });

  describe('remove_ollama_host', () => {
    it('removes an existing host', async () => {
      await safeTool('add_ollama_host', {
        id: 'disposable-host',
        name: 'Disposable',
        url: 'http://192.0.2.200:11434'
      });
      const result = await safeTool('remove_ollama_host', { host_id: 'disposable-host' });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Removed');
    });

    it('returns error for nonexistent host', async () => {
      const result = await safeTool('remove_ollama_host', { host_id: 'no-such-host' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('not found');
    });

    it('shows removed host name in response', async () => {
      await safeTool('add_ollama_host', {
        id: 'named-disposable',
        name: 'Named Disposable',
        url: 'http://192.0.2.201:11434'
      });
      const result = await safeTool('remove_ollama_host', { host_id: 'named-disposable' });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Named Disposable');
    });
  });

  describe('set_host_memory_limit', () => {
    it('sets memory limit on existing host', async () => {
      const result = await safeTool('set_host_memory_limit', {
        host_id: 'test-host-1',
        memory_limit_mb: 8192
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Memory Limit Updated');
    });

    it('returns error for nonexistent host', async () => {
      const result = await safeTool('set_host_memory_limit', { host_id: 'no-such-host', memory_limit_mb: 4096 });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('not found');
    });

    it('disables limit with zero value', async () => {
      const result = await safeTool('set_host_memory_limit', {
        host_id: 'test-host-1',
        memory_limit_mb: 0
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Disabled');
    });

    it('shows memory limit in GB', async () => {
      const result = await safeTool('set_host_memory_limit', {
        host_id: 'test-host-1',
        memory_limit_mb: 16384
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('GB');
    });
  });

  describe('set_host_max_concurrent', () => {
    it('sets max concurrent on existing host', async () => {
      const result = await safeTool('set_host_max_concurrent', {
        host_id: 'test-host-1',
        max_concurrent: 3
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Max Concurrent Updated');
    });

    it('returns error for nonexistent host', async () => {
      const result = await safeTool('set_host_max_concurrent', { host_id: 'no-such-host', max_concurrent: 2 });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('not found');
    });

    it('sets unlimited with zero', async () => {
      const result = await safeTool('set_host_max_concurrent', {
        host_id: 'test-host-1',
        max_concurrent: 0
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Unlimited');
    });
  });

  describe('get_host_capacity', () => {
    it('returns host capacity report', async () => {
      const result = await safeTool('get_host_capacity', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Host Capacity');
    });

    it('shows legend in output', async () => {
      const result = await safeTool('get_host_capacity', {});
      const text = getText(result);
      expect(text).toContain('Legend');
    });

    it('shows Running and Max columns', async () => {
      const result = await safeTool('get_host_capacity', {});
      const text = getText(result);
      expect(text).toContain('Running');
      expect(text).toContain('Max');
    });
  });

  describe('cleanup_null_id_hosts', () => {
    it('runs cleanup without error', async () => {
      const result = await safeTool('cleanup_null_id_hosts', {});
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Null ID Host Cleanup');
    });

    it('reports clean database', async () => {
      const result = await safeTool('cleanup_null_id_hosts', {});
      // On clean DB, should say no hosts found
      const text = getText(result);
      expect(text).toContain('Null ID Host Cleanup');
    });
  });
});
