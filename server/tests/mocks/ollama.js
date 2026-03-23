/**
 * Mock Ollama HTTP server for deterministic testing.
 * Returns canned responses for /api/generate, /api/chat, /api/tags, /api/show, /api/ps.
 *
 * Supports mutable per-test controls:
 *   setGenerateResponse(fn|string) — change response between tests
 *   setGenerateDelay(ms) — configurable chunk delay for stall tests
 *   setFailGenerate(bool) — toggle failure mode
 *   setStatusCode(code) — set HTTP status code for /api/generate and /api/chat
 */
const http = require('http');

const DEFAULT_MODEL = 'codellama:latest';

const MODELS = [
  { name: 'codellama:latest', size: 3825819519, digest: 'abc123', modified_at: '2024-01-01T00:00:00Z' },
  { name: 'llama3:latest', size: 4109853184, digest: 'def456', modified_at: '2024-01-01T00:00:00Z' },
  { name: 'mistral:latest', size: 4109853184, digest: 'ghi789', modified_at: '2024-01-01T00:00:00Z' },
];

function createMockOllama(options = {}) {
  let generateResponse = options.generateResponse || 'This is a mock LLM response for testing.';
  let generateDelay = options.generateDelay || 0;
  let failGenerate = options.failGenerate || false;
  let statusCode = options.statusCode || 200;
  let models = options.models || MODELS;

  const requestLog = [];

  function resolveResponse(parsed) {
    return typeof generateResponse === 'function' ? generateResponse(parsed) : generateResponse;
  }

  function toGenerateText(response) {
    if (response && typeof response === 'object' && !Array.isArray(response)) {
      if (typeof response.response === 'string') return response.response;
      if (typeof response.content === 'string') return response.content;
      if (response.message && typeof response.message.content === 'string') {
        return response.message.content;
      }
    }
    return String(response ?? '');
  }

  function toChatMessage(response) {
    if (response && typeof response === 'object' && !Array.isArray(response)) {
      if (response.message && typeof response.message === 'object') {
        return {
          role: response.message.role || 'assistant',
          content: response.message.content ?? '',
          ...(response.message.tool_calls ? { tool_calls: response.message.tool_calls } : {}),
        };
      }

      return {
        role: response.role || 'assistant',
        content: response.content ?? response.response ?? '',
        ...(response.tool_calls ? { tool_calls: response.tool_calls } : {}),
      };
    }

    return { role: 'assistant', content: String(response ?? '') };
  }

  function splitTextIntoChunks(text) {
    const words = text.split(' ');
    return [
      words.slice(0, Math.ceil(words.length / 3)).join(' ') + ' ',
      words.slice(Math.ceil(words.length / 3), Math.ceil(2 * words.length / 3)).join(' ') + ' ',
      words.slice(Math.ceil(2 * words.length / 3)).join(' '),
    ];
  }

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      requestLog.push({ method: req.method, url: req.url, body: parsed, timestamp: Date.now() });

      if (req.url === '/api/tags' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models }));
        return;
      }

      if (req.url === '/api/show' && req.method === 'POST') {
        const model = models.find(m => m.name === parsed.name || m.name.startsWith(parsed.name));
        if (model) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ modelfile: '', parameters: '', template: '', details: { family: 'llama', parameter_size: '7B', quantization_level: 'Q4_0' } }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'model not found' }));
        }
        return;
      }

      if (req.url === '/api/ps' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          models: options.loadedModels || [{
            name: 'qwen3-coder:30b',
            model: 'qwen3-coder:30b',
            size: 12000000000,
            digest: 'abc123',
            details: { family: 'deepseek', parameter_size: '22B' },
            expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
            size_vram: 12000000000
          }]
        }));
        return;
      }

      if ((req.url === '/api/generate' || req.url === '/api/chat') && req.method === 'POST') {
        if (failGenerate) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'mock generation failure' }));
          return;
        }

        setTimeout(() => {
          const model = parsed.model || DEFAULT_MODEL;
          const response = resolveResponse(parsed);

          if (req.url === '/api/generate') {
            if (parsed.stream === false) {
              res.writeHead(statusCode, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                model,
                response: toGenerateText(response),
                done: true,
                total_duration: 1000000000,
                load_duration: 100000000,
                prompt_eval_count: 10,
                eval_count: 50,
              }));
            } else {
              const text = toGenerateText(response);
              const [chunk1, chunk2, chunk3] = splitTextIntoChunks(text);
              res.writeHead(statusCode, { 'Content-Type': 'application/x-ndjson' });
              res.write(JSON.stringify({ model, response: chunk1, done: false }) + '\n');
              res.write(JSON.stringify({ model, response: chunk2, done: false }) + '\n');
              res.write(JSON.stringify({ model, response: chunk3, done: true, total_duration: 1000000000, eval_count: 50 }) + '\n');
              res.end();
            }
          } else {
            const message = toChatMessage(response);
            if (parsed.stream === false) {
              res.writeHead(statusCode, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                model,
                message,
                done: true,
                total_duration: 1000000000,
                load_duration: 100000000,
                prompt_eval_count: 10,
                eval_count: 50,
              }));
            } else {
              const [chunk1, chunk2, chunk3] = splitTextIntoChunks(message.content || '');
              res.writeHead(statusCode, { 'Content-Type': 'application/x-ndjson' });
              res.write(JSON.stringify({
                model,
                message: {
                  role: message.role || 'assistant',
                  content: chunk1,
                  ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
                },
                done: false,
              }) + '\n');
              res.write(JSON.stringify({
                model,
                message: {
                  role: message.role || 'assistant',
                  content: chunk2,
                },
                done: false,
              }) + '\n');
              res.write(JSON.stringify({
                model,
                message: {
                  role: message.role || 'assistant',
                  content: chunk3,
                },
                done: true,
                total_duration: 1000000000,
                prompt_eval_count: 10,
                eval_count: 50,
              }) + '\n');
              res.end();
            }
          }
        }, generateDelay);
        return;
      }

      // Default: 404
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });

  return {
    server,
    requestLog,
    clearLog() { requestLog.length = 0; },

    // Mutable per-test controls
    setGenerateResponse(fn) { generateResponse = fn; },
    setGenerateDelay(ms) { generateDelay = ms; },
    setFailGenerate(bool) { failGenerate = bool; },
    setStatusCode(code) { statusCode = code; },
    setModels(newModels) { models = newModels; },

    start() {
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const { port } = server.address();
          resolve({ port, url: `http://127.0.0.1:${port}` });
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        server.close(resolve);
      });
    },
  };
}

module.exports = { createMockOllama, MODELS, DEFAULT_MODEL };
