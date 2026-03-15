#!/usr/bin/env node
/**
 * GPU Metrics Server for TORQUE
 *
 * Lightweight companion that serves nvidia-smi GPU metrics over HTTP.
 * Can run standalone on remote machines, or is auto-started by TORQUE MCP server.
 *
 * Standalone usage:
 *   node gpu-metrics-server.js                     # default port 9394
 *   node gpu-metrics-server.js --port 9400        # custom port
 *   node gpu-metrics-server.js --interval-ms 2500 # custom sample interval
 *
 * Module usage (from TORQUE):
 *   const gpuMetrics = require('./scripts/gpu-metrics-server');
 *   await gpuMetrics.start({ port: 9394, intervalMs: 5000 });
 *   gpuMetrics.stop();
 *
 * Endpoints:
 *   GET /metrics  → JSON { gpu, cpu, memory, ...legacyAliases }
 *   GET /health   → { status: "ok" }
 */

const http = require('http');
const { execFile } = require('child_process');
const os = require('os');

const DEFAULT_PORT = 9394;
const DEFAULT_SAMPLE_INTERVAL_MS = 5000;
const PRESSURE_THRESHOLDS = Object.freeze({
  moderate: 70,
  high: 85,
  critical: 95,
});

// State
let cachedMetrics = null;
let nvidiaSmiPath = null;
let server = null;
let refreshInterval = null;
let sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS;
let previousCpuSnapshot = null;

function clampPercent(value) {
  if (!Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function toInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function toFloat(value, fallback) {
  const parsed = Number.parseFloat(value);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function getDefaultGpuMetrics() {
  return {
    gpuUtilizationPercent: null,
    vramUsedMb: 0,
    vramTotalMb: 0,
    temperatureC: null,
    powerDrawW: null,
  };
}

function normalizeGpuMetrics(gpuMetrics) {
  const source = gpuMetrics && typeof gpuMetrics === 'object' ? gpuMetrics : {};
  const defaults = getDefaultGpuMetrics();
  return {
    gpuUtilizationPercent: source.gpuUtilizationPercent == null ? defaults.gpuUtilizationPercent : toInteger(source.gpuUtilizationPercent, defaults.gpuUtilizationPercent),
    vramUsedMb: source.vramUsedMb == null ? defaults.vramUsedMb : toInteger(source.vramUsedMb, defaults.vramUsedMb),
    vramTotalMb: source.vramTotalMb == null ? defaults.vramTotalMb : toInteger(source.vramTotalMb, defaults.vramTotalMb),
    temperatureC: source.temperatureC == null ? defaults.temperatureC : toInteger(source.temperatureC, defaults.temperatureC),
    powerDrawW: source.powerDrawW == null ? defaults.powerDrawW : toFloat(source.powerDrawW, defaults.powerDrawW),
  };
}

function getDefaultCpuMetrics() {
  return {
    load_avg_1m: 0,
    load_avg_5m: 0,
    load_avg_15m: 0,
    usage_percent: null,
    cores: [],
  };
}

function normalizeCpuMetrics(cpuMetrics) {
  const source = cpuMetrics && typeof cpuMetrics === 'object' ? cpuMetrics : {};
  const defaults = getDefaultCpuMetrics();
  return {
    load_avg_1m: Number.isFinite(source.load_avg_1m) ? source.load_avg_1m : defaults.load_avg_1m,
    load_avg_5m: Number.isFinite(source.load_avg_5m) ? source.load_avg_5m : defaults.load_avg_5m,
    load_avg_15m: Number.isFinite(source.load_avg_15m) ? source.load_avg_15m : defaults.load_avg_15m,
    usage_percent: typeof source.usage_percent === 'number' ? clampPercent(source.usage_percent) : defaults.usage_percent,
    cores: Array.isArray(source.cores)
      ? source.cores.map((usage) => (typeof usage === 'number' ? clampPercent(usage) : null))
      : defaults.cores,
  };
}

function getDefaultMemoryMetrics() {
  return {
    total_bytes: 0,
    free_bytes: 0,
    used_bytes: 0,
    usage_percent: null,
    process_rss: 0,
    process_heap_used: 0,
    process_heap_total: 0,
  };
}

function normalizeMemoryMetrics(memoryMetrics) {
  const source = memoryMetrics && typeof memoryMetrics === 'object' ? memoryMetrics : {};
  const defaults = getDefaultMemoryMetrics();
  return {
    total_bytes: Number.isFinite(source.total_bytes) ? source.total_bytes : defaults.total_bytes,
    free_bytes: Number.isFinite(source.free_bytes) ? source.free_bytes : defaults.free_bytes,
    used_bytes: Number.isFinite(source.used_bytes) ? source.used_bytes : defaults.used_bytes,
    usage_percent: typeof source.usage_percent === 'number' ? clampPercent(source.usage_percent) : defaults.usage_percent,
    process_rss: Number.isFinite(source.process_rss) ? source.process_rss : defaults.process_rss,
    process_heap_used: Number.isFinite(source.process_heap_used) ? source.process_heap_used : defaults.process_heap_used,
    process_heap_total: Number.isFinite(source.process_heap_total) ? source.process_heap_total : defaults.process_heap_total,
  };
}

function buildMetricsPayload({ gpuMetrics, cpuMetrics, memoryMetrics }) {
  const gpu = normalizeGpuMetrics(gpuMetrics);
  const cpu = normalizeCpuMetrics(cpuMetrics);
  const memory = normalizeMemoryMetrics(memoryMetrics);
  const pressureSource = { gpu, cpu, memory };
  const pressureLevel = getPressureLevel(pressureSource);
  const underPressure = isUnderPressure(pressureSource);

  return {
    gpu,
    cpu,
    memory,
    pressureLevel,
    underPressure,

    // Preserve flat aliases for existing consumers like host-monitoring.
    gpuUtilizationPercent: gpu.gpuUtilizationPercent,
    vramUsedMb: gpu.vramUsedMb,
    vramTotalMb: gpu.vramTotalMb,
    temperatureC: gpu.temperatureC,
    powerDrawW: gpu.powerDrawW,
    cpuPercent: cpu.usage_percent,
    ramPercent: memory.usage_percent,
  };
}

function getCpuSnapshots() {
  const cpus = os.cpus();
  if (!Array.isArray(cpus) || cpus.length === 0) return null;

  return cpus.map((cpu) => {
    const times = cpu && cpu.times ? cpu.times : {};
    const user = Number(times.user) || 0;
    const nice = Number(times.nice) || 0;
    const sys = Number(times.sys) || 0;
    const idle = Number(times.idle) || 0;
    const irq = Number(times.irq) || 0;

    return {
      idle,
      total: user + nice + sys + idle + irq,
    };
  });
}

function buildCpuUsage(currentSnapshot, previousSnapshotForSample) {
  const sameShape = Array.isArray(previousSnapshotForSample)
    && previousSnapshotForSample.length === currentSnapshot.length;

  const cores = [];
  let totalActive = 0;
  let totalTicks = 0;

  for (let index = 0; index < currentSnapshot.length; index += 1) {
    const current = currentSnapshot[index];
    const previous = sameShape ? previousSnapshotForSample[index] : null;

    let activeTicks;
    let totalCoreTicks;

    if (previous) {
      const deltaTotal = current.total - previous.total;
      const deltaIdle = current.idle - previous.idle;

      if (deltaTotal > 0 && deltaIdle >= 0) {
        totalCoreTicks = deltaTotal;
        activeTicks = deltaTotal - deltaIdle;
      } else {
        totalCoreTicks = current.total;
        activeTicks = current.total - current.idle;
      }
    } else {
      totalCoreTicks = current.total;
      activeTicks = current.total - current.idle;
    }

    totalActive += Math.max(0, activeTicks);
    totalTicks += Math.max(0, totalCoreTicks);
    cores.push(clampPercent((activeTicks / totalCoreTicks) * 100));
  }

  return {
    usage_percent: clampPercent((totalActive / totalTicks) * 100),
    cores,
  };
}

function collectCpuMetrics() {
  try {
    const currentSnapshot = getCpuSnapshots();
    const loadAverage = os.loadavg();

    if (!currentSnapshot) {
      previousCpuSnapshot = null;
      return normalizeCpuMetrics({
        load_avg_1m: loadAverage[0] || 0,
        load_avg_5m: loadAverage[1] || 0,
        load_avg_15m: loadAverage[2] || 0,
      });
    }

    const usage = buildCpuUsage(currentSnapshot, previousCpuSnapshot);
    previousCpuSnapshot = currentSnapshot;

    return normalizeCpuMetrics({
      load_avg_1m: loadAverage[0] || 0,
      load_avg_5m: loadAverage[1] || 0,
      load_avg_15m: loadAverage[2] || 0,
      usage_percent: usage.usage_percent,
      cores: usage.cores,
    });
  } catch {
    previousCpuSnapshot = null;
    return getDefaultCpuMetrics();
  }
}

function collectMemoryMetrics() {
  try {
    const totalBytes = os.totalmem();
    const freeBytes = os.freemem();
    const usedBytes = totalBytes > 0 ? Math.max(0, totalBytes - freeBytes) : 0;
    const usagePercent = totalBytes > 0 ? clampPercent((usedBytes / totalBytes) * 100) : 0;
    const processMemory = process.memoryUsage();

    return normalizeMemoryMetrics({
      total_bytes: totalBytes || 0,
      free_bytes: freeBytes || 0,
      used_bytes: usedBytes,
      usage_percent: usagePercent,
      process_rss: processMemory.rss || 0,
      process_heap_used: processMemory.heapUsed || 0,
      process_heap_total: processMemory.heapTotal || 0,
    });
  } catch {
    return getDefaultMemoryMetrics();
  }
}

function getCpuUsagePercent(metrics) {
  if (!metrics || typeof metrics !== 'object') return null;
  if (metrics.cpu && typeof metrics.cpu.usage_percent === 'number') return metrics.cpu.usage_percent;
  if (typeof metrics.cpuPercent === 'number') return metrics.cpuPercent;
  return null;
}

function getMemoryUsagePercent(metrics) {
  if (!metrics || typeof metrics !== 'object') return null;
  if (metrics.memory && typeof metrics.memory.usage_percent === 'number') return metrics.memory.usage_percent;
  if (typeof metrics.ramPercent === 'number') return metrics.ramPercent;
  return null;
}

function getCpuPercent() {
  return collectCpuMetrics().usage_percent;
}

function getRamPercent() {
  return collectMemoryMetrics().usage_percent;
}

function isUnderPressure(metrics = cachedMetrics) {
  const cpuUsage = getCpuUsagePercent(metrics);
  const memoryUsage = getMemoryUsagePercent(metrics);
  return cpuUsage > PRESSURE_THRESHOLDS.high || memoryUsage > PRESSURE_THRESHOLDS.high;
}

function getPressureLevel(metrics = cachedMetrics) {
  const cpuUsage = getCpuUsagePercent(metrics);
  const memoryUsage = getMemoryUsagePercent(metrics);

  if (cpuUsage > PRESSURE_THRESHOLDS.critical || memoryUsage > PRESSURE_THRESHOLDS.critical) {
    return 'critical';
  }

  if (cpuUsage > PRESSURE_THRESHOLDS.high || memoryUsage > PRESSURE_THRESHOLDS.high) {
    return 'high';
  }

  if (cpuUsage >= PRESSURE_THRESHOLDS.moderate || memoryUsage >= PRESSURE_THRESHOLDS.moderate) {
    return 'moderate';
  }

  return 'none';
}

function resolveIntervalMs(intervalMs) {
  const parsed = Number.parseInt(intervalMs, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SAMPLE_INTERVAL_MS;
}

/**
 * Find nvidia-smi executable (Windows + Linux)
 */
async function findNvidiaSmi() {
  const candidates = process.platform === 'win32'
    ? ['nvidia-smi', 'C:\\Windows\\System32\\nvidia-smi.exe']
    : ['nvidia-smi', '/usr/bin/nvidia-smi'];

  for (const candidate of candidates) {
    try {
      await new Promise((resolve, reject) => {
        execFile(candidate, ['--version'], { timeout: 3000, windowsHide: true }, (err) => {
          if (err) reject(err); else resolve();
        });
      });
      return candidate;
    } catch { /* try next */ }
  }
  return null;
}

/**
 * Query nvidia-smi and update cached metrics
 */
async function refreshMetrics() {
  const cpuMetrics = collectCpuMetrics();
  const memoryMetrics = collectMemoryMetrics();
  const previousGpuMetrics = cachedMetrics && cachedMetrics.gpu ? cachedMetrics.gpu : null;

  if (!nvidiaSmiPath) {
    cachedMetrics = buildMetricsPayload({
      gpuMetrics: previousGpuMetrics,
      cpuMetrics,
      memoryMetrics,
    });
    return cachedMetrics;
  }

  try {
    const output = await new Promise((resolve, reject) => {
      execFile(nvidiaSmiPath, [
        '--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw',
        '--format=csv,noheader,nounits'
      ], { timeout: 5000, windowsHide: true }, (err, stdout) => {
        if (err) reject(err); else resolve(stdout.trim());
      });
    });

    const parts = output.split(',').map((value) => value.trim());
    const gpuMetrics = parts.length >= 5
      ? {
          gpuUtilizationPercent: toInteger(parts[0], 0),
          vramUsedMb: toInteger(parts[1], 0),
          vramTotalMb: toInteger(parts[2], 0),
          temperatureC: toInteger(parts[3], 0),
          powerDrawW: toFloat(parts[4], 0),
        }
      : previousGpuMetrics;

    cachedMetrics = buildMetricsPayload({
      gpuMetrics,
      cpuMetrics,
      memoryMetrics,
    });
  } catch (err) {
    cachedMetrics = buildMetricsPayload({
      gpuMetrics: previousGpuMetrics,
      cpuMetrics,
      memoryMetrics,
    });
    console.error(`[gpu-metrics] nvidia-smi error: ${err.message}`);
  }

  return cachedMetrics;
}

function getCurrentMetricsPayload() {
  if (cachedMetrics) return cachedMetrics;

  return buildMetricsPayload({
    gpuMetrics: null,
    cpuMetrics: collectCpuMetrics(),
    memoryMetrics: collectMemoryMetrics(),
  });
}

/**
 * Create the HTTP server (does not start listening)
 */
function createServer() {
  return http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.method === 'GET' && req.url === '/metrics') {
      const metrics = getCurrentMetricsPayload();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(metrics));
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', hasGpu: !!nvidiaSmiPath }));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });
}

/**
 * Start the GPU metrics server (module API)
 * @param {Object} [opts]
 * @param {number} [opts.port=9394] - Port to listen on
 * @param {number} [opts.intervalMs=5000] - Sample interval in milliseconds
 * @returns {Promise<{ success: boolean, port?: number, hasGpu: boolean }>}
 */
async function start(opts = {}) {
  const port = opts.port || DEFAULT_PORT;
  sampleIntervalMs = resolveIntervalMs(opts.intervalMs);
  previousCpuSnapshot = null;

  nvidiaSmiPath = await findNvidiaSmi();
  const hasGpu = !!nvidiaSmiPath;

  if (!hasGpu) {
    console.error('[gpu-metrics] nvidia-smi not found — serving CPU/RAM-only metrics on /metrics');
  } else {
    console.error(`[gpu-metrics] Found nvidia-smi: ${nvidiaSmiPath}`);
  }

  await refreshMetrics();
  refreshInterval = setInterval(() => {
    void refreshMetrics();
  }, sampleIntervalMs);

  server = createServer();

  return new Promise((resolve) => {
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[gpu-metrics] Port ${port} in use — GPU metrics server not started`);
        resolve({ success: false, hasGpu });
      } else {
        console.error(`[gpu-metrics] Server error: ${err.message}`);
        resolve({ success: false, hasGpu });
      }
    });

    const metricsHost = process.env.TORQUE_METRICS_HOST || '127.0.0.1';
    server.listen(port, metricsHost, () => {
      console.error(`[gpu-metrics] Serving metrics on http://${metricsHost}:${port}/metrics`);
      resolve({ success: true, port, hasGpu });
    });
  });
}

/**
 * Stop the GPU metrics server
 */
function stop() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
  if (server) {
    server.close();
    server = null;
  }

  cachedMetrics = null;
  nvidiaSmiPath = null;
  previousCpuSnapshot = null;
  sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS;
}

// Module exports
module.exports = {
  findNvidiaSmi,
  getCpuPercent,
  getRamPercent,
  refreshMetrics,
  createServer,
  isUnderPressure,
  getPressureLevel,
  start,
  stop,
};

// Standalone mode: run directly with `node gpu-metrics-server.js`
if (require.main === module) {
  const portArgIdx = process.argv.indexOf('--port');
  const intervalArgIdx = process.argv.indexOf('--interval-ms');
  const port = (portArgIdx !== -1 && process.argv[portArgIdx + 1])
    ? parseInt(process.argv[portArgIdx + 1], 10)
    : DEFAULT_PORT;
  const intervalMs = (intervalArgIdx !== -1 && process.argv[intervalArgIdx + 1])
    ? parseInt(process.argv[intervalArgIdx + 1], 10)
    : DEFAULT_SAMPLE_INTERVAL_MS;

  start({ port, intervalMs });
}
