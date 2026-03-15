const http = require('http');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const HOST = 'http://localhost:11434';

function createBenchmarkPayload(overrides = {}) {
  return {
    total_duration: 2_000_000_000,
    load_duration: 200_000_000,
    prompt_eval_duration: 500_000_000,
    eval_duration: 1_000_000_000,
    prompt_eval_count: 20,
    eval_count: 40,
    ...overrides,
  };
}

function emitResponse(res, payload) {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  setTimeout(() => {
    res.emit('data', data);
    res.emit('end');
  }, 1);
}

function mockHttpRequest(handler) {
  return vi.spyOn(http, 'request').mockImplementation((options, callback) => {
    const req = new EventEmitter();
    const res = new EventEmitter();

    req.written = '';
    req.write = vi.fn((chunk) => { req.written += chunk; });
    req.end = vi.fn(() => { handler({ options, callback, req, res }); });
    req.destroy = vi.fn();
    res.destroy = vi.fn();

    if (callback) callback(res);
    return req;
  });
}

async function loadBenchmarkWithHome(setupDb) {
  vi.resetModules();
  const benchmarkPath = require.resolve('../benchmark');
  delete require.cache[benchmarkPath];
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-home-'));
  if (setupDb) {
    const dbDir = path.join(tempHome, '.local', 'share', 'torque');
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, 'tasks.db');
    const db = new Database(dbPath);
    setupDb(db);
    db.close();
  }
  vi.spyOn(os, 'homedir').mockReturnValue(tempHome);
  return { mod: require('../benchmark'), tempHome };
}

describe('benchmark.js', () => {
  const tempHomes = [];

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.resetModules();
    for (const home of tempHomes.splice(0)) {
      try {
        fs.rmSync(home, { recursive: true, force: true });
      } catch {
        // best-effort cleanup; benchmark module keeps readonly sqlite handles
      }
    }
  });

  describe('TEST_PROMPTS export', () => {
    it('includes simple/medium/complex keys', async () => {
      const loaded = await loadBenchmarkWithHome();
      tempHomes.push(loaded.tempHome);
      const { mod } = loaded;
      expect(Object.keys(mod.TEST_PROMPTS).sort()).toEqual(['complex', 'medium', 'simple']);
    });

    it('contains non-empty string prompt values', async () => {
      const loaded = await loadBenchmarkWithHome();
      tempHomes.push(loaded.tempHome);
      const { mod } = loaded;
      expect(typeof mod.TEST_PROMPTS.simple).toBe('string');
      expect(typeof mod.TEST_PROMPTS.medium).toBe('string');
      expect(typeof mod.TEST_PROMPTS.complex).toBe('string');
      expect(mod.TEST_PROMPTS.simple.length).toBeGreaterThan(0);
      expect(mod.TEST_PROMPTS.medium.length).toBeGreaterThan(0);
      expect(mod.TEST_PROMPTS.complex.length).toBeGreaterThan(0);
    });
  });

  describe('getConfiguredHosts', () => {
    it('returns enabled hosts from sqlite query', async () => {
      const hosts = [
        { id: 1, name: 'local', url: 'http://127.0.0.1:11434', enabled: 1, status: 'healthy', models_cache: '[]' },
        { id: 2, name: 'desktop', url: 'http://192.168.1.20:11434', enabled: 1, status: 'healthy', models_cache: '[]' },
      ];
      const loaded = await loadBenchmarkWithHome((db) => {
        db.exec(`
          CREATE TABLE ollama_hosts (
            id INTEGER PRIMARY KEY,
            name TEXT,
            url TEXT,
            enabled INTEGER,
            status TEXT,
            models_cache TEXT
          )
        `);
        const insert = db.prepare(`
          INSERT INTO ollama_hosts (id, name, url, enabled, status, models_cache)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const host of hosts) {
          insert.run(host.id, host.name, host.url, host.enabled, host.status, host.models_cache);
        }
      });
      tempHomes.push(loaded.tempHome);
      const { mod } = loaded;
      expect(mod.getConfiguredHosts()).toEqual(hosts);
    });

    it('returns empty array when db is unavailable', async () => {
      const loaded = await loadBenchmarkWithHome();
      tempHomes.push(loaded.tempHome);
      const { mod } = loaded;
      expect(mod.getConfiguredHosts()).toEqual([]);
    });

    it('returns empty array when query throws', async () => {
      const loaded = await loadBenchmarkWithHome((db) => {
        db.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY)');
      });
      tempHomes.push(loaded.tempHome);
      const { mod } = loaded;
      expect(mod.getConfiguredHosts()).toEqual([]);
    });
  });

  describe('getHostModels', () => {
    it('returns model names from /api/tags', async () => {
      const loaded = await loadBenchmarkWithHome();
      tempHomes.push(loaded.tempHome);
      const { mod } = loaded;
      mockHttpRequest(({ options, res }) => {
        expect(options.method).toBe('GET');
        expect(options.path).toBe('/api/tags');
        emitResponse(res, { models: [{ name: 'model1' }, { name: 'model2' }] });
      });

      const models = await mod.getHostModels(HOST);
      expect(models).toEqual(['model1', 'model2']);
    });

    it('returns empty array on request error', async () => {
      const loaded = await loadBenchmarkWithHome();
      tempHomes.push(loaded.tempHome);
      const { mod } = loaded;
      mockHttpRequest(({ req }) => {
        setTimeout(() => req.emit('error', new Error('offline')), 1);
      });

      const models = await mod.getHostModels(HOST);
      expect(models).toEqual([]);
    });

    it('returns empty array on malformed response', async () => {
      const loaded = await loadBenchmarkWithHome();
      tempHomes.push(loaded.tempHome);
      const { mod } = loaded;
      mockHttpRequest(({ res }) => {
        emitResponse(res, 'not-json');
      });

      const models = await mod.getHostModels(HOST);
      expect(models).toEqual([]);
    });
  });

  describe('runBenchmark', () => {
    it('returns success result with computed throughput', async () => {
      const loaded = await loadBenchmarkWithHome();
      tempHomes.push(loaded.tempHome);
      const { mod } = loaded;
      mockHttpRequest(({ options, res }) => {
        expect(options.method).toBe('POST');
        expect(options.path).toBe('/api/generate');
        emitResponse(res, `${JSON.stringify({ partial: true })}\n${JSON.stringify(createBenchmarkPayload())}`);
      });

      const result = await mod.runBenchmark(HOST, 'model-a', mod.TEST_PROMPTS.simple);
      expect(result.success).toBe(true);
      expect(result.model).toBe('model-a');
      expect(result.promptType).toBe('simple');
      expect(result.tokensPerSecond).toBe('40.00');
      expect(result.promptTokensPerSecond).toBe('40.00');
    });

    it('returns failure result when request throws', async () => {
      const loaded = await loadBenchmarkWithHome();
      tempHomes.push(loaded.tempHome);
      const { mod } = loaded;
      mockHttpRequest(({ req }) => {
        setTimeout(() => req.emit('error', new Error('boom')), 1);
      });

      const result = await mod.runBenchmark(HOST, 'model-a', mod.TEST_PROMPTS.medium);
      expect(result.success).toBe(false);
      expect(result.promptType).toBe('medium');
      expect(result.error).toBe('boom');
    });

    it('forwards num_gpu and num_ctx options to request body', async () => {
      const loaded = await loadBenchmarkWithHome();
      tempHomes.push(loaded.tempHome);
      const { mod } = loaded;
      let sentBody;

      mockHttpRequest(({ req, res }) => {
        sentBody = JSON.parse(req.written);
        emitResponse(res, createBenchmarkPayload());
      });

      await mod.runBenchmark(HOST, 'model-a', mod.TEST_PROMPTS.complex, {
        num_gpu: 55,
        num_ctx: 16384,
        num_thread: 8,
        top_k: 10,
      });

      expect(sentBody.options.num_gpu).toBe(55);
      expect(sentBody.options.num_ctx).toBe(16384);
      expect(sentBody.options.num_thread).toBe(8);
      expect(sentBody.options.top_k).toBe(10);
    });

    it('applies default options when none are provided', async () => {
      const loaded = await loadBenchmarkWithHome();
      tempHomes.push(loaded.tempHome);
      const { mod } = loaded;
      let sentBody;

      mockHttpRequest(({ req, res }) => {
        sentBody = JSON.parse(req.written);
        emitResponse(res, createBenchmarkPayload());
      });

      await mod.runBenchmark(HOST, 'model-a', mod.TEST_PROMPTS.simple);
      expect(sentBody.options.num_gpu).toBe(-1);
      expect(sentBody.options.num_ctx).toBe(8192);
      expect(sentBody.options.num_thread).toBe(0);
      expect(sentBody.options.temperature).toBe(0.3);
    });
  });

  describe('runBenchmarkSuite', () => {
    it('runs all prompts against all models', async () => {
      const loaded = await loadBenchmarkWithHome();
      tempHomes.push(loaded.tempHome);
      const { mod } = loaded;
      const calls = [];

      mockHttpRequest(({ req, res }) => {
        calls.push(JSON.parse(req.written));
        emitResponse(res, createBenchmarkPayload());
      });

      const models = ['model-a', 'model-b'];
      const results = await mod.runBenchmarkSuite(HOST, models, 'local');

      expect(results).toHaveLength(6);
      expect(calls).toHaveLength(6);
      const combos = new Set(calls.map(c => `${c.model}::${c.prompt}`));
      expect(combos.size).toBe(6);
    });

    it('includes failed prompt results and continues suite', async () => {
      const loaded = await loadBenchmarkWithHome();
      tempHomes.push(loaded.tempHome);
      const { mod } = loaded;

      mockHttpRequest(({ req, res }) => {
        const body = JSON.parse(req.written);
        if (body.prompt === mod.TEST_PROMPTS.medium) {
          setTimeout(() => req.emit('error', new Error('mid-suite failure')), 1);
          return;
        }
        emitResponse(res, createBenchmarkPayload());
      });

      const results = await mod.runBenchmarkSuite(HOST, ['model-a'], 'local');
      expect(results).toHaveLength(3);
      expect(results.filter(r => r.success)).toHaveLength(2);
      const failed = results.find(r => r.promptType === 'medium');
      expect(failed.success).toBe(false);
      expect(failed.error).toBe('mid-suite failure');
    });
  });

  describe('testGpuLayers', () => {
    it('tests each GPU layer configuration', async () => {
      const loaded = await loadBenchmarkWithHome();
      tempHomes.push(loaded.tempHome);
      const { mod } = loaded;
      const seen = [];

      mockHttpRequest(({ req, res }) => {
        const body = JSON.parse(req.written);
        seen.push(body.options.num_gpu);
        emitResponse(res, createBenchmarkPayload());
      });

      const layers = [-1, 40, 60];
      const results = await mod.testGpuLayers(HOST, 'model-a', layers);
      expect(results.map(r => r.numGpu)).toEqual(layers);
      expect(seen).toEqual(layers);
    });

    it('keeps per-layer failures in the returned results', async () => {
      const loaded = await loadBenchmarkWithHome();
      tempHomes.push(loaded.tempHome);
      const { mod } = loaded;

      mockHttpRequest(({ req, res }) => {
        const body = JSON.parse(req.written);
        if (body.options.num_gpu === 40) {
          setTimeout(() => req.emit('error', new Error('gpu failure')), 1);
          return;
        }
        emitResponse(res, createBenchmarkPayload());
      });

      const results = await mod.testGpuLayers(HOST, 'model-a', [-1, 40, 60]);
      expect(results).toHaveLength(3);
      expect(results.find(r => r.numGpu === 40).success).toBe(false);
      expect(results.find(r => r.numGpu === 40).error).toBe('gpu failure');
    });
  });

  describe('testContextSizes', () => {
    it('tests each context size value', async () => {
      const loaded = await loadBenchmarkWithHome();
      tempHomes.push(loaded.tempHome);
      const { mod } = loaded;
      const seen = [];

      mockHttpRequest(({ req, res }) => {
        const body = JSON.parse(req.written);
        seen.push(body.options.num_ctx);
        emitResponse(res, createBenchmarkPayload());
      });

      const sizes = [4096, 8192, 16384];
      const results = await mod.testContextSizes(HOST, 'model-a', sizes);
      expect(results.map(r => r.numCtx)).toEqual(sizes);
      expect(seen).toEqual(sizes);
    });

    it('records failures for specific context sizes', async () => {
      const loaded = await loadBenchmarkWithHome();
      tempHomes.push(loaded.tempHome);
      const { mod } = loaded;

      mockHttpRequest(({ req, res }) => {
        const body = JSON.parse(req.written);
        if (body.options.num_ctx === 8192) {
          setTimeout(() => req.emit('error', new Error('ctx failure')), 1);
          return;
        }
        emitResponse(res, createBenchmarkPayload());
      });

      const results = await mod.testContextSizes(HOST, 'model-a', [4096, 8192]);
      expect(results).toHaveLength(2);
      expect(results.find(r => r.numCtx === 8192).success).toBe(false);
      expect(results.find(r => r.numCtx === 8192).error).toBe('ctx failure');
    });
  });

  describe('testConcurrency', () => {
    it('returns one result entry per concurrency level', async () => {
      const loaded = await loadBenchmarkWithHome();
      tempHomes.push(loaded.tempHome);
      const { mod } = loaded;
      mockHttpRequest(({ res }) => {
        emitResponse(res, createBenchmarkPayload());
      });

      const levels = [1, 2, 4];
      const results = await mod.testConcurrency(HOST, 'model-a', levels);
      expect(results.map(r => r.concurrent)).toEqual(levels);
      expect(results.every(r => r.successRate === 1)).toBe(true);
    });

    it('issues concurrent requests and reports partial success', async () => {
      const loaded = await loadBenchmarkWithHome();
      tempHomes.push(loaded.tempHome);
      const { mod } = loaded;
      let inFlight = 0;
      let maxInFlight = 0;
      let callCount = 0;

      mockHttpRequest(({ req, res }) => {
        const callIndex = ++callCount;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);

        setTimeout(() => {
          if (callIndex === 2) {
            req.emit('error', new Error('one failed'));
          } else {
            res.emit('data', JSON.stringify(createBenchmarkPayload()));
            res.emit('end');
          }
          inFlight--;
        }, 15);
      });

      const [result] = await mod.testConcurrency(HOST, 'model-a', [3]);
      expect(result.concurrent).toBe(3);
      expect(result.successRate).toBeLessThan(1);
      expect(maxInFlight).toBeGreaterThan(1);
    });
  });
});
