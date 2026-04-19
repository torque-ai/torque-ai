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
