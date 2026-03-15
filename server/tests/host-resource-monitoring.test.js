const http = require('http');
const os = require('os');

function getJson(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, body: JSON.parse(body) });
      });
    });
    req.on('error', reject);
  });
}

describe('host resource monitoring', () => {
  let mod;
  let originalCpus;
  let originalLoadavg;
  let originalTotalmem;
  let originalFreemem;
  let originalMemoryUsage;
  let cpuSampleIndex;
  let cpuSamples;

  beforeEach(() => {
    originalCpus = os.cpus;
    originalLoadavg = os.loadavg;
    originalTotalmem = os.totalmem;
    originalFreemem = os.freemem;
    originalMemoryUsage = process.memoryUsage;

    cpuSampleIndex = 0;
    cpuSamples = [
      [
        { times: { user: 100, nice: 0, sys: 0, idle: 900, irq: 0 } },
        { times: { user: 200, nice: 0, sys: 0, idle: 800, irq: 0 } },
      ],
      [
        { times: { user: 130, nice: 0, sys: 0, idle: 970, irq: 0 } },
        { times: { user: 260, nice: 0, sys: 0, idle: 840, irq: 0 } },
      ],
    ];

    os.cpus = () => {
      const index = Math.min(cpuSampleIndex, cpuSamples.length - 1);
      cpuSampleIndex += 1;
      return cpuSamples[index];
    };
    os.loadavg = () => [1.25, 0.75, 0.5];
    os.totalmem = () => 16 * 1024;
    os.freemem = () => 4 * 1024;
    process.memoryUsage = () => ({
      rss: 512 * 1024,
      heapUsed: 128 * 1024,
      heapTotal: 256 * 1024,
    });

    const modPath = require.resolve('../scripts/gpu-metrics-server');
    delete require.cache[modPath];
    mod = require('../scripts/gpu-metrics-server');
  });

  afterEach(() => {
    os.cpus = originalCpus;
    os.loadavg = originalLoadavg;
    os.totalmem = originalTotalmem;
    os.freemem = originalFreemem;
    process.memoryUsage = originalMemoryUsage;
    mod.stop();
  });

  it('cpu metrics include load averages, usage percent, and per-core usage', async () => {
    await mod.refreshMetrics();
    const metrics = await mod.refreshMetrics();

    expect(metrics.cpu.load_avg_1m).toBe(1.25);
    expect(metrics.cpu.load_avg_5m).toBe(0.75);
    expect(metrics.cpu.load_avg_15m).toBe(0.5);
    expect(metrics.cpu.usage_percent).toBe(45);
    expect(metrics.cpu.cores).toEqual([30, 60]);
    expect(metrics.cpuPercent).toBe(45);
  });

  it('memory metrics include total, free, used, and process memory', async () => {
    const metrics = await mod.refreshMetrics();

    expect(metrics.memory.total_bytes).toBe(16 * 1024);
    expect(metrics.memory.free_bytes).toBe(4 * 1024);
    expect(metrics.memory.used_bytes).toBe(12 * 1024);
    expect(metrics.memory.usage_percent).toBe(75);
    expect(metrics.memory.process_rss).toBe(512 * 1024);
    expect(metrics.memory.process_heap_used).toBe(128 * 1024);
    expect(metrics.memory.process_heap_total).toBe(256 * 1024);
    expect(metrics.ramPercent).toBe(75);
  });

  it('isUnderPressure returns false at normal levels', () => {
    expect(mod.isUnderPressure({
      cpu: { usage_percent: 69 },
      memory: { usage_percent: 70 },
    })).toBe(false);
  });

  it('isUnderPressure returns true when CPU or memory exceeds threshold', () => {
    expect(mod.isUnderPressure({
      cpu: { usage_percent: 86 },
      memory: { usage_percent: 10 },
    })).toBe(true);

    expect(mod.isUnderPressure({
      cpu: { usage_percent: 10 },
      memory: { usage_percent: 86 },
    })).toBe(true);
  });

  it('getPressureLevel returns the correct level for each range', () => {
    expect(mod.getPressureLevel({
      cpu: { usage_percent: 60 },
      memory: { usage_percent: 60 },
    })).toBe('none');

    expect(mod.getPressureLevel({
      cpu: { usage_percent: 70 },
      memory: { usage_percent: 60 },
    })).toBe('moderate');

    expect(mod.getPressureLevel({
      cpu: { usage_percent: 85 },
      memory: { usage_percent: 60 },
    })).toBe('moderate');

    expect(mod.getPressureLevel({
      cpu: { usage_percent: 86 },
      memory: { usage_percent: 60 },
    })).toBe('high');

    expect(mod.getPressureLevel({
      cpu: { usage_percent: 95 },
      memory: { usage_percent: 60 },
    })).toBe('high');

    expect(mod.getPressureLevel({
      cpu: { usage_percent: 96 },
      memory: { usage_percent: 60 },
    })).toBe('critical');
  });

  it('metrics endpoint includes gpu, cpu, and memory objects', async () => {
    await mod.refreshMetrics();
    const server = mod.createServer();

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    try {
      const address = server.address();
      const { statusCode, body } = await getJson(address.port, '/metrics');

      expect(statusCode).toBe(200);
      expect(body).toHaveProperty('gpu');
      expect(body).toHaveProperty('cpu');
      expect(body).toHaveProperty('memory');
      expect(body.cpu.usage_percent).toBeDefined();
      expect(body.memory.usage_percent).toBe(75);
      expect(Array.isArray(body.cpu.cores)).toBe(true);
      expect(body).toHaveProperty('cpuPercent');
      expect(body).toHaveProperty('ramPercent');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
