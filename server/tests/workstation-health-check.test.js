import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'node:http';

// Inline mock servers for Ollama API and agent-server
function createMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

describe('workstation/health-check', () => {
  let checkWorkstation, checkOllama, checkAgentServer;

  beforeEach(async () => {
    const mod = await import('../workstation/health-check.js');
    checkWorkstation = mod.checkWorkstation;
    checkOllama = mod.checkOllama;
    checkAgentServer = mod.checkAgentServer;
  });

  describe('checkOllama', () => {
    it('returns models from Ollama /api/tags', async () => {
      const { server, port } = await createMockServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          models: [
            { name: 'qwen3-coder:30b', model: 'qwen3-coder:30b' },
            { name: 'llama3:8b', model: 'llama3:8b' },
          ],
        }));
      });

      try {
        const result = await checkOllama('127.0.0.1', port);
        expect(result.healthy).toBe(true);
        expect(result.models).toEqual(['qwen3-coder:30b', 'llama3:8b']);
      } finally {
        await closeServer(server);
      }
    });

    it('rejects when Ollama is unreachable', async () => {
      await expect(checkOllama('127.0.0.1', 19999, 1000)).rejects.toThrow();
    });
  });

  describe('checkAgentServer', () => {
    it('returns system info from agent /health', async () => {
      const { server, port } = await createMockServer((req, res) => {
        if (req.headers['x-torque-secret'] !== 'test-secret') {
          res.writeHead(401);
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          system: {
            platform: 'win32',
            memory_available_mb: 16000,
            memory_total_mb: 32000,
          },
        }));
      });

      try {
        const result = await checkAgentServer('127.0.0.1', port, 'test-secret');
        expect(result.healthy).toBe(true);
        expect(result.system).toEqual({
          platform: 'win32',
          memory_available_mb: 16000,
          memory_total_mb: 32000,
        });
      } finally {
        await closeServer(server);
      }
    });

    it('fails without correct secret', async () => {
      const { server, port } = await createMockServer((req, res) => {
        if (req.headers['x-torque-secret'] !== 'real-secret') {
          res.writeHead(401);
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      });

      try {
        await expect(checkAgentServer('127.0.0.1', port, 'wrong-secret'))
          .rejects.toThrow('HTTP 401');
      } finally {
        await closeServer(server);
      }
    });
  });

  describe('checkWorkstation', () => {
    it('returns healthy when Ollama is reachable but agent is not', async () => {
      const { server: ollamaServer, port: ollamaPort } = await createMockServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          models: [{ name: 'qwen3-coder:30b' }],
        }));
      });

      try {
        const ws = {
          host: '127.0.0.1',
          ollama_port: ollamaPort,
          agent_port: 19998, // not listening
          secret: 'test',
          _capabilities: { ollama: { detected: true, port: ollamaPort } },
        };

        const result = await checkWorkstation(ws);
        expect(result.healthy).toBe(true);
        expect(result.models).toEqual(['qwen3-coder:30b']);
        expect(result.source).toBe('ollama');
        expect(result.system).toBeNull();
      } finally {
        await closeServer(ollamaServer);
      }
    });

    it('returns healthy with system stats when both are reachable', async () => {
      const { server: ollamaServer, port: ollamaPort } = await createMockServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          models: [{ name: 'llama3:8b' }],
        }));
      });

      const { server: agentServer, port: agentPort } = await createMockServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          system: { platform: 'win32', memory_total_mb: 32000 },
        }));
      });

      try {
        const ws = {
          host: '127.0.0.1',
          ollama_port: ollamaPort,
          agent_port: agentPort,
          secret: null,
          _capabilities: { ollama: { detected: true, port: ollamaPort } },
        };

        const result = await checkWorkstation(ws);
        expect(result.healthy).toBe(true);
        expect(result.models).toEqual(['llama3:8b']);
        expect(result.system).toEqual({ platform: 'win32', memory_total_mb: 32000 });
        expect(result.source).toBe('ollama+agent');
      } finally {
        await closeServer(ollamaServer);
        await closeServer(agentServer);
      }
    });

    it('returns unhealthy when nothing is reachable', async () => {
      const ws = {
        host: '127.0.0.1',
        ollama_port: 19997,
        agent_port: 19996,
        secret: 'test',
        _capabilities: { ollama: { detected: true, port: 19997 } },
      };

      const result = await checkWorkstation(ws);
      expect(result.healthy).toBe(false);
      expect(result.source).toBe('none');
    });

    it('returns unhealthy for null workstation', async () => {
      const result = await checkWorkstation(null);
      expect(result.healthy).toBe(false);
    });

    it('skips ollama check when workstation has no ollama capability', async () => {
      const { server: agentServer, port: agentPort } = await createMockServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          system: { platform: 'linux' },
        }));
      });

      try {
        const ws = {
          host: '127.0.0.1',
          agent_port: agentPort,
          secret: null,
          _capabilities: { command_exec: true },
        };

        const result = await checkWorkstation(ws);
        expect(result.healthy).toBe(true);
        expect(result.models).toBeNull();
        expect(result.source).toBe('agent');
      } finally {
        await closeServer(agentServer);
      }
    });
  });
});
