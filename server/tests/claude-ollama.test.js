import { describe, expect, it, vi } from 'vitest';

const ClaudeOllamaProvider = require('../providers/claude-ollama');
const child_process = require('child_process');
const hostManagement = require('../db/host-management');

describe('ClaudeOllamaProvider — construction', () => {
  it('has provider name "claude-ollama"', () => {
    const p = new ClaudeOllamaProvider();
    expect(p.name).toBe('claude-ollama');
  });

  it('defaults to enabled=false (opt-in provider)', () => {
    const p = new ClaudeOllamaProvider();
    expect(p.enabled).toBe(false);
  });

  it('respects config.enabled=true', () => {
    const p = new ClaudeOllamaProvider({ enabled: true });
    expect(p.enabled).toBe(true);
  });

  it('exposes supportsStreaming=true', () => {
    const p = new ClaudeOllamaProvider();
    expect(p.supportsStreaming).toBe(true);
  });

  it('derives providerId for config lookups', () => {
    const p = new ClaudeOllamaProvider();
    expect(p.providerId).toBe('claude-ollama');
  });
});

describe('ClaudeOllamaProvider.checkHealth', () => {
  it('returns unavailable when ollama binary is missing', async () => {
    const spawnSyncSpy = vi.spyOn(child_process, 'spawnSync').mockImplementation((bin) => {
      if (String(bin).includes('ollama')) return { status: 1, stderr: 'not found' };
      return { status: 0, stdout: '2.1.0' };
    });
    const p = new ClaudeOllamaProvider({ enabled: true });
    const health = await p.checkHealth();
    expect(health.available).toBe(false);
    expect(health.error).toMatch(/ollama/i);
    spawnSyncSpy.mockRestore();
  });

  it('returns unavailable when claude binary is missing', async () => {
    const spawnSyncSpy = vi.spyOn(child_process, 'spawnSync').mockImplementation((bin) => {
      if (String(bin).includes('claude')) return { status: 1, stderr: 'not found' };
      return { status: 0, stdout: 'ollama version 0.20.7' };
    });
    const p = new ClaudeOllamaProvider({ enabled: true });
    const health = await p.checkHealth();
    expect(health.available).toBe(false);
    expect(health.error).toMatch(/claude/i);
    spawnSyncSpy.mockRestore();
  });

  it('returns unavailable when no active Ollama host has local models', async () => {
    const spawnSyncSpy = vi.spyOn(child_process, 'spawnSync').mockReturnValue({ status: 0, stdout: 'v1' });
    const hostsSpy = vi.spyOn(hostManagement, 'listOllamaHosts').mockReturnValue([]);
    const p = new ClaudeOllamaProvider({ enabled: true });
    const health = await p.checkHealth();
    expect(health.available).toBe(false);
    expect(health.error).toMatch(/no.*host/i);
    spawnSyncSpy.mockRestore();
    hostsSpy.mockRestore();
  });
});

describe('ClaudeOllamaProvider.listModels', () => {
  it('returns union of local models across all active hosts', async () => {
    const hostsSpy = vi.spyOn(hostManagement, 'listOllamaHosts').mockReturnValue([
      { id: 'h1', name: 'HostA', url: 'http://host-a.test:11434', enabled: 1 },
      { id: 'h2', name: 'HostB', url: 'http://host-b.test:11434', enabled: 1 },
    ]);
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      if (url.includes('host-a')) return { ok: true, json: async () => ({ models: [
        { name: 'qwen3-coder:30b' }, { name: 'gemma4:latest' },
      ] }) };
      return { ok: true, json: async () => ({ models: [
        { name: 'qwen3.5:latest' }, { name: 'gemma4:latest' },
      ] }) };
    });
    const p = new ClaudeOllamaProvider({ enabled: true });
    const models = await p.listModels();
    expect(models.sort()).toEqual(['gemma4:latest', 'qwen3-coder:30b', 'qwen3.5:latest']);
    hostsSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  it('filters out cloud-tagged models', async () => {
    const hostsSpy = vi.spyOn(hostManagement, 'listOllamaHosts').mockReturnValue([
      { id: 'h1', url: 'http://host-a.test:11434', enabled: 1 },
    ]);
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true, json: async () => ({ models: [
        { name: 'qwen3-coder:30b' },
        { name: 'qwen3-coder:480b-cloud' },
        { name: 'gpt-oss:120b-cloud' },
      ] }),
    });
    const p = new ClaudeOllamaProvider({ enabled: true });
    const models = await p.listModels();
    expect(models).toEqual(['qwen3-coder:30b']);
    hostsSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  it('returns empty array when no hosts are registered', async () => {
    const hostsSpy = vi.spyOn(hostManagement, 'listOllamaHosts').mockReturnValue([]);
    const p = new ClaudeOllamaProvider({ enabled: true });
    expect(await p.listModels()).toEqual([]);
    hostsSpy.mockRestore();
  });

  it('skips a host whose /api/tags fails', async () => {
    const hostsSpy = vi.spyOn(hostManagement, 'listOllamaHosts').mockReturnValue([
      { id: 'h1', url: 'http://host-a.test:11434', enabled: 1 },
      { id: 'h2', url: 'http://host-b.test:11434', enabled: 1 },
    ]);
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      if (url.includes('host-a')) throw new Error('ECONNREFUSED');
      return { ok: true, json: async () => ({ models: [{ name: 'qwen3.5:latest' }] }) };
    });
    const p = new ClaudeOllamaProvider({ enabled: true });
    const models = await p.listModels();
    expect(models).toEqual(['qwen3.5:latest']);
    hostsSpy.mockRestore();
    fetchSpy.mockRestore();
  });
});
