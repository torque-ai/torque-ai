/**
 * Mock Ollama HTTP server for deterministic testing.
 * Returns canned responses for /api/generate, /api/tags, /api/show, /api/ps.
 *
 * Supports mutable per-test controls:
 *   setGenerateResponse(fn|string) — change response between tests
 *   setGenerateDelay(ms) — configurable chunk delay for stall tests
 *   setFailGenerate(bool) — toggle failure mode
 *   setStatusCode(code) — set HTTP status code for /api/generate
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
            name: 'codestral:22b',
            model: 'codestral:22b',
            size: 12000000000,
            digest: 'abc123',
            details: { family: 'deepseek', parameter_size: '22B' },
            expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
            size_vram: 12000000000
          }]
        }));
        return;
      }

      if (req.url === '/api/generate' && req.method === 'POST') {
        if (failGenerate) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'mock generation failure' }));
          return;
        }

        setTimeout(() => {
          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          if (parsed.stream === false || !parsed.stream) {
            res.end(JSON.stringify({
              model: parsed.model || DEFAULT_MODEL,
              response: typeof generateResponse === 'function' ? generateResponse(parsed) : generateResponse,
              done: true,
              total_duration: 1000000000,
              load_duration: 100000000,
              prompt_eval_count: 10,
              eval_count: 50,
            }));
          } else {
            // Streaming: send 3 chunks then done
            const text = typeof generateResponse === 'function' ? generateResponse(parsed) : generateResponse;
            const words = text.split(' ');
            const chunk1 = words.slice(0, Math.ceil(words.length / 3)).join(' ') + ' ';
            const chunk2 = words.slice(Math.ceil(words.length / 3), Math.ceil(2 * words.length / 3)).join(' ') + ' ';
            const chunk3 = words.slice(Math.ceil(2 * words.length / 3)).join(' ');
            res.write(JSON.stringify({ model: parsed.model, response: chunk1, done: false }) + '\n');
            res.write(JSON.stringify({ model: parsed.model, response: chunk2, done: false }) + '\n');
            res.write(JSON.stringify({ model: parsed.model, response: chunk3, done: true, total_duration: 1000000000, eval_count: 50 }) + '\n');
            res.end();
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
