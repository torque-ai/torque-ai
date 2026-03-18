const { createMockOllama } = require('./mocks/ollama');
const http = require('http');

function fetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => { resolve({ status: res.statusCode, json: () => JSON.parse(data), text: () => data }); });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

describe('Mock Ollama Server', () => {
  let mock, url;

  beforeAll(async () => {
    mock = createMockOllama();
    const info = await mock.start();
    url = info.url;
  });

  afterAll(async () => { await mock.stop(); });

  it('responds to /api/tags', async () => {
    const res = await fetch(`${url}/api/tags`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.models).toHaveLength(3);
    expect(data.models[0].name).toBe('codellama:latest');
  });

  it('responds to /api/generate', async () => {
    const res = await fetch(`${url}/api/generate`, {
      method: 'POST',
      body: JSON.stringify({ model: 'codellama', prompt: 'hello', stream: false }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.response).toContain('mock');
    expect(data.done).toBe(true);
  });

  it('streams /api/generate by default when stream is omitted', async () => {
    const res = await fetch(`${url}/api/generate`, {
      method: 'POST',
      body: JSON.stringify({ model: 'codellama', prompt: 'hello' }),
    });
    expect(res.status).toBe(200);
    const lines = (await res.text()).trim().split('\n').map(line => JSON.parse(line));
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.at(-1).done).toBe(true);
  });

  it('responds to /api/chat', async () => {
    const res = await fetch(`${url}/api/chat`, {
      method: 'POST',
      body: JSON.stringify({
        model: 'codellama',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.message.content).toContain('mock');
    expect(data.done).toBe(true);
  });

  it('responds to /api/show', async () => {
    const res = await fetch(`${url}/api/show`, {
      method: 'POST',
      body: JSON.stringify({ name: 'codellama' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.details.family).toBe('llama');
  });

  it('returns 404 for unknown model in /api/show', async () => {
    const res = await fetch(`${url}/api/show`, {
      method: 'POST',
      body: JSON.stringify({ name: 'nonexistent-model' }),
    });
    expect(res.status).toBe(404);
  });

  it('responds to /api/ps with default loaded model', async () => {
    const res = await fetch(`${url}/api/ps`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.models).toHaveLength(1);
    expect(data.models[0].name).toBe('codestral:22b');
    expect(data.models[0].size_vram).toBe(12000000000);
  });

  it('responds to /api/ps with empty models when configured', async () => {
    const emptyMock = createMockOllama({ loadedModels: [] });
    const emptyInfo = await emptyMock.start();
    try {
      const res = await fetch(`${emptyInfo.url}/api/ps`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.models).toEqual([]);
    } finally {
      await emptyMock.stop();
    }
  });

  it('logs requests', async () => {
    mock.clearLog();
    await fetch(`${url}/api/tags`);
    expect(mock.requestLog).toHaveLength(1);
    expect(mock.requestLog[0].url).toBe('/api/tags');
  });
});
